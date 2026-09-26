'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { MCP_SERVER, browserToolNames, extractAgentResult } = require('./mcp.cjs');
const { sanitizeText } = require('../redact.cjs');

const MAX_EXECUTION_LOG_BYTES = 50 * 1024 * 1024;
const CLAUDE_DENIED_TOOLS = Object.freeze([
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite',
]);
const VERSION_PATTERN = new RegExp(require('../report.schema.json').$defs.version.pattern, 'u');
const AGENT_RESULT_SCHEMA = require('../agent-result.schema.json');

class ClaudeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClaudeError';
    this.code = code;
  }
}

function claudeAllowedTools() {
  return browserToolNames().map(tool => `mcp__${MCP_SERVER}__${tool}`);
}

function quotePath(value) {
  const pathValue = String(value);
  return /\s/u.test(pathValue) ? `"${pathValue.replace(/["\\]/gu, '\\$&')}"` : pathValue;
}

function claudeArgs({ mcpConfigPath, resultSchema }) {
  const schemaJson = JSON.stringify(standaloneResultSchema(resultSchema));
  if (schemaJson.includes("'")) {
    throw new ClaudeError('SCHEMA_QUOTE_UNSAFE', 'Claude result schema contains a single quote');
  }
  return [
    '--model', 'opus',
    '--strict-mcp-config', '--mcp-config', quotePath(mcpConfigPath),
    // --allowedTools only pre-approves and --disallowedTools only removes the names it lists, so the
    // CLI would still expose its other built-ins. --tools narrows the built-in set to TodoWrite, which
    // the deny list then removes, leaving only the Playwright MCP tools. An empty --tools value is not
    // used because the action's argument parser turns it into a valueless flag.
    '--tools', 'TodoWrite',
    '--permission-mode', 'dontAsk',
    '--max-turns', '200',
    '--allowedTools', claudeAllowedTools().join(','),
    '--disallowedTools', CLAUDE_DENIED_TOOLS.join(','),
    '--json-schema', `'${schemaJson}'`,
  ].join(' ');
}

