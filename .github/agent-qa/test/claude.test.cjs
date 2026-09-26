'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scenarios = require('../scenarios.json');
const resultSchema = require('../agent-result.schema.json');
const {
  CLAUDE_DENIED_TOOLS,
  claudeAllowedTools,
  claudeArgs,
  claudeOutcome,
  readExecutionLog,
  writeClaudeInputs,
} = require('../agents/claude.cjs');
const { MCP_SERVER, browserToolNames, playwrightServer } = require('../agents/mcp.cjs');
const { mcpConfig } = require('../agents/copilot.cjs');

const ALLOWED_TOOL_NAMES = scenarios.browser.allowed_tools;
const CLAUDE_ALLOWED_TOOLS = ALLOWED_TOOL_NAMES.map((tool) => `mcp__playwright__${tool}`);
const CLAUDE_DENIED_TOOL_NAMES = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite',
];
const MODEL = 'claude-opus-4-5-20250929';

function resultFixture() {
  return {
    schema_version: 1,
    summary: 'All six browser journeys completed.',
    scenarios: [
      'search-detail-return', 'model-provenance', 'cancel-replace',
      'unprepared-model', 'recover-409', 'blank-input',
    ].map((id) => ({
      id,
      status: 'observed',
      steps: [`Exercised ${id} in the browser.`],
      expected: 'The expected fixture behavior remains usable.',
      actual: 'The expected behavior was visible.',
      evidence: [`screenshots/${id}.png`],
    })),
    findings: [],
  };
}

function initMessage(model = MODEL) {
  return { type: 'system', subtype: 'init', model };
}

function collectRefs(value, refs = []) {
  if (!value || typeof value !== 'object') return refs;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref') refs.push(child);
    else collectRefs(child, refs);
  }
  return refs;
}

function splitClaudeArgs(value) {
  const words = [];
  let word = '';
  let quote = null;
  let started = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote && character === quote) {
      quote = null;
    } else if (!quote && (character === "'" || character === '"')) {
      quote = character;
      started = true;
    } else if (!quote && /\s/u.test(character)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote || escaped) throw new Error('Unclosed argument quote or escape');
  if (started) words.push(word);
  return words;
}

async function temporary(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gods-eye-claude-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

test('parses a successful structured output and captures the initialized model', () => {
  const result = resultFixture();
  const outcome = claudeOutcome({
    messages: [initMessage(), { type: 'result', subtype: 'success', structured_output: result }],
    conclusion: 'success',
    stepOutcome: 'success',
    tokenReady: true,
  });

  assert.deepEqual(outcome, { process_error: null, model: MODEL, result });
});

test('extracts fenced JSON from a successful result string', () => {
  const result = resultFixture();
  const outcome = claudeOutcome({
    messages: [{
      type: 'result',
      subtype: 'success',
      result: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``,
    }],
    conclusion: 'success',
    stepOutcome: 'success',
    tokenReady: true,
  });

  assert.deepEqual(outcome.result, result);
  assert.equal(outcome.process_error, null);
});

test('maps Claude authentication, rate-limit, and max-turn errors', () => {
  const cases = [
    [{ type: 'result', api_error_status: 401, is_error: true }, 'AUTH_REQUIRED'],
    [{ type: 'result', api_error_status: 403, is_error: true }, 'AUTH_REQUIRED'],
    [{ type: 'result', api_error_status: 429, is_error: true }, 'RATE_LIMITED'],
    [{ type: 'result', subtype: 'error_max_turns', is_error: true }, 'MAX_TURNS'],
  ];

  for (const [message, code] of cases) {
    const outcome = claudeOutcome({
      messages: [message], conclusion: 'failure', stepOutcome: 'failure', tokenReady: true,
    });
    assert.equal(outcome.process_error.code, code);
  }

  const limited = claudeOutcome({
    messages: [{ type: 'result', api_error_status: 429, is_error: true }],
    conclusion: 'failure', stepOutcome: 'failure', tokenReady: true,
  });
  assert.match(limited.process_error.message, /rate limit/iu);
});

test('classifies text authentication errors without matching author or unrelated OAuth text', () => {
  for (const error of [
    'authentication failed', 'authorization failed', 'unauthorized', 'unauthorised',
    'invalid token', 'invalid API key', 'invalid credentials', 'oauth token expired',
    'authentication_failed', 'authorization_failed',
  ]) {
    const outcome = claudeOutcome({
      messages: [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [error] }],
      conclusion: 'failure', stepOutcome: 'failure', tokenReady: true,
    });
    assert.equal(outcome.process_error.code, 'AUTH_REQUIRED', error);
  }
  for (const error of ['author wrote a note', 'OAuth callback returned a page']) {
    const outcome = claudeOutcome({
      messages: [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [error] }],
      conclusion: 'failure', stepOutcome: 'failure', tokenReady: true,
    });
    assert.equal(outcome.process_error.code, 'AGENT_FAILED', error);
  }
});

