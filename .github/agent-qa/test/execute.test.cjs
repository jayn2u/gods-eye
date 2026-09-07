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
  codexArguments,
  deadlineFromJobStart,
  parseCli,
  parseCodexEvents,
  receiptExpression,
  runExecution,
  snapshotTrackedFiles,
} = require('../execute.cjs');
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
    { name: 'tool_versions', ok: true, node: process.versions.node, codex: '0.153.3', playwright_mcp: '0.0.80' },
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
      runCodex: async ({ paths, environment, prompt }) => {
        order.push('codex');
        for (const scenario of require('../scenarios.json').scenarios) {
          assert.equal(prompt.includes(receiptExpression(scenario)), true);
        }
        assert.match(environment.lockFile, /auth\.lock$/);
        const source = overrides.events ?? path.join(fixtureRoot, 'success.jsonl');
        await fsp.copyFile(source, path.join(path.dirname(paths.privateResult), 'events.jsonl'));
        const eventsPath = path.join(path.dirname(paths.privateResult), 'events.jsonl');
        const stderrPath = path.join(path.dirname(paths.privateResult), 'stderr.log');
        await fsp.writeFile(stderrPath, overrides.stderr ?? '');
        if (!overrides.noResult) {
          if (overrides.invalidResult) await fsp.writeFile(paths.privateResult, '{bad-json');
          else {
            const result = JSON.parse(await fsp.readFile(path.join(fixtureRoot, 'agent-result.json'), 'utf8'));
            if (overrides.canary) result.summary = 'OPENAI_API_KEY=sk_test_canary_123456 TOKEN_CANARY_ALPHA';
            await fsp.writeFile(paths.privateResult, JSON.stringify(result));
          }
        }
        if (!overrides.noScreenshots) {
          await screenshots(paths.screenshotsRoot, overrides.missingScreenshot);
          await fsp.writeFile(path.join(paths.screenshotsRoot, 'untrusted-extra.txt'), 'must be pruned');
        }
        return { eventsPath, stderrPath, privateResult: paths.privateResult, processError: overrides.processError };
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

test('Codex invocation isolates config, pins one required MCP allowlist, and chooses no model', () => {
  const invocation = codexArguments({
    codexBin: '/trusted/codex',
    mcpBin: '/trusted/playwright-mcp',
    origin,
    screenshotsRoot: '/evidence/screenshots',
    privateResult: '/private/result.json',
    workDir: '/private/empty',
    prompt: 'trusted prompt',
  });
  const joined = invocation.args.join('\n');
  assert.match(joined, /--ignore-user-config/);
  assert.match(joined, /--ignore-rules/);
  assert.match(joined, /--sandbox\nread-only/);
  assert.match(joined, /mcp_servers\.playwright\.required=true/);
  assert.match(joined, /project_doc_max_bytes=0/);
  assert.doesNotMatch(joined, /browser_run_code/);
  assert.doesNotMatch(joined, /--no-sandbox|--extension|--user-data-dir|--model/);
  assert.equal(ALLOWED_TOOLS.includes('browser_take_screenshot'), true);
});

test('Pinned-format completed MCP events prove six distinct journeys and emitted usage', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gods-eye-events-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const screenshotsRoot = path.join(root, 'screenshots');
  await screenshots(screenshotsRoot);
  const events = (await fsp.readFile(path.join(fixtureRoot, 'success.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const pinnedCalls = events.filter((event) => event.item?.type === 'mcp_tool_call').map((event) => event.item);
  assert.equal(pinnedCalls.filter((item) => item.tool === 'browser_click')
    .every((item) => typeof item.arguments.target === 'string' && !Object.hasOwn(item.arguments, 'ref')), true);
  assert.equal(pinnedCalls.filter((item) => item.tool === 'browser_fill_form')
    .every((item) => item.arguments.fields.every((field) => typeof field.target === 'string')), true);
  const parsed = parseCodexEvents(events, { origin, screenshotsRoot });
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.usage, { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 300 });
  assert.equal(parsed.toolCalls.filter(({ tool }) => tool === 'browser_take_screenshot').length, 6);
  assert.equal(parsed.toolCalls.every(({ scenario_id }) => SCENARIO_IDS.includes(scenario_id)), true);
  const failedEvents = structuredClone(events);
  failedEvents.find((event) => event.item?.tool === 'browser_click').item.status = 'failed';
  assert.equal(parseCodexEvents(failedEvents, { origin, screenshotsRoot }).complete, false);
  const unrelatedEvents = structuredClone(events);
  for (const event of unrelatedEvents) {
    if (['browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key'].includes(event.item?.tool)) {
      event.item.tool = 'browser_press_key';
      event.item.arguments = { key: 'F13' };
    }
  }
  assert.equal(parseCodexEvents(unrelatedEvents, { origin, screenshotsRoot }).complete, false);
  const missingReceiptOutput = structuredClone(events);
  const receiptEvent = missingReceiptOutput.find((event) => event.item?.tool === 'browser_evaluate'
    && String(event.item.arguments?.function).includes('qa-receipt:'));
  receiptEvent.item.result.content = [{ type: 'text', text: 'unrelated output' }];
  assert.equal(parseCodexEvents(missingReceiptOutput, { origin, screenshotsRoot }).complete, false);
  const screenshotBeforeReceipt = structuredClone(events);
  const firstReceiptIndex = screenshotBeforeReceipt.findIndex((event) => event.item?.tool === 'browser_evaluate'
    && String(event.item.arguments?.function).includes('qa-receipt:'));
  const firstScreenshotIndex = screenshotBeforeReceipt.findIndex((event) => event.item?.tool === 'browser_take_screenshot');
  [screenshotBeforeReceipt[firstReceiptIndex], screenshotBeforeReceipt[firstScreenshotIndex]]
    = [screenshotBeforeReceipt[firstScreenshotIndex], screenshotBeforeReceipt[firstReceiptIndex]];
  assert.equal(parseCodexEvents(screenshotBeforeReceipt, { origin, screenshotsRoot }).complete, false);
});

test('A complete adapter-backed execution emits a validated no-findings public artifact and prunes private output', async (t) => {
  const result = await executeCase(t, { canary: true });
  assert.equal(result.report.status, 'no_findings');
  assert.equal(result.report.reason, 'none');
  assert.deepEqual(result.order, ['doctor', 'runtime', 'baseline', 'codex', 'cleanup']);
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
    ['rate_limited', { events: path.join(fixtureRoot, 'rate-limited.jsonl'), noResult: true, noScreenshots: true, processError: { code: 'PROCESS_FAILED', message: '429 rate limit' } }, 'incomplete', 'rate_limited'],
    ['invalid_json', { invalidResult: true }, 'incomplete', 'invalid_output'],
    ['missing_screenshot', { missingScreenshot: 'recover-409' }, 'incomplete', 'invalid_output'],
    ['no_mcp', { events: path.join(fixtureRoot, 'no-mcp.jsonl'), noScreenshots: true }, 'incomplete', 'invalid_output'],
    ['source_changed', { sourceChanged: true }, 'incomplete', 'source_changed'],
    ['tracked_dirty', { dirtyAfter: true }, 'incomplete', 'source_changed'],
    ['setup_failure', { baselineError: { code: 'BASELINE_SETUP_FAILED', message: 'test setup failed' } }, 'incomplete', 'setup_failed'],
    ['timeout', { events: path.join(fixtureRoot, 'rate-limited.jsonl'), noResult: true, noScreenshots: true, processError: { code: 'DEADLINE_EXCEEDED', message: 'deadline expired' } }, 'incomplete', 'timeout'],
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

test('Real execute CLI with a disposable clean checkout reports missing CI auth without using developer auth', async (t) => {
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
      QA_GH_BIN: '/bin/false', QA_CODEX_BIN: '/bin/false',
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