function standaloneResultSchema(resultSchema) {
  const schema = JSON.parse(JSON.stringify(resultSchema ?? AGENT_RESULT_SCHEMA));
  schema.$defs = { ...AGENT_RESULT_SCHEMA.$defs, ...(schema.$defs ?? {}) };

  function localize(value) {
    if (Array.isArray(value)) {
      for (const entry of value) localize(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      if (value.$ref.startsWith('agent-result.schema.json#')) {
        value.$ref = value.$ref.slice('agent-result.schema.json'.length);
      }
      if (!value.$ref.startsWith('#/')) {
        throw new ClaudeError('EXTERNAL_SCHEMA_REF', 'Claude result schema contains an external reference');
      }
    }
    for (const child of Object.values(value)) localize(child);
  }

  localize(schema);
  return schema;
}

async function writePrivateJson(file, value) {
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(file, 0o600);
}

async function writeClaudeInputs({ claudeDir, server, resultSchema }) {
  await fsp.mkdir(claudeDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(claudeDir, 0o700);
  try {
    await fsp.lstat(path.join(claudeDir, '.mcp.json'));
    throw new ClaudeError('UNTRUSTED_MCP_CONFIG', 'Claude directory already contains .mcp.json');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const mcpConfigPath = path.join(claudeDir, 'mcp-config.json');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const schemaPath = path.join(claudeDir, 'result.schema.json');
  const mcpServer = {
    type: 'stdio',
    command: server.command,
    args: [...server.args],
    env: { ...server.env },
  };
  await writePrivateJson(mcpConfigPath, { mcpServers: { [MCP_SERVER]: mcpServer } });
  await writePrivateJson(settingsPath, {
    permissions: { allow: claudeAllowedTools(), deny: [...CLAUDE_DENIED_TOOLS] },
    enableAllProjectMcpServers: false,
  });
  await writePrivateJson(schemaPath, standaloneResultSchema(resultSchema));
  return { mcpConfigPath, settingsPath, schemaPath };
}

async function readExecutionLog(file) {
  const handle = await fsp.open(file, 'r');
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  try {
    while (true) {
      const length = Math.min(buffer.length, MAX_EXECUTION_LOG_BYTES - total + 1);
      const { bytesRead } = await handle.read(buffer, 0, length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_EXECUTION_LOG_BYTES) {
        throw new ClaudeError('EXECUTION_LOG_TOO_LARGE', 'Claude execution log exceeds 50 MiB');
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    await handle.close();
  }

  const text = Buffer.concat(chunks, total).toString('utf8').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Expected an array');
    return parsed;
  } catch {
    const messages = [];
    const lines = text.split(/\r?\n/u).filter((line) => line.trim());
    for (let index = 0; index < lines.length; index += 1) {
      try {
        messages.push(JSON.parse(lines[index]));
      } catch {
        // An interrupted action may leave only its last JSONL record unfinished.
        if (index === lines.length - 1) break;
        throw new ClaudeError('INVALID_EXECUTION_LOG', 'Claude execution log is malformed');
      }
    }
    return messages;
  }
}

function errorText(message) {
  const values = [];
  if (Array.isArray(message.errors)) values.push(...message.errors);
  if (message.error != null) values.push(message.error);
  if (typeof message.message === 'string') values.push(message.message);
  if (message.is_error === true && typeof message.result === 'string') values.push(message.result);
  return values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
}

function processError(code, message, details = null) {
  return {
    code,
    message: sanitizeText(message),
    details: details ? sanitizeText(details) : null,
  };
}

function claudeOutcome({ messages, conclusion, stepOutcome, tokenReady, timedOut = false }) {
  const entries = Array.isArray(messages) ? messages : [];
  const init = entries.find(message => message?.type === 'system' && message.subtype === 'init');
  const model = typeof init?.model === 'string' && VERSION_PATTERN.test(init.model) ? init.model : null;
  if (tokenReady === false) {
    return {
      process_error: processError('AUTH_REQUIRED', 'Claude Code authentication token is unavailable'),
      model,
      result: null,
    };
  }
  const resultMessage = [...entries].reverse().find(message => message?.type === 'result');
  if (!resultMessage) {
    // A failed or cancelled step without a result is a timeout only when the step used up its budget;
    // otherwise the action itself failed before Claude could produce anything.
    const interrupted = ['cancelled', 'failure'].includes(stepOutcome);
    if (interrupted && timedOut) {
      return {
        process_error: processError('CANCELLED', 'Claude Code execution was cancelled or timed out'),
        model,
        result: null,
      };
    }
    return {
      process_error: interrupted
        ? processError('AGENT_SETUP_FAILED', 'The Claude action failed before producing a result')
        : processError('AGENT_NO_OUTPUT', entries.length === 0
          ? 'Claude Code returned no execution messages'
          : 'Claude Code returned no result message'),
      model,
      result: null,
    };
  }

  const details = sanitizeText(errorText(resultMessage), '');
  const subtype = typeof resultMessage.subtype === 'string' ? resultMessage.subtype : '';
  const apiStatus = Number(resultMessage.api_error_status);
  const authError = /\bauth(?:entication|orization)?\b|\bauth(?:entication|orization)_failed\b|unauthori[sz]ed|invalid (?:token|api key|credentials)|oauth token (?:expired|revoked|invalid)/iu.test(details);
  if ([401, 403].includes(apiStatus) || authError) {
    return {
      process_error: processError('AUTH_REQUIRED', `Claude Code authentication failed${apiStatus ? ` (HTTP ${apiStatus})` : ''}`, details),
      model,
      result: null,
    };
  }
  if (apiStatus === 429 || /rate.?limit|usage.{0,30}limit|too many requests/iu.test(details)) {
    return {
      process_error: processError('RATE_LIMITED', 'Claude API rate limit was reached', details),
      model,
      result: null,
    };
  }
  if (subtype === 'error_max_turns') {
    return {
      process_error: processError('MAX_TURNS', 'Claude Code reached its maximum number of turns', details),
      model,
      result: null,
    };
  }
  if (resultMessage.is_error === true || subtype.startsWith('error')) {
    return {
      process_error: processError('AGENT_FAILED', `Claude Code failed: ${details || conclusion || 'execution error'}`, details),
      model,
      result: null,
    };
  }

  const structured = resultMessage.structured_output;
  const result = structured && typeof structured === 'object' && !Array.isArray(structured)
    ? structured
    : extractAgentResult(resultMessage.result);
  return { process_error: null, model, result };
}

module.exports = Object.freeze({
  CLAUDE_DENIED_TOOLS,
  ClaudeError,
  claudeAllowedTools,
  claudeArgs,
  claudeOutcome,
  readExecutionLog,
  writeClaudeInputs,
});