test('classifies an underscore authentication error in a realistic error result text', () => {
  for (const code of ['authentication_failed', 'authorization_failed']) {
    const outcome = claudeOutcome({
      messages: [initMessage(), {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: null,
        result: `API Error: 401 {"type":"error","error":{"type":"${code}","message":"OAuth token rejected"}}`,
      }],
      conclusion: 'failure', stepOutcome: 'failure', tokenReady: true,
    });
    assert.equal(outcome.process_error.code, 'AUTH_REQUIRED', code);
    assert.equal(outcome.model, MODEL);
  }
});

test('classifies text rate and usage limits', () => {
  for (const error of ['rate limit reached', 'usage limit reached']) {
    const outcome = claudeOutcome({
      messages: [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [error] }],
      conclusion: 'failure', stepOutcome: 'failure', tokenReady: true,
    });
    assert.equal(outcome.process_error.code, 'RATE_LIMITED', error);
    assert.match(outcome.process_error.message, /rate limit/iu);
  }
});

test('classifies an agent error and sanitizes its returned error details', () => {
  const outcome = claudeOutcome({
    messages: [{
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['sk-ant-oat01-abcdef', 'CLAUDE_CODE_OAUTH_TOKEN=secret-value'],
    }],
    conclusion: 'failure', stepOutcome: 'failure', tokenReady: true,
  });

  assert.equal(outcome.process_error.code, 'AGENT_FAILED');
  assert.doesNotMatch(JSON.stringify(outcome.process_error), /sk-ant-oat01-abcdef|secret-value/u);
});

test('sanitizes JSON-quoted environment credentials in Claude errors', () => {
  const outcome = claudeOutcome({
    messages: [{
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['{"CLAUDE_CODE_OAUTH_TOKEN":"oauth-json-secret","ANTHROPIC_API_KEY": "anthropic-json-secret"}'],
    }],
    conclusion: 'failure', stepOutcome: 'failure', tokenReady: true,
  });

  assert.doesNotMatch(JSON.stringify(outcome.process_error), /oauth-json-secret|anthropic-json-secret/u);
});

test('distinguishes missing credentials and a cancelled empty execution log', () => {
  assert.equal(claudeOutcome({
    messages: [], conclusion: 'success', stepOutcome: 'success', tokenReady: false,
  }).process_error.code, 'AUTH_REQUIRED');
  assert.equal(claudeOutcome({
    messages: [], conclusion: 'cancelled', stepOutcome: 'cancelled', tokenReady: true, timedOut: true,
  }).process_error.code, 'CANCELLED');
  const early = claudeOutcome({
    messages: [], conclusion: 'failure', stepOutcome: 'failure', tokenReady: true,
  }).process_error;
  assert.equal(early.code, 'AGENT_SETUP_FAILED');
  assert.equal(early.message, 'The Claude action failed before producing a result');
  assert.equal(claudeOutcome({
    messages: [], conclusion: 'success', stepOutcome: 'success', tokenReady: true,
  }).process_error.code, 'AGENT_NO_OUTPUT');
});

test('classifies a cancelled or failed partial log without a result message by whether the budget ran out', () => {
  const messages = [initMessage(), { type: 'assistant', message: { content: [] } }];
  for (const stepOutcome of ['cancelled', 'failure']) {
    for (const [timedOut, code] of [[true, 'CANCELLED'], [false, 'AGENT_SETUP_FAILED']]) {
      const outcome = claudeOutcome({
        messages, conclusion: 'failure', stepOutcome, tokenReady: true, timedOut,
      });
      assert.equal(outcome.process_error.code, code, `${stepOutcome}/${timedOut}`);
      assert.equal(outcome.model, MODEL);
      assert.equal(outcome.result, null);
    }
  }
  assert.equal(claudeOutcome({
    messages, conclusion: 'success', stepOutcome: 'success', tokenReady: true, timedOut: true,
  }).process_error.code, 'AGENT_NO_OUTPUT');
});

