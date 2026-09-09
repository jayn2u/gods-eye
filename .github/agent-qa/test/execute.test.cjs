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
  deadlineFromJobStart,
  parseCli,
  runExecution,
  snapshotTrackedFiles,
} = require('../execute.cjs');
const { parseBrowserJournal } = require('../journal.cjs');
const { faithfulJournalEntries } = require('./fixtures/journal-builder.cjs');
const { SCENARIO_IDS, validateEvidenceManifest, validateReport } = require('../contracts.cjs');

const qaRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'execution');
const origin = 'http://127.0.0.1:41731';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const durableEvidence = path.resolve(process.env.QA_EXECUTE_EVIDENCE ?? path.join(process.cwd(), '.omo/evidence/release-pr-agent-qa/task-6'));
const sha = '1'.repeat(40);
const baseSha = '2'.repeat(40);
const request = {
  schema_version: 1,
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
    { name: 'tool_versions', ok: true, node: process.versions.node, copilot: '0.0.354', playwright_mcp: '0.0.80' },
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

function successAdapters(overrides = {}) {
  let snapshots = 0;
  let cleanChecks = 0;
  const order = [];
  return {
    order,
    adapters: {
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
        return overrides.doctor ?? doctor();
      },
      startRuntime: async () => {
        order.push('runtime');
        if (overrides.startError) throw overrides.startError;
        return {
          origin,
          supervisor: { runRoot: '/unused-by-adapter', runToDeadline: async () => ({ code: 0, signal: null }) },
          stop: async () => {
            order.push('cleanup');
            return { allProcessesStopped: true, processes: [{ outcome: 'stopped' }] };
          },
        };
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
        assert.match(environment.lockFile, /auth\.lock$/);
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
            if (overrides.canary) result.summary = 'OPENAI_API_KEY=sk_test_canary_123456 TOKEN_CANARY_ALPHA';
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

async function executeCase(t, overrides = {}) {
  const paths = await temporary(t);
  const bundle = successAdapters(overrides);
  const result = await runExecution({
    request: paths.requestPath,
    candidate: paths.candidate,
    evidence: paths.evidence,
    jobStart: new Date().toISOString(),
  }, bundle.adapters);
  return { ...paths, ...bundle, ...result };
}

test('CLI parsing and the single wall-to-monotonic deadline preserve the task contract', () => {
  const parsed = parseCli([
    'run', '--request', '/tmp/request.json', '--candidate', '/tmp/candidate',
    '--evidence', '/tmp/evidence', '--job-start', '2026-09-07T09:00:00Z',
  ]);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.jobStart, '2026-09-07T09:00:00Z');
  assert.throws(() => parseCli(['run', '--requestJSON', '/tmp/request.json']), /Usage/);
  const deadline = deadlineFromJobStart('2026-09-07T09:00:00Z', {
    wallNow: Date.parse('2026-09-07T09:02:00Z'),
    monotonicNow: 25_000,
  });
  assert.equal(deadline, 25_000 + INTERNAL_DEADLINE_MS - 120_000);
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
  validateEvidenceManifest(result.evidence, result.report.evidence);
  assert.equal(fs.existsSync(path.join(result.evidence, '.private-execution')), false);
  assert.equal(fs.existsSync(path.join(result.evidence, 'screenshots', 'untrusted-extra.txt')), false);
  assert.deepEqual((await fsp.readdir(result.evidence)).sort(), ['report.json', 'screenshots']);
  assert.doesNotMatch(await fsp.readFile(result.reportPath, 'utf8'), /sk_test|TOKEN_CANARY|qa-receipt/);
  const durable = path.join(durableEvidence, 'adapter-success');
  await fsp.rm(durable, { recursive: true, force: true });
  await fsp.mkdir(durableEvidence, { recursive: true });
  await fsp.cp(result.evidence, durable, { recursive: true });
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
  const bundle = successAdapters();
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

test('Real execute CLI with a disposable clean checkout reports a missing agent token without using developer credentials', async (t) => {
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
  const result = childProcess.spawnSync(process.execPath, [
    path.join(qaRoot, 'execute.cjs'), 'run',
    '--request', paths.requestPath, '--candidate', paths.candidate,
    '--evidence', paths.evidence, '--job-start', new Date().toISOString(),
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      HOME: process.env.HOME, PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8',
      QA_ROOT: stateRoot, QA_DEVELOPER_CHECKOUT: paths.candidate,
      // Inside a workflow the agent token is required, so its absence must surface as auth_required
      // rather than as a product finding.
      GITHUB_ACTIONS: 'true',
      QA_GH_BIN: '/bin/false', QA_COPILOT_BIN: '/bin/false',
      QA_PLAYWRIGHT_MCP_BIN: '/bin/false', QA_UV_BIN: '/bin/false',
      QA_PNPM_BIN: '/bin/false', QA_SYSTEMCTL_BIN: '/bin/false',
      QA_LOGINCTL_BIN: '/bin/false', QA_BROWSER_PROBE_BIN: '/bin/false',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'incomplete');
  assert.equal(output.reason, 'auth_required');
  const report = JSON.parse(await fsp.readFile(path.join(paths.evidence, 'report.json'), 'utf8'));
  validateReport(report, cliRequest);
  assert.equal(report.cleanup.private_output_deleted, true);
  const durable = path.join(durableEvidence, 'cli-missing-auth');
  await fsp.rm(durable, { recursive: true, force: true });
  await fsp.mkdir(durable, { recursive: true });
  await fsp.copyFile(path.join(paths.evidence, 'report.json'), path.join(durable, 'report.json'));
  await fsp.writeFile(path.join(durable, 'observation.json'), `${JSON.stringify({
    invocation: 'node .github/agent-qa/execute.cjs run --request <json> --candidate <path> --evidence <path> --job-start <timestamp>',
    exit_status: result.status,
    status: output.status,
    reason: output.reason,
    developer_auth_used: false,
  }, null, 2)}\n`);
});
