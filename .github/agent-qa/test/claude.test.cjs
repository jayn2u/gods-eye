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

test('distinguishes missing credentials and a cancelled empty execution log', () => {
  assert.equal(claudeOutcome({
    messages: [], conclusion: 'success', stepOutcome: 'success', tokenReady: false,
  }).process_error.code, 'AUTH_REQUIRED');
  assert.equal(claudeOutcome({
    messages: [], conclusion: 'cancelled', stepOutcome: 'cancelled', tokenReady: true,
  }).process_error.code, 'CANCELLED');
  assert.equal(claudeOutcome({
    messages: [], conclusion: 'success', stepOutcome: 'success', tokenReady: true,
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

test('creates Claude CLI arguments with strict tools and quotes paths containing spaces', () => {
  const configPath = '/private/claude/mcp-config.json';
  const schemaPath = '/private/claude/result.schema.json';
  const expected = [
    '--model', 'opus', '--strict-mcp-config', '--mcp-config', configPath,
    '--allowedTools', CLAUDE_ALLOWED_TOOLS.join(','),
    '--disallowedTools', CLAUDE_DENIED_TOOL_NAMES.join(','),
    '--json-schema', schemaPath,
  ].join(' ');
  assert.equal(claudeArgs({ mcpConfigPath: configPath, schemaPath }), expected);
  assert.match(claudeArgs({ mcpConfigPath: '/private data/mcp.json', schemaPath }), /--mcp-config "\/private data\/mcp\.json"/u);
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