test('reads both JSON-array and JSON-lines execution logs', async (t) => {
  const root = await temporary(t);
  const messages = [initMessage(), { type: 'result', subtype: 'success', result: 'done' }];
  const arrayPath = path.join(root, 'array.json');
  const linesPath = path.join(root, 'lines.jsonl');
  await fsp.writeFile(arrayPath, JSON.stringify(messages));
  await fsp.writeFile(linesPath, messages.map((message) => JSON.stringify(message)).join('\n'));

  assert.deepEqual(await readExecutionLog(arrayPath), messages);
  assert.deepEqual(await readExecutionLog(linesPath), messages);
});

test('preserves complete JSON-lines messages before a truncated trailing line', async (t) => {
  const root = await temporary(t);
  const file = path.join(root, 'truncated.jsonl');
  const messages = [initMessage(), { type: 'assistant', message: { content: [] } }];
  await fsp.writeFile(file, `${messages.map((message) => JSON.stringify(message)).join('\r\n')}\r\n\r\n{"type":"result","subtype":`);

  assert.deepEqual(await readExecutionLog(file), messages);
});

test('rejects an unparseable JSON-lines entry before the last nonempty line', async (t) => {
  const root = await temporary(t);
  const file = path.join(root, 'corrupt.jsonl');
  for (const trailing of [JSON.stringify({ type: 'result', subtype: 'success' }), '{also truncated']) {
    await fsp.writeFile(file, `${JSON.stringify(initMessage())}\nRAW_LOG_BODY_MUST_STAY_PRIVATE\n${trailing}\n\n`);
    await assert.rejects(readExecutionLog(file), { code: 'INVALID_EXECUTION_LOG' });
  }
});

test('writes private Claude config, exact permissions, and a self-contained result schema', async (t) => {
  const root = await temporary(t);
  const claudeDir = path.join(root, 'claude');
  const server = playwrightServer({
    mcpBin: '/toolchain/playwright-mcp',
    origin: 'http://127.0.0.1:41731',
    screenshotsRoot: '/private/screenshots',
    initPage: '/repo/.github/agent-qa/browser-init.ts',
    journal: '/private/browser-journal.jsonl',
    browsers: '/toolchain/browsers',
  });
  const files = await writeClaudeInputs({ claudeDir, server, resultSchema });

  assert.equal((await fsp.stat(claudeDir)).mode & 0o777, 0o700);
  for (const file of [files.mcpConfigPath, files.settingsPath, files.schemaPath]) {
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  }
  assert.deepEqual(JSON.parse(await fsp.readFile(files.mcpConfigPath, 'utf8')), {
    mcpServers: {
      playwright: {
        type: 'stdio',
        command: server.command,
        args: server.args,
        env: server.env,
      },
    },
  });
  assert.deepEqual(JSON.parse(await fsp.readFile(files.settingsPath, 'utf8')), {
    permissions: { allow: CLAUDE_ALLOWED_TOOLS, deny: CLAUDE_DENIED_TOOL_NAMES },
    enableAllProjectMcpServers: false,
  });
  const writtenSchema = JSON.parse(await fsp.readFile(files.schemaPath, 'utf8'));
  assert.deepEqual(writtenSchema, resultSchema);
  assert.equal(collectRefs(writtenSchema).every((ref) => ref.startsWith('#/')), true);
  assert.deepEqual(browserToolNames(), ALLOWED_TOOL_NAMES);
  assert.equal(MCP_SERVER, 'playwright');
  assert.deepEqual(claudeAllowedTools(), CLAUDE_ALLOWED_TOOLS);
  assert.deepEqual(CLAUDE_DENIED_TOOLS, CLAUDE_DENIED_TOOL_NAMES);

  const forbiddenDir = path.join(root, 'forbidden');
  await fsp.mkdir(forbiddenDir);
  await fsp.writeFile(path.join(forbiddenDir, '.mcp.json'), '{}');
  await assert.rejects(writeClaudeInputs({ claudeDir: forbiddenDir, server, resultSchema }));
});

