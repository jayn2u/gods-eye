'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  GhAdapter,
  LiveVerificationError,
  adversarialLedger,
  cleanupOwned,
  createOwnedBranch,
  createOwnedPull,
  defectSource,
  inspectPng,
  loadRegistry,
  matchingRun,
  parseArgs,
  preflight,
  runLive,
} = require('../verify-live.cjs');
const { LiveMatrixAdapter } = require('./fixtures/live-adapter.cjs');

const SHA = 'a'.repeat(40);

function doctor(ok = true) {
  return {
    ok,
    checks: [
      { name: 'subscription_auth', ok, api_environment_present: false },
      { name: 'runner_service', ok },
      { name: 'tool_versions', ok },
      { name: 'browser', ok },
    ],
  };
}

function adapterFixture(overrides = {}) {
  const mutations = [];
  const adapter = {
    async authStatus() { return { ok: true }; },
    async repositoryMetadata() {
      return { full_name: 'jayn2u/gods-eye', private: true, default_branch: 'develop' };
    },
    async defaultRef() { return { object: { sha: SHA } }; },
    async workflows() {
      return [
        { id: 1, path: '.github/workflows/agent-qa.yml', state: 'active' },
        { id: 2, path: '.github/workflows/agent-qa-report.yml', state: 'active' },
      ];
    },
    async trustedBlob() { return { sha: SHA }; },
    async localBlobSha() { return SHA; },
    async runners() {
      return [{
        name: 'gods-eye-agent-qa', status: 'online', busy: false,
        labels: ['self-hosted', 'Linux', 'X64', 'gods-eye-agent-qa'].map((name) => ({ name })),
      }];
    },
    async doctor() { return { ok: true, report: doctor() }; },
    async requiredChecks() { return { observable: true, contexts: ['Python'], checks: [] }; },
    async createBranch() { mutations.push('createBranch'); },
    async createPull() { mutations.push('createPull'); },
    async findBranch(name) { return { ref: `refs/heads/${name}`, object: { sha: SHA } }; },
    async getPull(number) { return { number, state: 'open' }; },
    async findPull() { return null; },
    async closePull(number) { mutations.push(`close:${number}`); },
    async deleteBranch(name) { mutations.push(`delete:${name}`); },
    ...overrides,
  };
  return { adapter, mutations };
}

test('CLI accepts only the exact repository and evidence arguments', () => {
  assert.deepEqual(parseArgs(['--repo', 'jayn2u/gods-eye', '--evidence', 'proof']), {
    repository: 'jayn2u/gods-eye', evidence: path.resolve('proof'),
  });
  for (const args of [
    [], ['--repo', 'someone/else', '--evidence', 'proof'],
    ['--repo', 'jayn2u/gods-eye', '--evidence', 'proof', '--write', 'yes'],
    ['--repo', 'jayn2u/gods-eye', '--repo', 'jayn2u/gods-eye'],
  ]) {
    assert.throws(() => parseArgs(args), LiveVerificationError);
  }
});

test('GitHub adapter preserves argument boundaries and sends structured JSON over stdin', () => {
  const calls = [];
  const adapter = new GhAdapter({
    command(binary, args, options) {
      calls.push({ binary, args, input: options.input });
      return JSON.stringify({ number: 7 });
    },
  });
  const result = adapter.api('repos/jayn2u/gods-eye/pulls', {
    method: 'POST', jsonBody: { title: 'literal $(do-not-run)', draft: false },
  });
  assert.equal(result.number, 7);
  assert.deepEqual(calls[0].args, [
    'api', 'repos/jayn2u/gods-eye/pulls', '--method', 'POST', '--input', '-',
  ]);
  assert.deepEqual(JSON.parse(calls[0].input), { title: 'literal $(do-not-run)', draft: false });
});

