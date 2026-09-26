'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ALLOWED_TOOLS,
  INTERNAL_DEADLINE_MS,
  agentTimeoutMinutes,
  deadlineFromJobStart,
  markAgentStart,
  prepareExecution,
  parseCli,
  recordAgentOutcome,
  runAgentStep,
  finalizeExecution,
  runExecution,
  snapshotTrackedFiles,
} = require('../execute.cjs');
const { parseBrowserJournal } = require('../journal.cjs');
const { faithfulJournalEntries } = require('./fixtures/journal-builder.cjs');
const { SCENARIO_IDS, validateEvidenceManifest, validateReport } = require('../contracts.cjs');
const { ProcessSupervisor, identityMatches, monotonicDeadlineAfter } = require('../runtime.cjs');

const qaRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'execution');
const origin = 'http://127.0.0.1:41731';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const durableEvidence = path.resolve(process.env.QA_EXECUTE_EVIDENCE ?? path.join(process.cwd(), '.omo/evidence/release-pr-agent-qa/task-6'));
const sha = '1'.repeat(40);
const baseSha = '2'.repeat(40);
const request = {
  schema_version: 1,
  agent: 'copilot',
  repository: 'jayn2u/gods-eye',
  pr_number: 41,
  head: { repository: 'jayn2u/gods-eye', id: 12345, sha },
  base: { ref: 'release/qa', sha: baseSha },
  controller_sha: '3'.repeat(40),
  run: { id: 98765, attempt: 1 },
  author: 'trusted-author',
  admitted_at: '2026-09-07T09:00:00Z',
};

async function temporary(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gods-eye-execute-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate');
  const evidence = path.join(root, 'evidence');
  await fsp.mkdir(candidate);
  const requestPath = path.join(root, 'request.json');
  await fsp.writeFile(requestPath, JSON.stringify(request));
  return { root, candidate, evidence, requestPath };
}

function doctor(ok = true, failed = []) {
  const checks = [
    {
      name: 'tool_versions', ok: true, node: process.versions.node,
      copilot: '1.0.83', claude: '2.1.283', playwright_mcp: '0.0.80',
    },
    { name: 'subscription_auth', ok: !failed.includes('subscription_auth') },
    { name: 'browser', ok: !failed.includes('browser') },
    { name: 'auth_lock', ok: !failed.includes('auth_lock') },
  ];
  return { schema_version: 1, ok, phase: 'status', checks };
}

async function screenshots(root, missing) {
  await fsp.mkdir(root, { recursive: true });
  for (const id of ['search-detail-return', 'model-provenance', 'cancel-replace', 'unprepared-model', 'recover-409', 'blank-input']) {
    if (id !== missing) await fsp.writeFile(path.join(root, `${id}.png`), png);
  }
}