test('creates Claude CLI arguments with an inline schema and strict browser tools', () => {
  const configPath = '/private/claude/mcp-config.json';
  const schemaPath = '/private/claude/result.schema.json';
  const text = claudeArgs({ mcpConfigPath: configPath, schemaPath, resultSchema });
  const args = splitClaudeArgs(text);
  assert.deepEqual(args.slice(0, 15), [
    '--model', 'opus', '--strict-mcp-config', '--mcp-config', configPath,
    '--tools', 'TodoWrite', '--permission-mode', 'dontAsk', '--max-turns', '200',
    '--allowedTools', CLAUDE_ALLOWED_TOOLS.join(','),
    '--disallowedTools', CLAUDE_DENIED_TOOL_NAMES.join(','),
  ]);
  assert.equal(args[15], '--json-schema');
  assert.equal(args.length, 17);
  assert.deepEqual(JSON.parse(args[16]), resultSchema);
  assert.equal(args.includes(schemaPath), false);
  assert.equal(splitClaudeArgs(claudeArgs({
    mcpConfigPath: '/private data/mcp.json', resultSchema,
  }))[4], '/private data/mcp.json');
});

test('confines Claude to the Playwright MCP tools with no surviving built-in tool', () => {
  const args = splitClaudeArgs(claudeArgs({ mcpConfigPath: '/private/claude/mcp-config.json', resultSchema }));
  const value = (flag) => {
    const index = args.indexOf(flag);
    assert.notEqual(index, -1, flag);
    assert.equal(args.indexOf(flag, index + 1), -1, `${flag} appears once`);
    return args[index + 1];
  };
  // --tools narrows the built-in set to TodoWrite, and the deny list then removes TodoWrite too.
  assert.equal(value('--tools'), 'TodoWrite');
  assert.ok(value('--disallowedTools').split(',').includes('TodoWrite'));
  assert.equal(value('--permission-mode'), 'dontAsk');
  assert.equal(value('--max-turns'), '200');
  const allowed = value('--allowedTools').split(',');
  assert.equal(allowed.length, 14);
  assert.ok(allowed.every((tool) => tool.startsWith('mcp__playwright__')));
  assert.equal(args.includes(''), false);
});

test('rejects a schema containing a single quote before building Claude CLI arguments', () => {
  const unsafeSchema = { ...resultSchema, title: "owner's schema" };
  assert.throws(() => claudeArgs({
    mcpConfigPath: '/private/claude/mcp-config.json', resultSchema: unsafeSchema,
  }), { code: 'SCHEMA_QUOTE_UNSAFE' });
});

test('shares the existing Playwright MCP command while preserving Copilot config shape', () => {
  const parameters = {
    mcpBin: '/toolchain/playwright-mcp',
    origin: 'http://127.0.0.1:41731',
    screenshotsRoot: '/private/screenshots',
    initPage: '/repo/.github/agent-qa/browser-init.ts',
    journal: '/private/browser-journal.jsonl',
  };
  const oldCopilotShape = {
    mcpServers: {
      playwright: {
        type: 'local',
        command: parameters.mcpBin,
        args: [
          '--browser', 'chromium', '--headless', '--isolated', '--block-service-workers',
          '--codegen', 'none', '--viewport-size', '1440x1000',
          '--allowed-origins', parameters.origin,
          '--output-dir', parameters.screenshotsRoot,
          '--init-page', parameters.initPage,
        ],
        env: { QA_BROWSER_JOURNAL: parameters.journal },
        tools: [...ALLOWED_TOOL_NAMES],
      },
    },
  };
  const shared = playwrightServer({ ...parameters, browsers: '/toolchain/browsers' });

  assert.equal(shared.command, parameters.mcpBin);
  assert.deepEqual(shared.args, oldCopilotShape.mcpServers.playwright.args);
  assert.deepEqual(shared.env, {
    QA_BROWSER_JOURNAL: parameters.journal,
    PLAYWRIGHT_BROWSERS_PATH: '/toolchain/browsers',
  });
  assert.deepEqual(mcpConfig(parameters), oldCopilotShape);
});