test('GitHub adapter treats a 404 classic protection surface as observable only after rulesets load', async () => {
  const adapter = new GhAdapter({
    command(_binary, args) {
      const endpoint = args[1];
      if (endpoint.includes('/protection/required_status_checks')) {
        throw new LiveVerificationError('github_cli_failed', 'gh failed', { status: 1, message: 'HTTP 404: Not Found' });
      }
      if (endpoint.endsWith('rulesets?includes_parents=true')) {
        return JSON.stringify([{ id: 9, enforcement: 'active' }]);
      }
      if (endpoint.endsWith('/rulesets/9')) {
        return JSON.stringify({ rules: [{
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'Python' }] },
        }] });
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  });
  assert.deepEqual(await adapter.requiredChecks('develop'), {
    observable: true, source: 'repository_rulesets', contexts: ['Python'], checks: [],
  });
});

test('absent GitHub auth stops at the first read-only preflight and creates no resources', async (t) => {
  const evidence = mkdtempSync(path.join(tmpdir(), 'verify-live-no-auth-'));
  t.after(() => require('node:fs').rmSync(evidence, { recursive: true, force: true }));
  const { adapter, mutations } = adapterFixture({ async authStatus() { return { ok: false }; } });
  const result = await runLive({
    adapter, repository: 'jayn2u/gods-eye', evidence, prefix: 'agent-qa-live-1000-abcdef',
  });
  assert.equal(result.status, 'live_incomplete');
  assert.deepEqual(result.preflight.missing, ['github_cli_authentication_required']);
  assert.deepEqual(mutations, []);
  assert.equal(JSON.parse(readFileSync(path.join(evidence, 'live.json'))).status, 'live_incomplete');
  assert.deepEqual(loadRegistry(evidence).branches, []);
});

test('absent runner and CI subscription login are distinct fail-closed prerequisites', async () => {
  const { adapter } = adapterFixture({
    async runners() { return []; },
    async doctor() { return { ok: false, report: doctor(false) }; },
  });
  const result = await preflight(adapter);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('runner_provisioning_required'));
  assert.ok(result.missing.includes('ci_subscription_login_required'));
  assert.equal(result.checks.find(({ name }) => name === 'runner').observable.exact_count, 0);
});

test('missing default workflows and unknown required checks cannot be inferred safe', async () => {
  const { adapter } = adapterFixture({
    async workflows() { return []; },
    async requiredChecks() {
      return { observable: false, contexts: [], checks: [], reason: 'branch_protection_unavailable' };
    },
  });
  const result = await preflight(adapter);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('default_branch_agent-qa.yml_not_active'));
  assert.ok(result.missing.includes('default_branch_agent-qa-report.yml_not_active'));
  assert.ok(result.missing.includes('required_checks_not_observable'));
});

test('required Agent QA check is rejected because the workflow must remain advisory', async () => {
  const { adapter } = adapterFixture({
    async requiredChecks() { return { observable: true, contexts: ['Agent QA / Fixture browser QA'], checks: [] }; },
  });
  const result = await preflight(adapter);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('agent_qa_is_a_required_check'));
});

test('cleanup closes and deletes only resources in the durable owned registry', async () => {
  const { adapter, mutations } = adapterFixture();
  const registry = {
    schema_version: 1,
    repository: 'jayn2u/gods-eye',
    prefix: 'agent-qa-live-1000-abcdef',
    branches: [
      { name: 'agent-qa-live-1000-abcdef-release', expected_sha: SHA, state: 'created' },
      { name: 'agent-qa-live-1000-abcdef-clean', expected_sha: SHA, state: 'created' },
    ],
    pulls: [
      { number: 101, marker: 'agent-qa-live-1000-abcdef', title: '[agent-qa-live-1000-abcdef] one',
        head: 'agent-qa-live-1000-abcdef-clean', base: 'release/agent-qa-live-1000-abcdef', state: 'created' },
      { number: 102, marker: 'agent-qa-live-1000-abcdef', title: '[agent-qa-live-1000-abcdef] two',
        head: 'agent-qa-live-1000-abcdef-clean', base: 'release/agent-qa-live-1000-abcdef', state: 'created' },
    ],
    processes: [],
  };
  const result = await cleanupOwned(adapter, registry);
  assert.equal(result.completed, true);
  assert.deepEqual(mutations, [
    'close:102', 'close:101',
    'delete:agent-qa-live-1000-abcdef-clean', 'delete:agent-qa-live-1000-abcdef-release',
  ]);
  assert.equal(mutations.some((entry) => entry.includes('all')), false);
});

