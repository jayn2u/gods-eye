'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const scenarioContract = require('../scenarios.json');

const MAX_RESULT_BYTES = 256 * 1024;
const ALLOWED_TOOLS = Object.freeze([...scenarioContract.browser.allowed_tools]);
const MCP_SERVER = 'playwright';
// Copilot CLI resolves tool permissions as `server(tool)` and has no strict-config flag, so every
// other capability is denied by name and the config file is written into a run-scoped HOME.
const DENIED_TOOLS = Object.freeze(['shell', 'write', 'str_replace_editor', 'view', 'fetch']);

class CopilotError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CopilotError';
    this.code = code;
    this.details = details;
  }
}

function mcpConfig({ mcpBin, origin, screenshotsRoot, initPage, journal }) {
  return {
    mcpServers: {
      [MCP_SERVER]: {
        type: 'local',
        command: mcpBin,
        args: [
          '--browser', 'chromium', '--headless', '--isolated', '--block-service-workers',
          '--codegen', 'none', '--viewport-size', '1440x1000',
          '--allowed-origins', origin,
          '--output-dir', screenshotsRoot,
          '--init-page', initPage,
        ],
        env: { QA_BROWSER_JOURNAL: journal },
        tools: ALLOWED_TOOLS.join(','),
      },
    },
  };
}

/**
 * Copilot CLI reads MCP configuration from `$HOME/.copilot/mcp-config.json` and lets a project
 * `.mcp.json` or `.github/mcp.json` override it, with no flag to forbid that. The run therefore gets
 * its own HOME and an empty working directory that is not inside the candidate checkout, so no
 * candidate-supplied configuration is discoverable.
 */
async function prepareCopilotHome({ home, workDir, mcpBin, origin, screenshotsRoot, initPage, journal }) {
  const configDir = path.join(home, '.copilot');
  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(workDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(configDir, 'mcp-config.json');
  await fsp.writeFile(journal, '', { mode: 0o600 });
  const config = mcpConfig({ mcpBin, origin, screenshotsRoot, initPage, journal });
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  for (const forbidden of ['.mcp.json', path.join('.github', 'mcp.json')]) {
    const stray = path.join(workDir, forbidden);
    if (await fsp.stat(stray).then(() => true, () => false)) {
      throw new CopilotError('UNTRUSTED_MCP_CONFIG', `Working directory carries ${forbidden}`);
    }
  }
  return { configPath, configDir };
}

function copilotArguments({ copilotBin, prompt, model }) {
  const args = ['-p', prompt, '-s', '--no-ask-user'];
  for (const tool of ALLOWED_TOOLS) args.push(`--allow-tool=${MCP_SERVER}(${tool})`);
  for (const tool of DENIED_TOOLS) args.push(`--deny-tool=${tool}`);
  if (model) args.push(`--model=${model}`);
  return { command: copilotBin, args };
}

function stripFence(text) {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/u.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Copilot CLI prints the final document to stdout; there is no output-schema flag. Trusted code
 * extracts it here and the unchanged Ajv validator gates it. No agent write tool is granted, so the
 * agent never touches the file the validator reads.
 */
function extractAgentResult(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0 || stdout.length > MAX_RESULT_BYTES) return null;
  const candidate = stripFence(stdout);
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(candidate.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function runCopilot({ runtime, paths, prompt, environment, sanitizedChildEnvironment }) {
  const prepared = await prepareCopilotHome({
    home: paths.agentHome,
    workDir: paths.workDir,
    mcpBin: paths.mcpBin,
    origin: paths.origin,
    screenshotsRoot: paths.screenshotsRoot,
    initPage: paths.initPage,
    journal: paths.journal,
  });
  const invocation = copilotArguments({
    copilotBin: paths.copilotBin,
    prompt,
    model: paths.model,
  });
  let processError;
  try {
    await runtime.supervisor.runToDeadline(
      'copilot', environment.flockBin,
      [environment.lockFile, invocation.command, ...invocation.args],
      {
        cwd: paths.workDir,
        env: sanitizedChildEnvironment(runtime.supervisor.runRoot, {
          HOME: paths.agentHome,
          XDG_CONFIG_HOME: path.join(paths.agentHome, '.config'),
          COPILOT_GITHUB_TOKEN: environment.copilotToken,
          PLAYWRIGHT_BROWSERS_PATH: paths.browsers,
          QA_BROWSER_JOURNAL: paths.journal,
        }),
      },
    );
  } catch (error) {
    processError = error;
  }
  const stdoutPath = path.join(runtime.supervisor.runRoot, 'logs', 'copilot.stdout.log');
  const stderrPath = path.join(runtime.supervisor.runRoot, 'logs', 'copilot.stderr.log');
  let agentResult = null;
  try {
    agentResult = extractAgentResult(await fsp.readFile(stdoutPath, 'utf8'));
  } catch { /* an unreadable transcript is an invalid result, not a product finding */ }
  if (agentResult) {
    await fsp.writeFile(paths.privateResult, `${JSON.stringify(agentResult)}\n`, { mode: 0o600 });
  }
  return {
    processError,
    journalPath: paths.journal,
    stdoutPath,
    stderrPath,
    configPath: prepared.configPath,
    privateResult: paths.privateResult,
  };
}

module.exports = Object.freeze({
  ALLOWED_TOOLS,
  CopilotError,
  DENIED_TOOLS,
  MCP_SERVER,
  copilotArguments,
  extractAgentResult,
  mcpConfig,
  prepareCopilotHome,
  runCopilot,
  stripFence,
});