function fixtureAdapters(overrides = {}) {
  let snapshots = 0;
  let cleanChecks = 0;
  let stopped = false;
  const order = [];
  return {
    order,
    runtimeStopped: () => stopped,
    adapters: {
      env: overrides.env ?? { QA_COPILOT_TOKEN: 'a'.repeat(40) },
      candidateHead: () => sha,
      candidateTrackedClean: () => {
        cleanChecks += 1;
        return !(overrides.dirtyAfter && cleanChecks > 1);
      },
      snapshotTrackedFiles: () => {
        snapshots += 1;
        return overrides.sourceChanged && snapshots > 1 ? { source: 'changed' } : { source: 'original' };
      },
      boundedDiffContext: () => ({ text: 'diff --git a/web/a b/web/a', truncated: false }),
      chromiumVersion: () => 'Chromium 140.0.0',
      runDoctor: async () => {
        order.push('doctor');
        return overrides.doctor ?? doctor(overrides.doctorOk ?? true, overrides.failedCheck ? [overrides.failedCheck] : []);
      },
      startRuntime: async ({ evidence }) => {
        order.push('runtime');
        if (overrides.startError) throw overrides.startError;
        const runRoot = path.join(evidence, 'runtime-fixture');
        return {
          origin,
          supervisor: {
            runRoot,
            runToDeadline: async () => ({ code: 0, signal: null }),
            handOff: async () => ({ manifestPath: path.join(runRoot, 'processes.json'), runRoot }),
          },
          stop: async () => {
            order.push('cleanup');
            stopped = true;
            return { allProcessesStopped: true, processes: [{ outcome: 'stopped' }] };
          },
        };
      },
      stopHandedOffRuntime: async () => {
        order.push('cleanup');
        stopped = true;
        return { allProcessesStopped: true, processes: [{ outcome: 'stopped' }] };
      },
      runBaseline: async () => {
        order.push('baseline');
        if (overrides.baselineError) throw overrides.baselineError;
        return {
          name: 'candidate-playwright',
          status: overrides.baselineFailed ? 'failed' : 'passed',
          harness_started: true,
          app_started: true,
          duration_ms: 12,
          ...(overrides.baselineFailed ? { details: 'One browser assertion failed.' } : {}),
        };
      },
      runAgent: async ({ paths, environment, prompt }) => {
        order.push('agent');
        for (const scenario of require('../scenarios.json').scenarios) {
          assert.equal(prompt.includes(`window.__GODS_EYE_QA__.receipt(${JSON.stringify(scenario.id)})`), true);
          assert.equal(prompt.includes(
            `filename ${JSON.stringify(path.join(paths.screenshotsRoot, `${scenario.id}.png`))}`,
          ), true);
          assert.equal(prompt.includes(`report screenshots/${scenario.id}.png`), true);
          // The receipt condition itself must never be handed to the agent.
          assert.equal(prompt.includes(scenario.receipt), false);
        }
        // The agent is invoked directly: no lock wrapper stands between the supervisor and it.
        assert.equal(Object.hasOwn(environment, 'lockFile'), false);
        assert.equal(Object.hasOwn(environment, 'flockBin'), false);
        const journalPath = paths.journal;
        const stdoutPath = path.join(path.dirname(paths.privateResult), 'copilot.stdout.log');
        const stderrPath = path.join(path.dirname(paths.privateResult), 'copilot.stderr.log');
        await fsp.writeFile(stderrPath, overrides.stderr ?? '');
        if (!overrides.noScreenshots) {
          await screenshots(paths.screenshotsRoot, overrides.missingScreenshot);
          await fsp.writeFile(path.join(paths.screenshotsRoot, 'untrusted-extra.txt'), 'must be pruned');
        }
        const entries = overrides.journal
          ? overrides.journal(faithfulJournalEntries(paths.origin))
          : faithfulJournalEntries(paths.origin);
        await fsp.writeFile(journalPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
        if (!overrides.noResult) {
          if (overrides.invalidResult) await fsp.writeFile(paths.privateResult, '{bad-json');
          else {
            const result = JSON.parse(await fsp.readFile(path.join(fixtureRoot, 'agent-result.json'), 'utf8'));
            if (overrides.canary) {
              result.scenarios[0].actual = 'OPENAI_API_KEY=sk_test_canary_123456 sk-ant-oat01-abcdef… '
                + 'CLAUDE_CODE_OAUTH_TOKEN=x TOKEN_CANARY_ALPHA';
            }
            if (overrides.jsonCanary) {
              result.scenarios[0].actual = JSON.stringify({
                CLAUDE_CODE_OAUTH_TOKEN: 'oauth-json-secret',
                ANTHROPIC_API_KEY: 'anthropic-json-secret',
                OPENAI_API_KEY: 'openai-json-secret',
                GITHUB_TOKEN: 'github-json-secret',
              });
            }
            await fsp.writeFile(paths.privateResult, JSON.stringify(result));
          }
        }
        await fsp.writeFile(stdoutPath, overrides.noResult ? 'no document here' : 'reported');
        return {
          journalPath, stdoutPath, stderrPath, privateResult: paths.privateResult,
          processError: overrides.processError,
        };
      },
    },
  };
}

async function fixtureBundle(t, overrides = {}) {
  const paths = await temporary(t);
  const bundle = fixtureAdapters(overrides);
  return {
    ...paths,
    ...bundle,
    options: {
      request: paths.requestPath,
      candidate: paths.candidate,
      evidence: paths.evidence,
      jobStart: new Date().toISOString(),
    },
  };
}

async function claudeBundle(t, overrides = {}) {
  const bundle = await fixtureBundle(t, overrides);
  bundle.claudeRequest = { ...request, agent: 'claude' };
  await fsp.writeFile(bundle.requestPath, JSON.stringify(bundle.claudeRequest));
  return bundle;
}

function successfulClaudeMessages(result, durationMs = 2345) {
  return [
    { type: 'system', subtype: 'init', model: 'claude-opus-4-5-20250929' },
    { type: 'result', subtype: 'success', duration_ms: durationMs, structured_output: result },
  ];
}

// Writes the agent-start marker as if the Claude step had started `elapsedMs` before `now`.
async function markStartedAgo(statePath, elapsedMs, now = Date.now()) {
  await markAgentStart({ statePath, now: now - elapsedMs });
}

async function recordClaudeOutcome(bundle, statePath, {
  messages = [], executionFile = '', conclusion = '', stepOutcome = '', tokenMissing = false,
} = {}) {
  const executionPath = executionFile || path.join(bundle.root, 'action-execution.json');
  if (messages.length > 0) {
    await fsp.writeFile(executionPath, `${JSON.stringify(messages)}\n`);
  }
  const outcome = await recordAgentOutcome({
    statePath,
    executionFile: messages.length > 0 || executionFile ? executionPath : '',
    conclusion,
    stepOutcome,
    tokenMissing,
  });
  return { outcome, executionPath };
}

async function executeCase(t, overrides = {}) {
  const bundle = await fixtureBundle(t, overrides);
  const result = await runExecution(bundle.options, bundle.adapters);
  return { ...bundle, ...result };
}

test('CLI parsing and the single wall-to-monotonic deadline preserve the task contract', () => {
  const parsed = parseCli([
    'prepare', '--request', '/tmp/request.json', '--candidate', '/tmp/candidate',
    '--evidence', '/tmp/evidence', '--job-start', '2026-09-07T09:00:00Z',
  ]);
  assert.equal(parsed.command, 'prepare');
  assert.equal(parsed.jobStart, '2026-09-07T09:00:00Z');
  assert.equal(parseCli(['agent', '--state', '/x/state.json']).command, 'agent');
  assert.equal(parseCli(['finalize', '--state', '/x/state.json', '--cancelled']).cancelled, true);
  assert.throws(() => parseCli(['agent', '--state', 'state.json']), { code: 'INVALID_PATH' });
  assert.throws(() => parseCli(['run', '--request', '/a']), { code: 'USAGE' });
  const recordAgent = parseCli([
    'record-agent', '--state', '/tmp/state.json', '--execution-file', '',
    '--conclusion', '', '--step-outcome', '', '--token-missing',
  ]);
  assert.deepEqual(recordAgent, {
    command: 'record-agent', statePath: '/tmp/state.json', executionFile: '',
    conclusion: '', stepOutcome: '', tokenMissing: true,
  });
  assert.throws(() => parseCli([
    'record-agent', '--state', '/tmp/state.json', '--execution-file', 'execution.json',
    '--conclusion', 'success', '--step-outcome', 'success',
  ]), { code: 'INVALID_PATH' });
  assert.deepEqual(parseCli(['mark-agent-start', '--state', '/x/state.json']), {
    command: 'mark-agent-start', statePath: '/x/state.json', cancelled: false,
  });
  assert.throws(() => parseCli(['mark-agent-start', '--state', 'state.json']), { code: 'INVALID_PATH' });
  assert.throws(() => parseCli(['mark-agent-start']), { code: 'USAGE' });
  const deadline = deadlineFromJobStart('2026-09-07T09:00:00Z', {
    wallNow: Date.parse('2026-09-07T09:02:00Z'),
    monotonicNow: 25_000,
  });
  assert.equal(deadline, 25_000 + INTERNAL_DEADLINE_MS - 120_000);
});

test('the Claude step budget is the whole minutes left before the internal deadline, from 1 to 25', () => {
  const now = Date.parse('2026-09-07T09:00:00Z');
  const minute = 60 * 1000;
  assert.equal(agentTimeoutMinutes(now + INTERNAL_DEADLINE_MS, now), 25);
  assert.equal(agentTimeoutMinutes(now + 40 * minute, now), 25);
  assert.equal(agentTimeoutMinutes(now + 18 * minute + 59_999, now), 18);
  assert.equal(agentTimeoutMinutes(now + 18 * minute, now), 18);
  assert.equal(agentTimeoutMinutes(now + 59_999, now), 1);
  assert.equal(agentTimeoutMinutes(now, now), 1);
  assert.equal(agentTimeoutMinutes(now - 5 * minute, now), 1);
});

test('mark-agent-start records the agent start time privately inside the private root', async (t) => {
  const b = await claudeBundle(t);
  const { statePath, state } = await prepareExecution(b.options, b.adapters);
  const marker = await markAgentStart({ statePath, now: 1_790_000_000_000 });
  assert.equal(marker, path.join(state.private_root, 'agent-start.json'));
  assert.deepEqual(JSON.parse(await fsp.readFile(marker, 'utf8')), { started_epoch_ms: 1_790_000_000_000 });
  assert.equal(fs.statSync(marker).mode & 0o777, 0o600);

  const before = Date.now();
  const cli = childProcess.spawnSync(process.execPath, [
    path.join(qaRoot, 'execute.cjs'), 'mark-agent-start', '--state', statePath,
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), { agent_start: marker });
  const started = JSON.parse(await fsp.readFile(marker, 'utf8')).started_epoch_ms;
  assert.ok(Number.isInteger(started) && started >= before && started <= Date.now());
  assert.equal(fs.statSync(marker).mode & 0o777, 0o600);

  const rejected = childProcess.spawnSync(process.execPath, [
    path.join(qaRoot, 'execute.cjs'), 'mark-agent-start', '--state', path.join(b.root, 'state.json'),
  ], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
});

test('record-agent separates an early Claude action failure from a step that used up its budget', async (t) => {
  const minute = 60 * 1000;
  const cases = [
    ['failure without a start marker', null, 'failure', 'setup_failed'],
    ['cancelled without a start marker', null, 'cancelled', 'setup_failed'],
    ['failure shortly after start', 2 * minute, 'failure', 'setup_failed'],
    ['failure just short of the budget', 24 * minute - 31_000, 'failure', 'setup_failed'],
    ['failure at the budget less the grace', 24 * minute - 30_000, 'failure', 'timeout'],
    ['cancelled after the budget', 25 * minute, 'cancelled', 'timeout'],
  ];
  for (const [label, elapsed, stepOutcome, reason] of cases) {
    const b = await claudeBundle(t);
    const { statePath, state } = await prepareExecution(b.options, b.adapters);
    assert.equal(state.agent_timeout_minutes, 24, label);
    const now = Date.now();
    if (elapsed !== null) await markStartedAgo(statePath, elapsed, now);
    const outcome = await recordAgentOutcome({ statePath, executionFile: '', conclusion: '', stepOutcome, now });
    assert.equal(outcome.process_error.code, reason === 'timeout' ? 'CANCELLED' : 'AGENT_SETUP_FAILED', label);
    if (reason === 'setup_failed') {
      assert.equal(outcome.process_error.message, 'The Claude action failed before producing a result', label);
    }
    const { report } = await finalizeExecution({ statePath }, b.adapters);
    assert.equal(report.status, 'incomplete', label);
    assert.equal(report.reason, reason, label);
  }
});

test('a partial Claude log from an early failure reports setup_failed with its model preserved', async (t) => {
  const b = await claudeBundle(t, { env: { QA_AGENT_MODEL: 'opus' } });
  const { statePath } = await prepareExecution(b.options, b.adapters);
  await markStartedAgo(statePath, 5_000);
  const executionFile = path.join(b.root, 'partial.jsonl');
  await fsp.writeFile(executionFile, [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-5-20250929' }),
    JSON.stringify({ type: 'assistant', message: { content: [] } }),
  ].join('\n'));

  const outcome = await recordAgentOutcome({ statePath, executionFile, conclusion: 'failure', stepOutcome: 'failure' });
  assert.equal(outcome.process_error.code, 'AGENT_SETUP_FAILED');
  assert.equal(outcome.model, 'claude-opus-4-5-20250929');
  const { report } = await finalizeExecution({ statePath }, b.adapters);
  assert.equal(report.reason, 'setup_failed');
  assert.equal(report.tools.agent.model, 'claude-opus-4-5-20250929');
});

test('prepare writes Claude inputs and returns the Claude action outputs', async (t) => {
  const b = await claudeBundle(t);
  let doctorAgent;
  const adapters = {
    ...b.adapters,
    runDoctor: async (input) => {
      doctorAgent = input.agent;
      return doctor();
    },
  };
  const prepared = await prepareExecution(b.options, adapters);
  const claude = prepared.state.agent_paths.claude;
  const { claudeArgs, claudeAllowedTools } = require('../agents/claude.cjs');

  assert.equal(doctorAgent, 'claude');
  assert.deepEqual(prepared.state.tools.agent, { name: 'claude', version: '2.1.283' });
  assert.deepEqual(Object.keys(claude).sort(), ['mcp_config', 'schema', 'settings']);
  for (const file of Object.values(claude)) assert.equal(fs.statSync(file).isFile(), true);
  assert.equal(fs.statSync(path.dirname(claude.mcp_config)).mode & 0o777, 0o700);
  for (const file of Object.values(claude)) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(prepared.state.agent_paths.agent_home).mode & 0o777, 0o700);
  assert.equal(prepared.output.state, prepared.statePath);
  assert.equal(prepared.output.ready, true);
  assert.deepEqual(Object.keys(prepared.output).sort(), [
    'agent_home', 'agent_timeout_minutes', 'claude_args', 'prompt', 'ready', 'settings', 'state', 'work_dir',
  ]);
  // The job started just now, so the whole 25-minute budget minus prepare's own time remains.
  assert.equal(prepared.output.agent_timeout_minutes, 24);
  assert.equal(prepared.state.agent_timeout_minutes, 24);
  assert.equal(prepared.output.prompt, prepared.state.prompt_path);
  assert.equal(prepared.output.agent_home, prepared.state.agent_paths.agent_home);
  assert.equal(prepared.output.work_dir, prepared.state.agent_paths.work_dir);
  assert.equal(prepared.output.settings, claude.settings);
  assert.match(prepared.output.claude_args, /--model opus --strict-mcp-config/u);
  for (const tool of claudeAllowedTools()) assert.ok(prepared.output.claude_args.includes(tool), tool);
  assert.equal(prepared.output.claude_args, claudeArgs({
    mcpConfigPath: claude.mcp_config,
    resultSchema: require('../agent-result.schema.json'),
  }));
});

test('record-agent turns a successful Claude execution and faithful journal into a no-findings report', async (t) => {
  const b = await claudeBundle(t);
  const { statePath, state } = await prepareExecution(b.options, b.adapters);
  await screenshots(state.screenshots_root);
  await fsp.writeFile(
    state.agent_paths.journal,
    `${faithfulJournalEntries(state.runtime.origin).map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
  const result = JSON.parse(await fsp.readFile(path.join(fixtureRoot, 'agent-result.json'), 'utf8'));
  const { outcome, executionPath } = await recordClaudeOutcome(b, statePath, {
    messages: successfulClaudeMessages(result), conclusion: 'success', stepOutcome: 'success',
  });
  const savedOutcome = JSON.parse(await fsp.readFile(path.join(state.private_root, 'agent-outcome.json'), 'utf8'));

  assert.equal(outcome.process_error, null);
  assert.equal(outcome.model, 'claude-opus-4-5-20250929');
  assert.equal(outcome.journal_path, state.agent_paths.journal);
  assert.equal(outcome.config_path, state.agent_paths.claude.mcp_config);
  assert.equal(outcome.private_result, state.agent_paths.private_result);
  assert.equal(outcome.stdout_path, null);
  assert.equal(outcome.stderr_path, null);
  assert.deepEqual(outcome.phases, [{ name: 'agent', seconds: 2 }]);
  assert.deepEqual(savedOutcome, outcome);
  assert.equal(fs.statSync(outcome.private_result).mode & 0o777, 0o600);
  assert.equal(path.relative(state.private_root, executionPath).startsWith('..'), true);

  await recordAgentOutcome({
    statePath, executionFile: executionPath, conclusion: 'success', stepOutcome: 'success',
  });
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(state.private_root, 'agent-outcome.json'), 'utf8')), outcome);

  const { report } = await finalizeExecution({ statePath }, b.adapters);
  assert.equal(report.status, 'no_findings');
  assert.deepEqual(report.tools.agent, {
    name: 'claude', version: '2.1.283', model: 'claude-opus-4-5-20250929',
  });
  assert.equal(fs.existsSync(executionPath), true);
});

test('the supervised agent command keeps Claude unadapted and uses agent-neutral outcome paths', async (t) => {
  const b = await claudeBundle(t, { env: {} });
  const { statePath, state } = await prepareExecution(b.options, b.adapters);
  const outcome = await runAgentStep({ statePath }, b.adapters);

  assert.equal(outcome.process_error.code, 'UNKNOWN_AGENT');
  assert.equal(outcome.stdout_path, path.join(state.private_root, 'agent-supervisor', 'logs', 'claude.stdout.log'));
  assert.equal(outcome.stderr_path, path.join(state.private_root, 'agent-supervisor', 'logs', 'claude.stderr.log'));
  assert.equal(outcome.config_path, state.agent_paths.claude.mcp_config);
});

test('record-agent classifies missing token, skipped execution, cancellation, and Claude HTTP 401', async (t) => {
  const missing = await claudeBundle(t);
  const missingPrepared = await prepareExecution(missing.options, missing.adapters);
  await recordClaudeOutcome(missing, missingPrepared.statePath, { tokenMissing: true, stepOutcome: 'skipped' });
  const missingReport = await finalizeExecution({ statePath: missingPrepared.statePath }, missing.adapters);
  assert.equal(missingReport.report.reason, 'auth_required');

  const cancelled = await claudeBundle(t);
  const cancelledPrepared = await prepareExecution(cancelled.options, cancelled.adapters);
  await markStartedAgo(cancelledPrepared.statePath, 25 * 60 * 1000);
  await recordClaudeOutcome(cancelled, cancelledPrepared.statePath, { stepOutcome: 'cancelled' });
  const cancelledReport = await finalizeExecution({ statePath: cancelledPrepared.statePath }, cancelled.adapters);
  assert.equal(cancelledReport.report.reason, 'timeout');

  const unauthorized = await claudeBundle(t);
  const unauthorizedPrepared = await prepareExecution(unauthorized.options, unauthorized.adapters);
  const executionFile = path.join(unauthorized.root, 'outside-private', 'execution.jsonl');
  await fsp.mkdir(path.dirname(executionFile));
  await fsp.writeFile(executionFile, `${JSON.stringify({
    type: 'result', api_error_status: 401, is_error: true,
  })}\n`);
  await recordAgentOutcome({
    statePath: unauthorizedPrepared.statePath,
    executionFile,
    conclusion: 'failure',
    stepOutcome: 'failure',
  });
  const unauthorizedReport = await finalizeExecution({ statePath: unauthorizedPrepared.statePath }, unauthorized.adapters);
  assert.equal(unauthorizedReport.report.reason, 'auth_required');
  assert.equal(fs.existsSync(executionFile), true);
});

test('record-agent maps Claude rate limits and invalid agent outputs to report reasons', async (t) => {
  const cases = [
    ['rate limit', { type: 'result', api_error_status: 429, is_error: true }, 'rate_limited'],
    ['max turns', { type: 'result', subtype: 'error_max_turns', is_error: true }, 'invalid_output'],
    ['agent failure', { type: 'result', subtype: 'error_during_execution', is_error: true }, 'invalid_output'],
  ];
  for (const [label, message, reason] of cases) {
    const b = await claudeBundle(t);
    const { statePath } = await prepareExecution(b.options, b.adapters);
    await recordClaudeOutcome(b, statePath, {
      messages: [message], conclusion: 'failure', stepOutcome: 'failure',
    });
    const { report } = await finalizeExecution({ statePath }, b.adapters);
    assert.equal(report.reason, reason, label);
  }

  const noOutput = await claudeBundle(t);
  const { statePath } = await prepareExecution(noOutput.options, noOutput.adapters);
  await recordClaudeOutcome(noOutput, statePath, { stepOutcome: 'skipped' });
  const { report } = await finalizeExecution({ statePath }, noOutput.adapters);
  assert.equal(report.reason, 'invalid_output');
});

test('a cancelled Claude log with a truncated trailing line retains its model and finalizes as timeout', async (t) => {
  const b = await claudeBundle(t, { env: { QA_AGENT_MODEL: 'opus' } });
  const { statePath, state } = await prepareExecution(b.options, b.adapters);
  await markStartedAgo(statePath, 25 * 60 * 1000);
  const executionFile = path.join(b.root, 'truncated.jsonl');
  await fsp.writeFile(executionFile, [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-5-20250929' }),
    JSON.stringify({ type: 'assistant', message: { content: [] } }),
    '{"type":"result","subtype":',
  ].join('\n'));

  const outcome = await recordAgentOutcome({ statePath, executionFile, conclusion: '', stepOutcome: 'cancelled' });
  assert.equal(outcome.process_error.code, 'CANCELLED');
  assert.equal(outcome.model, 'claude-opus-4-5-20250929');
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(state.private_root, 'agent-outcome.json'), 'utf8')), outcome);
  const { report } = await finalizeExecution({ statePath }, b.adapters);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.reason, 'timeout');
  assert.equal(report.tools.agent.model, 'claude-opus-4-5-20250929');
});

test('record-agent persists an invalid-output outcome when a middle log line is corrupt', async (t) => {
  const b = await claudeBundle(t);
  const { statePath, state } = await prepareExecution(b.options, b.adapters);
  const executionFile = path.join(b.root, 'corrupt.jsonl');
  await fsp.writeFile(executionFile, [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-5-20250929' }),
    'RAW_LOG_BODY_MUST_STAY_PRIVATE sk-ant-oat01-private-value',
    JSON.stringify({ type: 'result', subtype: 'success', result: 'untrusted result' }),
  ].join('\n'));

  const outcome = await recordAgentOutcome({ statePath, executionFile, conclusion: 'success', stepOutcome: 'success' });
  assert.equal(outcome.process_error.code, 'AGENT_NO_OUTPUT');
  assert.match(outcome.process_error.details, /INVALID_EXECUTION_LOG/u);
  const saved = await fsp.readFile(path.join(state.private_root, 'agent-outcome.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), outcome);
  assert.doesNotMatch(saved, /RAW_LOG_BODY_MUST_STAY_PRIVATE|sk-ant-oat01-private-value|untrusted result/u);
  const { report } = await finalizeExecution({ statePath }, b.adapters);
  assert.equal(report.reason, 'invalid_output');
  assert.equal(fs.existsSync(executionFile), true);
});

test('record-agent writes an outcome when an execution log exceeds the read limit', async (t) => {
  const b = await claudeBundle(t);
  const { statePath, state } = await prepareExecution(b.options, b.adapters);
  const executionFile = path.join(b.root, 'oversized.jsonl');
  const size = 50 * 1024 * 1024 + 1;
  const handle = await fsp.open(executionFile, 'w');
  try { await handle.truncate(size); } finally { await handle.close(); }

  const outcome = await recordAgentOutcome({ statePath, executionFile, conclusion: 'success', stepOutcome: 'success' });
  assert.equal(outcome.process_error.code, 'AGENT_NO_OUTPUT');
  assert.match(outcome.process_error.details, /EXECUTION_LOG_TOO_LARGE/u);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(state.private_root, 'agent-outcome.json'), 'utf8')), outcome);
  const { report } = await finalizeExecution({ statePath }, b.adapters);
  assert.equal(report.reason, 'invalid_output');
  assert.equal((await fsp.stat(executionFile)).size, size);
});

test('record-agent records a failed action with an unreadable log after its budget as a timeout', async (t) => {
  const b = await claudeBundle(t);
  const { statePath, state } = await prepareExecution(b.options, b.adapters);
  await markStartedAgo(statePath, 25 * 60 * 1000);
  const executionFile = path.join(b.root, 'PRIVATE_LOG_PATH');
  await fsp.mkdir(executionFile);

  const outcome = await recordAgentOutcome({ statePath, executionFile, conclusion: 'failure', stepOutcome: 'failure' });
  assert.equal(outcome.process_error.code, 'CANCELLED');
  assert.match(outcome.process_error.details, /EISDIR/u);
  assert.doesNotMatch(outcome.process_error.details, /PRIVATE_LOG_PATH/u);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(state.private_root, 'agent-outcome.json'), 'utf8')), outcome);
  const { report } = await finalizeExecution({ statePath }, b.adapters);
  assert.equal(report.reason, 'timeout');
});

test('prepare, agent, and finalize in separate calls produce the same report as runExecution', async (t) => {
  const a = await fixtureBundle(t);
  const whole = await runExecution(a.options, a.adapters);
  const b = await fixtureBundle(t);
  const prepared = await prepareExecution(b.options, b.adapters);
  const { statePath, state } = prepared;
  assert.equal(state.runtime.origin.startsWith('http://127.0.0.1:'), true);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.deepEqual(prepared.output, { state: statePath, ready: true });
  await runAgentStep({ statePath }, b.adapters);
  const split = await finalizeExecution({ statePath, cancelled: false }, b.adapters);
  const strip = (report) => ({
    ...report,
    started_at: 0,
    finished_at: 0,
    phases: undefined,
    request: { ...report.request, run: 0 },
  });
  assert.deepEqual(strip(split.report), strip(whole.report));
});

test('finalize still writes a report and stops the runtime when the agent step never ran', async (t) => {
  const b = await fixtureBundle(t);
  const { statePath } = await prepareExecution(b.options, b.adapters);
  const { report } = await finalizeExecution({ statePath, cancelled: false }, b.adapters);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.reason, 'runner_failed');
  assert.equal(b.runtimeStopped(), true);
});

test('an interrupted agent step reports timeout when the job itself was not cancelled', async (t) => {
  const b = await fixtureBundle(t);
  const { statePath } = await prepareExecution(b.options, b.adapters);
  const controller = new AbortController();
  controller.abort();
  const outcome = await runAgentStep({ statePath, signal: controller.signal }, b.adapters);
  assert.equal(outcome.process_error.code, 'CANCELLED');

  const { report } = await finalizeExecution({ statePath, cancelled: false }, b.adapters);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.reason, 'timeout');
  assert.equal(validateReport(report, request), report);
});

test('an interrupted agent step remains cancelled when the job was cancelled', async (t) => {
  const b = await fixtureBundle(t);
  const { statePath } = await prepareExecution(b.options, b.adapters);
  const controller = new AbortController();
  controller.abort();
  const outcome = await runAgentStep({ statePath, signal: controller.signal }, b.adapters);
  assert.equal(outcome.process_error.code, 'CANCELLED');

  const { report } = await finalizeExecution({ statePath, cancelled: true }, b.adapters);
  assert.equal(report.status, 'cancelled');
  assert.equal(report.reason, 'none');
  assert.equal(validateReport(report, request), report);
});

test('finalize reclaims a leftover agent process group before deleting private state', async (t) => {
  const b = await fixtureBundle(t);
  const { statePath, state } = await prepareExecution(b.options, b.adapters);
  const runRoot = path.join(state.private_root, 'agent-supervisor');
  const supervisor = await new ProcessSupervisor({ runRoot, deadline: monotonicDeadlineAfter(60_000) }).initialize();
  const sleeper = await supervisor.spawn('sleeper', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: b.root,
    env: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  await supervisor.handOff();
  t.after(() => {
    if (identityMatches(sleeper.identity)) {
      try { process.kill(-sleeper.identity.pgid, 'SIGKILL'); } catch { /* best-effort test cleanup */ }
    }
  });
  assert.equal(identityMatches(sleeper.identity), true);

  const { report } = await finalizeExecution({ statePath, cancelled: false }, b.adapters);
  assert.equal(report.reason, 'runner_failed');
  assert.equal(identityMatches(sleeper.identity), false);
  assert.equal(fs.existsSync(state.private_root), false);
});

test('agent process cleanup failures still produce a runner_failed report', async (t) => {
  const b = await fixtureBundle(t);
  const { statePath, state } = await prepareExecution(b.options, b.adapters);
  const agentSupervisorRoot = path.join(state.private_root, 'agent-supervisor');
  await fsp.mkdir(agentSupervisorRoot);
  await fsp.writeFile(path.join(agentSupervisorRoot, 'processes.json'), '{invalid');

  const { report, reportPath } = await finalizeExecution({ statePath, cancelled: false }, b.adapters);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.reason, 'runner_failed');
  assert.equal(fs.existsSync(reportPath), true);
  assert.equal(validateReport(report, request), report);
});

test('a cancelled job finalizes as cancelled', async (t) => {
  const b = await fixtureBundle(t);
  const { statePath } = await prepareExecution(b.options, b.adapters);
  const { report } = await finalizeExecution({ statePath, cancelled: true }, b.adapters);
  assert.equal(report.status, 'cancelled');
});

test('a prepare failure is carried to finalize instead of being lost', async (t) => {
  const b = await fixtureBundle(t, { doctorOk: false, failedCheck: 'browser' });
  const { state } = await prepareExecution(b.options, b.adapters);
  assert.equal(state.reason, 'browser_unavailable');
  const { report } = await finalizeExecution({
    statePath: path.join(state.private_root, 'state.json'), cancelled: false,
  }, b.adapters);
  assert.equal(report.reason, 'browser_unavailable');
});

test('an already-aborted execution remains cancelled before doctor runs', async (t) => {
  const b = await fixtureBundle(t);
  const controller = new AbortController();
  controller.abort();
  const { report } = await runExecution({ ...b.options, signal: controller.signal }, b.adapters);
  assert.equal(report.status, 'cancelled');
  assert.equal(report.reason, 'none');
  assert.equal(b.order.includes('doctor'), false);
});

test('a job whose deadline expired before doctor reports timeout', async (t) => {
  const b = await fixtureBundle(t);
  const jobStart = new Date(Date.now() - 26 * 60 * 1000).toISOString();
  const { report } = await runExecution({ ...b.options, jobStart }, b.adapters);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.reason, 'timeout');
});

test('a mismatched candidate head retains the stale outcome', async (t) => {
  const b = await fixtureBundle(t);
  const { report } = await runExecution(b.options, {
    ...b.adapters, candidateHead: () => 'f'.repeat(40),
  });
  assert.equal(report.status, 'cancelled');
  assert.equal(report.reason, 'stale');
});

test('prepare rejects a malformed job start before writing execution state', async (t) => {
  const b = await fixtureBundle(t);
  await assert.rejects(prepareExecution({ ...b.options, jobStart: 'not-a-time' }, b.adapters), {
    code: 'INVALID_JOB_START',
  });
  assert.equal(fs.existsSync(path.join(b.evidence, '.private-execution', 'state.json')), false);
});

test('finalize rejects a state that redirects its private root outside evidence', async (t) => {
  const b = await fixtureBundle(t, { doctorOk: false, failedCheck: 'browser' });
  const { statePath } = await prepareExecution(b.options, b.adapters);
  const otherRoot = path.join(b.root, 'must-not-remove');
  await fsp.mkdir(otherRoot);
  const sentinel = path.join(otherRoot, 'sentinel.txt');
  await fsp.writeFile(sentinel, 'preserve');
  const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  state.private_root = otherRoot;
  await fsp.writeFile(statePath, JSON.stringify(state));
  await assert.rejects(finalizeExecution({ statePath }, b.adapters), { code: 'INVALID_STATE' });
  assert.equal(fs.existsSync(sentinel), true);
});

test('finalize rejects a runtime run root outside the private runtime directory', async (t) => {
  const b = await fixtureBundle(t);
  const { statePath } = await prepareExecution(b.options, b.adapters);
  const otherRunRoot = path.join(b.root, 'must-not-clean');
  await fsp.mkdir(otherRunRoot);
  const sentinel = path.join(otherRunRoot, 'sentinel.txt');
  await fsp.writeFile(sentinel, 'preserve');
  const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  state.runtime.run_root = otherRunRoot;
  state.runtime.manifest_path = path.join(otherRunRoot, 'processes.json');
  await fsp.writeFile(statePath, JSON.stringify(state));

  await assert.rejects(finalizeExecution({ statePath }, b.adapters), { code: 'INVALID_STATE' });
  assert.equal(fs.existsSync(sentinel), true);
});

test('finalize does not delete an agent outcome path outside its private root', async (t) => {
  const b = await fixtureBundle(t);
  const { statePath, state } = await prepareExecution(b.options, b.adapters);
  await runAgentStep({ statePath }, b.adapters);
  const sentinel = path.join(b.root, 'external-log.txt');
  await fsp.writeFile(sentinel, 'preserve');
  const outcomePath = path.join(state.private_root, 'agent-outcome.json');
  const outcome = JSON.parse(await fsp.readFile(outcomePath, 'utf8'));
  outcome.stdout_path = sentinel;
  await fsp.writeFile(outcomePath, JSON.stringify(outcome));
  const { report } = await finalizeExecution({ statePath }, b.adapters);
  assert.equal(report.status, 'no_findings');
  assert.equal(fs.existsSync(sentinel), true);
});

test('the agent step refuses a missing or whitespace-padded token as auth_required', async (t) => {
  for (const token of [undefined, `${'a'.repeat(40)} `]) {
    const b = await fixtureBundle(t, { env: token === undefined ? {} : { QA_COPILOT_TOKEN: token } });
    const { statePath } = await prepareExecution(b.options, b.adapters);
    const outcome = await runAgentStep({ statePath }, b.adapters);
    assert.equal(outcome.process_error.code, 'AUTH_REQUIRED');
    assert.equal(b.order.includes('agent'), false);
    const { report } = await finalizeExecution({ statePath, cancelled: false }, b.adapters);
    assert.equal(report.reason, 'auth_required');
  }
});

test('Copilot invocation grants only the declared browser tools and no blanket permission', () => {
  const { copilotArguments, DENIED_TOOLS } = require('../agents/copilot.cjs');
  const { args } = copilotArguments({ copilotBin: '/toolchain/.bin/copilot', prompt: 'assignment', model: '' });
  assert.deepEqual(args.slice(0, 4), ['-p', 'assignment', '-s', '--no-ask-user']);
  for (const tool of ALLOWED_TOOLS) assert.ok(args.includes(`--allow-tool=playwright(${tool})`), tool);
  for (const denied of DENIED_TOOLS) assert.ok(args.includes(`--deny-tool=${denied}`), denied);
  assert.equal(args.some((value) => /--allow-all|--yolo/u.test(value)), false);
  assert.equal(args.some((value) => value.startsWith('--model=')), false, 'no model is chosen by default');
});

test('the prompt states the result contract the validator enforces', () => {
  const { resultContract } = require('../execute.cjs');
  const schema = require('../agent-result.schema.json');
  const contract = resultContract();
  // Copilot has no --output-schema, so a drift between prompt and validator silently discards runs.
  for (const key of schema.required) assert.ok(contract.includes(key), key);
  for (const key of schema.$defs.scenario.required) assert.ok(contract.includes(key), `scenario.${key}`);
  for (const key of schema.$defs.finding.required) assert.ok(contract.includes(key), `finding.${key}`);
  for (const value of schema.$defs.scenario.properties.status.enum) assert.ok(contract.includes(value), value);
  for (const id of SCENARIO_IDS) assert.ok(contract.includes(id), id);
  // The field names the agent invented on its first successful browser run must not appear.
  for (const wrong of ['observed_steps', 'expected_behavior', 'actual_behavior']) {
    assert.equal(contract.includes(wrong), false, wrong);
  }
});

test('A faithful browser journal proves six distinct journeys from harness-written evidence', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gods-eye-journal-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const screenshotsRoot = path.join(root, 'screenshots');
  await screenshots(screenshotsRoot);
  const entries = faithfulJournalEntries(origin);
  const parsed = parseBrowserJournal(entries, { origin, screenshotsRoot });
  assert.equal(parsed.complete, true);
  assert.equal(parsed.toolCalls.filter(({ tool }) => tool === 'browser_take_screenshot').length, 6);
  assert.equal(parsed.toolCalls.every(({ scenario_id }) => SCENARIO_IDS.includes(scenario_id)), true);
  assert.equal(new Set(parsed.toolCalls.map(({ scenario_id }) => scenario_id)).size, 6);
});

test('An action the page never observed cannot be recovered by anything the agent reports', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gods-eye-journal-gap-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const screenshotsRoot = path.join(root, 'screenshots');
  await screenshots(screenshotsRoot);

  const missingClick = faithfulJournalEntries(origin);
  const clickIndex = missingClick.findIndex((entry) => entry.action === 'click');
  missingClick.splice(clickIndex, 1);
  assert.equal(parseBrowserJournal(missingClick, { origin, screenshotsRoot }).complete, false);

  const forgedReceipt = faithfulJournalEntries(origin);
  forgedReceipt.find((entry) => entry.kind === 'receipt').satisfied = false;
  assert.equal(parseBrowserJournal(forgedReceipt, { origin, screenshotsRoot }).complete, false);

  const foreignOrigin = faithfulJournalEntries(origin);
  foreignOrigin.find((entry) => entry.kind === 'navigate').url = 'http://example.test/';
  assert.equal(parseBrowserJournal(foreignOrigin, { origin, screenshotsRoot }).complete, false);
});

test('A complete adapter-backed execution emits a validated no-findings public artifact and prunes private output', async (t) => {
  const result = await executeCase(t, { canary: true });
  assert.equal(result.report.status, 'no_findings');
  assert.equal(result.report.reason, 'none');
  assert.deepEqual(result.order, ['doctor', 'runtime', 'baseline', 'agent', 'cleanup']);
  validateReport(result.report, request);
  // The job summary reads these; before they were recorded the timings existed only in stderr.
  assert.deepEqual(result.report.phases.map(({ name }) => name), ['doctor', 'runtime', 'baseline', 'agent', 'finalize']);
  assert.equal(result.report.phases.every(({ seconds }) => Number.isSafeInteger(seconds) && seconds >= 0), true);
  validateEvidenceManifest(result.evidence, result.report.evidence);
  assert.equal(fs.existsSync(path.join(result.evidence, '.private-execution')), false);
  assert.equal(fs.existsSync(path.join(result.evidence, 'screenshots', 'untrusted-extra.txt')), false);
  assert.deepEqual((await fsp.readdir(result.evidence)).sort(), ['report.json', 'screenshots']);
  assert.doesNotMatch(
    await fsp.readFile(result.reportPath, 'utf8'),
    /sk_test|sk-ant-oat01-abcdef|CLAUDE_CODE_OAUTH_TOKEN=x|TOKEN_CANARY|qa-receipt/,
  );
  const durable = path.join(durableEvidence, 'adapter-success');
  await fsp.rm(durable, { recursive: true, force: true });
  await fsp.mkdir(durableEvidence, { recursive: true });
  await fsp.cp(result.evidence, durable, { recursive: true });
});

test('public reports redact JSON-quoted environment credentials', async (t) => {
  const { report, reportPath } = await executeCase(t, { jsonCanary: true });
  assert.equal(report.status, 'no_findings');
  assert.match(report.scenarios[0].actual, /\[redacted\]/u);
  const reportText = await fsp.readFile(reportPath, 'utf8');
  assert.doesNotMatch(reportText, /oauth-json-secret|anthropic-json-secret|openai-json-secret|github-json-secret/u);
});

test('Failure matrix keeps infrastructure honest, checks source integrity, and always cleans owned state', async (t) => {
  const cases = [
    ['auth_required', { doctor: doctor(false, ['subscription_auth']) }, 'incomplete', 'auth_required'],
    ['rate_limited', { noResult: true, noScreenshots: true, processError: { code: 'PROCESS_FAILED', message: '429 rate limit' } }, 'incomplete', 'rate_limited'],
    ['invalid_json', { invalidResult: true }, 'incomplete', 'invalid_output'],
    ['missing_screenshot', { missingScreenshot: 'recover-409' }, 'incomplete', 'invalid_output'],
    ['no_browser_evidence', { journal: () => [], noScreenshots: true }, 'incomplete', 'invalid_output'],
    ['source_changed', { sourceChanged: true }, 'incomplete', 'source_changed'],
    ['tracked_dirty', { dirtyAfter: true }, 'incomplete', 'source_changed'],
    ['setup_failure', { baselineError: { code: 'BASELINE_SETUP_FAILED', message: 'test setup failed' } }, 'incomplete', 'setup_failed'],
    ['timeout', { noResult: true, noScreenshots: true, processError: { code: 'DEADLINE_EXCEEDED', message: 'deadline expired' } }, 'incomplete', 'timeout'],
    ['cancelled', { startError: { code: 'CANCELLED', message: 'cancelled' } }, 'cancelled', 'none'],
  ];
  const observed = [];
  for (const [name, overrides, status, reason] of cases) {
    const result = await executeCase(t, overrides);
    assert.equal(result.report.status, status, name);
    assert.equal(result.report.reason, reason, name);
    assert.equal(result.report.cleanup.attempted, true, name);
    assert.equal(result.report.cleanup.private_output_deleted, true, name);
    assert.equal(fs.existsSync(path.join(result.evidence, '.private-execution')), false, name);
    observed.push({ name, status: result.report.status, reason: result.report.reason });
  }
  await fsp.mkdir(durableEvidence, { recursive: true });
  await fsp.writeFile(path.join(durableEvidence, 'failure-matrix.json'), `${JSON.stringify(observed, null, 2)}\n`);
});

test('A zero-test or missing baseline result is setup failure even when its process exits zero', async (t) => {
  const paths = await temporary(t);
  const bundle = fixtureAdapters();
  delete bundle.adapters.runBaseline;
  const result = await runExecution({
    request: paths.requestPath,
    candidate: paths.candidate,
    evidence: paths.evidence,
    jobStart: new Date().toISOString(),
  }, bundle.adapters);
  assert.equal(result.report.status, 'incomplete');
  assert.equal(result.report.reason, 'setup_failed');
  assert.equal(result.report.deterministic_results[0].status, 'not_run');
  assert.equal(fs.existsSync(path.join(paths.evidence, '.private-execution')), false);
});

test('Tracked snapshot records deletion and symlink bytes rather than following symlink targets', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gods-eye-snapshot-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  childProcess.execFileSync('git', ['init', '-q', root]);
  await fsp.writeFile(path.join(root, 'tracked.txt'), 'tracked');
  await fsp.symlink('tracked.txt', path.join(root, 'link'));
  childProcess.execFileSync('git', ['-C', root, 'add', 'tracked.txt', 'link']);
  await fsp.rm(path.join(root, 'tracked.txt'));
  const snapshot = snapshotTrackedFiles(root);
  assert.deepEqual(snapshot['tracked.txt'], { kind: 'missing', sha256: null });
  assert.equal(snapshot.link.kind, 'symlink');
});

function executeCli(command, args, env) {
  const result = childProcess.spawnSync(process.execPath, [path.join(qaRoot, 'execute.cjs'), command, ...args], {
    encoding: 'utf8', timeout: 30_000, env,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}

async function cliFixture(t) {
  const paths = await temporary(t);
  await fsp.writeFile(path.join(paths.candidate, 'README.md'), 'fixture\n');
  childProcess.execFileSync('git', ['init', '-q', paths.candidate]);
  childProcess.execFileSync('git', ['-C', paths.candidate, 'add', 'README.md']);
  childProcess.execFileSync('git', [
    '-c', 'user.name=Agent QA Fixture', '-c', 'user.email=agent-qa@example.invalid',
    '-C', paths.candidate, 'commit', '-qm', 'fixture',
  ]);
  const head = childProcess.execFileSync('git', ['-C', paths.candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const cliRequest = { ...request, head: { ...request.head, sha: head } };
  await fsp.writeFile(paths.requestPath, JSON.stringify(cliRequest));
  const stateRoot = path.join(paths.root, 'qa-state');
  await fsp.mkdir(stateRoot, { mode: 0o700 });
  const env = {
    HOME: process.env.HOME, PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8',
    QA_ROOT: stateRoot, QA_DEVELOPER_CHECKOUT: paths.candidate, GITHUB_ACTIONS: 'true',
    QA_GH_BIN: '/bin/false', QA_COPILOT_BIN: '/bin/false',
    QA_PLAYWRIGHT_MCP_BIN: '/bin/false', QA_UV_BIN: '/bin/false',
    QA_PNPM_BIN: '/bin/false', QA_SYSTEMCTL_BIN: '/bin/false',
    QA_LOGINCTL_BIN: '/bin/false', QA_BROWSER_PROBE_BIN: '/bin/false',
  };
  const prepared = executeCli('prepare', [
    '--request', paths.requestPath, '--candidate', paths.candidate,
    '--evidence', paths.evidence, '--job-start', new Date().toISOString(),
  ], env);
  assert.equal(prepared.ready, false);
  assert.equal(prepared.state, path.join(paths.evidence, '.private-execution', 'state.json'));
  return { ...paths, cliRequest, env, statePath: prepared.state };
}

async function stageCliRuntime(statePath) {
  // This disposable README checkout cannot launch the fixture app. Stage a no-process handoff
  // manifest after the real prepare CLI writes state so the next CLI steps exercise the handoff.
  const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  const runRoot = path.join(state.private_root, 'runtime', 'cli-handoff');
  await fsp.mkdir(runRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(runRoot, 'processes.json');
  await fsp.writeFile(manifestPath, JSON.stringify({
    version: 1, runRoot, handedOff: true, processes: [], ownedPaths: [], temporaryDirectory: null,
  }), { mode: 0o600 });
  const promptPath = path.join(state.private_root, 'prompt.txt');
  await fsp.writeFile(promptPath, 'fixture assignment', { mode: 0o600 });
  state.reason = null;
  state.runtime = { origin, manifest_path: manifestPath, run_root: runRoot };
  state.prompt_path = promptPath;
  state.agent_paths = {
    work_dir: path.join(state.private_root, 'work'),
    agent_home: path.join(state.private_root, 'agent-home'),
    journal: path.join(state.private_root, 'browser-journal.jsonl'),
    private_result: path.join(state.private_root, 'agent-result.json'),
  };
  await fsp.mkdir(state.agent_paths.work_dir, { mode: 0o700 });
  await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

test('real execute CLI carries missing agent auth across prepare, agent, and finalize processes', async (t) => {
  const b = await cliFixture(t);
  await stageCliRuntime(b.statePath);
  const agent = executeCli('agent', ['--state', b.statePath], b.env);
  assert.equal(agent.outcome, path.join(path.dirname(b.statePath), 'agent-outcome.json'));
  const finalized = executeCli('finalize', ['--state', b.statePath], b.env);
  assert.equal(finalized.status, 'incomplete');
  assert.equal(finalized.reason, 'auth_required');
  const report = JSON.parse(await fsp.readFile(finalized.report, 'utf8'));
  validateReport(report, b.cliRequest);
  assert.equal(report.cleanup.private_output_deleted, true);
});

test('real execute CLI finalizes a validated report when the agent process was skipped', async (t) => {
  const b = await cliFixture(t);
  await stageCliRuntime(b.statePath);
  const finalized = executeCli('finalize', ['--state', b.statePath], b.env);
  assert.equal(finalized.status, 'incomplete');
  assert.equal(finalized.reason, 'runner_failed');
  const report = JSON.parse(await fsp.readFile(finalized.report, 'utf8'));
  validateReport(report, b.cliRequest);
  assert.equal(report.cleanup.private_output_deleted, true);
});