test('cleanup deadline leaves later owned resources explicit and incomplete', async () => {
  const { adapter } = adapterFixture();
  let clock = 0;
  const registry = {
    schema_version: 1, repository: 'jayn2u/gods-eye', prefix: 'agent-qa-live-1000-abcdef',
    branches: [{ name: 'agent-qa-live-1000-abcdef-clean', expected_sha: SHA, state: 'created' }],
    pulls: [{ number: 3, marker: 'agent-qa-live-1000-abcdef', title: '[agent-qa-live-1000-abcdef] one',
      head: 'agent-qa-live-1000-abcdef-clean', base: 'release/agent-qa-live-1000-abcdef', state: 'created' }],
    processes: [],
  };
  const result = await cleanupOwned(adapter, registry, { deadlineMs: 1, now: () => { clock += 2; return clock; } });
  assert.equal(result.completed, false);
  assert.ok(result.actions.every(({ reason }) => reason === 'cleanup_deadline'));
});

test('run identity parser binds a workflow run to exact PR and head', () => {
  const run = {
    name: 'Agent QA', event: 'pull_request_target',
    display_title: `Agent QA PR #42 head ${SHA}`,
  };
  assert.equal(matchingRun(run, 42, SHA), true);
  assert.equal(matchingRun(run, 43, SHA), false);
  assert.equal(matchingRun({ ...run, display_title: 'Agent QA says success' }, 42, SHA), false);
});

test('temporary product defect changes only the exact search-submit expression', () => {
  const source = 'before <button className="primary" disabled={props.selectedModel?.ready !== true}>Search gallery after';
  assert.equal(defectSource(source), 'before <button className="primary" disabled={true}>Search gallery after');
  assert.throws(() => defectSource('unrelated source'), /anchor was not exact/u);
});

test('PNG inspection requires real dimensions and exact artifact metadata', () => {
  const png = Buffer.alloc(33, 1);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(1440, 16);
  png.writeUInt32BE(1000, 20);
  const entry = {
    path: 'screenshots/search-detail-return.png', size_bytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
  };
  assert.deepEqual(inspectPng(png, entry), { ...entry, width: 1440, height: 1000 });
  assert.throws(() => inspectPng(Buffer.from('model says screenshot exists'), entry), /invalid screenshot/u);
});

test('adversarial ledger names nine concrete failure classes without claiming pending live proof', () => {
  const pending = adversarialLedger('live_incomplete');
  assert.equal(pending.classes.length, 9);
  assert.equal(new Set(pending.classes.map(({ name }) => name)).size, 9);
  assert.equal(pending.classes.find(({ name }) => name === 'model_prose_without_artifact').status, 'pending_prerequisite');
  assert.equal(pending.classes.find(({ name }) => name === 'absent_auth').status, 'covered');
});

test('full adapter-backed runLive executes a-f, validates artifacts, and cleans exact resources', async (t) => {
  const evidence = mkdtempSync(path.join(tmpdir(), 'verify-live-matrix-'));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const adapter = new LiveMatrixAdapter();
  const result = await runLive({
    adapter, repository: 'jayn2u/gods-eye', evidence, prefix: 'agent-qa-live-1000-abcdef',
    poll: { interval: 0, wait: async () => {} },
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.failure));
  assert.deepEqual(Object.keys(result.scenarios), [
    'a_clean', 'b_repeat', 'c_defect', 'd_concurrency', 'e_invalidation', 'f_cancel',
  ]);
  assert.equal(result.scenarios.a_clean.scenarios.length, 6);
  assert.equal(result.scenarios.b_repeat.comment_id, result.scenarios.b_repeat.previous_comment_id);
  assert.ok(result.scenarios.c_defect.findings.length > 0);
  assert.equal(result.scenarios.d_concurrency.serial_timeline.length, 2);
  assert.equal(result.scenarios.e_invalidation.runs.length, 2);
  assert.equal(result.scenarios.f_cancel.conclusion, 'cancelled');
  assert.equal(adapter.branches.size, 0);
  assert.ok([...adapter.pulls.values()].every(({ state }) => state === 'closed'));
  assert.deepEqual(loadRegistry(evidence).branches, []);
  assert.deepEqual(loadRegistry(evidence).pulls, []);
});

for (const [name, options, code] of [
  ['zero surviving QA intervals', { missingAllTimelines: true }, 'qa_timeline_incomplete'],
  ['missing surviving QA interval', { missingTimeline: true }, 'qa_timeline_incomplete'],
  ['mismatched surviving QA job identity', { wrongJobRunId: true }, 'qa_timeline_incomplete'],
  ['overlapping surviving QA intervals', { overlap: true }, 'global_execution_overlap'],
]) {
  test(`scenario D rejects ${name}`, async (t) => {
    const evidence = mkdtempSync(path.join(tmpdir(), 'verify-live-timeline-'));
    t.after(() => rmSync(evidence, { recursive: true, force: true }));
    const result = await runLive({
      adapter: new LiveMatrixAdapter(options), repository: 'jayn2u/gods-eye', evidence,
      prefix: 'agent-qa-live-1000-abcdef', poll: { interval: 0, wait: async () => {} },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.failure.code, code);
    assert.equal(result.cleanup.completed, true);
  });
}

test('accepted-then-lost branch response is reconciled and cleaned from durable intent', async (t) => {
  const evidence = mkdtempSync(path.join(tmpdir(), 'verify-live-branch-loss-'));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const adapter = new LiveMatrixAdapter();
  const original = adapter.createBranch.bind(adapter);
  let count = 0;
  adapter.createBranch = async (name, sha) => {
    const response = await original(name, sha);
    count += 1;
    if (count === 2) throw new LiveVerificationError('transport_lost', 'response lost after acceptance');
    return response;
  };
  const result = await runLive({ adapter, repository: 'jayn2u/gods-eye', evidence,
    prefix: 'agent-qa-live-1000-abcdef', poll: { interval: 0, wait: async () => {} } });
  assert.equal(result.failure.code, 'transport_lost');
  assert.equal(result.cleanup.completed, true);
  assert.equal(adapter.branches.size, 0);
  assert.deepEqual(loadRegistry(evidence).branches, []);
});

test('accepted-then-lost PR response is found by exact marker and closed', async (t) => {
  const evidence = mkdtempSync(path.join(tmpdir(), 'verify-live-pr-loss-'));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const adapter = new LiveMatrixAdapter();
  const original = adapter.createPull.bind(adapter);
  adapter.createPull = async (input) => {
    await original(input);
    throw new LiveVerificationError('transport_lost', 'response lost after PR acceptance');
  };
  const result = await runLive({ adapter, repository: 'jayn2u/gods-eye', evidence,
    prefix: 'agent-qa-live-1000-abcdef', poll: { interval: 0, wait: async () => {} } });
  assert.equal(result.failure.code, 'transport_lost');
  assert.equal(result.cleanup.completed, true);
  assert.ok([...adapter.pulls.values()].every(({ state }) => state === 'closed'));
  assert.deepEqual(loadRegistry(evidence).pulls, []);
});

test('pre-existing branch and PR collisions are never registered or cleaned', async (t) => {
  const evidence = mkdtempSync(path.join(tmpdir(), 'verify-live-collision-'));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const registry = { schema_version: 1, repository: 'jayn2u/gods-eye', prefix: 'agent-qa-live-1000-abcdef',
    branches: [], pulls: [], processes: [] };
  const adapter = new LiveMatrixAdapter();
  const branch = 'agent-qa-live-1000-abcdef-clean';
  adapter.branches.set(branch, 'f'.repeat(40));
  await assert.rejects(createOwnedBranch(adapter, evidence, registry, branch, SHA), /already exists/u);
  const unowned = { number: 88, state: 'open', title: '[agent-qa-live-1000-abcdef] collision',
    body: 'agent-qa-live-1000-abcdef', head: { ref: branch }, base: { ref: 'release/agent-qa-live-1000-abcdef' } };
  adapter.pulls.set(88, unowned);
  await assert.rejects(createOwnedPull(adapter, evidence, registry, {
    title: unowned.title, body: unowned.body, head: branch, base: unowned.base.ref,
  }), /already exists/u);
  assert.deepEqual(registry.branches, []);
  assert.deepEqual(registry.pulls, []);
  assert.equal(unowned.state, 'open');
  assert.equal(adapter.branches.has(branch), true);
});

test('unresolved branch and PR reconciliation errors remain in the durable registry', async () => {
  const prefix = 'agent-qa-live-1000-abcdef';
  const registry = {
    schema_version: 1, repository: 'jayn2u/gods-eye', prefix,
    branches: [{ name: `${prefix}-clean`, expected_sha: SHA, state: 'ambiguous' }],
    pulls: [{ number: null, marker: prefix, title: `[${prefix}] pending`, head: `${prefix}-clean`,
      base: `release/${prefix}`, state: 'ambiguous' }], processes: [],
  };
  const { adapter } = adapterFixture({
    async findPull() { throw new LiveVerificationError('lookup_failed', 'cannot reconcile PR'); },
    async findBranch() { throw new LiveVerificationError('lookup_failed', 'cannot reconcile branch'); },
  });
  const result = await cleanupOwned(adapter, registry);
  assert.equal(result.completed, false);
  assert.equal(registry.pulls[0].last_error, 'lookup_failed');
  assert.equal(registry.branches[0].last_error, 'lookup_failed');
  assert.equal(registry.pulls.length, 1);
  assert.equal(registry.branches.length, 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} stops new work and performs one bounded process-level owned cleanup`, async (t) => {
    const evidence = mkdtempSync(path.join(tmpdir(), 'verify-live-signal-'));
    t.after(() => rmSync(evidence, { recursive: true, force: true }));
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/verify-live-signal.cjs'), evidence], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sent = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!sent && stdout.includes('READY\n')) {
        sent = true;
        child.kill(signal);
        child.kill(signal);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exit = await new Promise((resolve) => child.on('exit', (code, childSignal) => resolve({ code, childSignal })));
    assert.deepEqual(exit, { code: 1, childSignal: null }, stderr);
    const lines = stdout.trim().split('\n');
    assert.equal(lines[0], 'READY');
    const receipt = JSON.parse(lines.at(-1));
    assert.equal(receipt.failure.code, 'interrupted');
    assert.equal(receipt.cleanup.completed, true);
    assert.deepEqual(receipt.remaining_branches, []);
    assert.deepEqual(receipt.open_pulls, []);
    const cleanup = JSON.parse(readFileSync(path.join(evidence, 'cleanup.json')));
    assert.equal(cleanup.actions.filter(({ type }) => type === 'pull').length, 1);
    assert.equal(cleanup.actions.filter(({ type }) => type === 'branch').length, 4);
    assert.deepEqual(loadRegistry(evidence).branches, []);
    assert.deepEqual(loadRegistry(evidence).pulls, []);
  });
}
