'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { crc32, deflateRawSync } = require('node:zlib');

const { admitPullRequest, recheckPullRequest } = require('../controller.cjs');
const { runExecution } = require('../execute.cjs');
const { BOT_LOGIN, publishWorkflowRun } = require('../reporter.cjs');

const workflowRoot = path.resolve(__dirname, '..', '..', 'workflows');
const fixtureRoot = path.join(__dirname, 'fixtures');
const workflowFixtureRoot = path.join(fixtureRoot, 'workflows');
const events = JSON.parse(fs.readFileSync(path.join(workflowFixtureRoot, 'events.json'), 'utf8'));
const evidenceRoot = path.resolve(process.env.QA_WORKFLOW_EVIDENCE
  ?? path.join(process.cwd(), '.omo/evidence/release-pr-agent-qa/task-8'));
const checkout = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
const githubScript = 'actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd';
const uploadArtifact = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const scenarioIds = require('../scenarios.json').scenarios.map(({ id }) => id);

function parseWorkflow(name) {
  const filename = path.join(workflowRoot, name);
  const parsed = spawnSync(
    'ruby',
    ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read, aliases: false))'],
    { encoding: 'utf8', input: fs.readFileSync(filename, 'utf8') },
  );
  assert.equal(parsed.status, 0, `${name}: ${parsed.stderr}`);
  return JSON.parse(parsed.stdout);
}

function runInlineCorrelation(payload) {
  const reporter = parseWorkflow('agent-qa-report.yml');
  const step = reporter.jobs.correlate.steps.find(
    ({ name }) => name === 'Parse the typed trusted run identity',
  );
  assert.ok(step?.with?.script, 'correlation script must be present in the workflow');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gods-eye-inline-correlate-'));
  fs.symlinkSync(path.resolve(__dirname, '..', '..', '..'), path.join(workspace, 'trusted-control'), 'dir');
  const result = spawnSync(
    process.execPath,
    ['-e', `
      const context = { payload: ${JSON.stringify(payload)} };
      const result = { failed: null, outputs: {} };
      const core = {
        setFailed(message) { result.failed = message; },
        setOutput(name, value) { result.outputs[name] = value; },
      };
      (async () => {
        ${step.with.script}
      })().then(
        () => process.stdout.write(JSON.stringify(result)),
        (error) => { process.stderr.write(error.stack || String(error)); process.exitCode = 1; },
      );
    `],
    {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_WORKSPACE: workspace },
    },
  );
  fs.rmSync(workspace, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function stepUses(job, action) {
  return job.steps.filter(({ uses }) => uses === action);
}

function assertWorkflowPolicy(source) {
  assert.doesNotMatch(source, /^permissions:\s*write-all\s*$/mu, 'workflow inherits a write token');
  assert.doesNotMatch(source, /node\s+(?:candidate\/)?\.github\/agent-qa\//u, 'candidate control code is executable');
  assert.doesNotMatch(source, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/u, 'control checkout uses PR source');
  assert.doesNotMatch(source, /persist-credentials:\s*true/u, 'checkout persists a GitHub credential');
}

function admissionGithub(state) {
  return {
    rest: {
      repos: {
        async get() { return { data: structuredClone(state.repository) }; },
        async getCollaboratorPermissionLevel() { return { data: structuredClone(state.permission) }; },
      },
      pulls: { async get() { return { data: structuredClone(state.pull_request) }; } },
    },
  };
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const locals = Buffer.concat(localParts);
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(locals.length, 16);
  return Buffer.concat([locals, directory, end]);
}

async function executeAdmittedRequest(t, request) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gods-eye-workflow-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate');
  const publicEvidence = path.join(root, 'public');
  const requestPath = path.join(root, 'request.json');
  await fsp.mkdir(candidate);
  await fsp.writeFile(requestPath, JSON.stringify(request));
  const order = [];
  const adapters = {
    candidateHead: () => request.head.sha,
    candidateTrackedClean: () => true,
    snapshotTrackedFiles: () => ({ source: 'unchanged' }),
    boundedDiffContext: () => ({ text: 'diff --git a/web/src/App.tsx b/web/src/App.tsx', truncated: false }),
    chromiumVersion: () => 'Chromium 140.0.0',
    runDoctor: async () => ({
      schema_version: 1,
      ok: true,
      phase: 'status',
      checks: [
        { name: 'tool_versions', ok: true, node: process.versions.node, copilot: '0.0.354', playwright_mcp: '0.0.80' },
        { name: 'subscription_auth', ok: true },
        { name: 'browser', ok: true },
        { name: 'auth_lock', ok: true },
      ],
    }),
    startRuntime: async () => ({
      origin: 'http://127.0.0.1:41731',
      supervisor: { runRoot: root, runToDeadline: async () => ({ code: 0, signal: null }) },
      stop: async () => ({ allProcessesStopped: true, processes: [{ outcome: 'stopped' }] }),
    }),
    runBaseline: async () => ({
      name: 'candidate-playwright', status: 'passed', harness_started: true, app_started: true, duration_ms: 12,
    }),
    runAgent: async ({ paths }) => {
      order.push('executor');
      const { faithfulJournalEntries } = require('./fixtures/journal-builder.cjs');
      const entries = faithfulJournalEntries(paths.origin);
      await fsp.writeFile(paths.journal, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
      await fsp.copyFile(path.join(fixtureRoot, 'execution', 'agent-result.json'), paths.privateResult);
      await fsp.mkdir(paths.screenshotsRoot, { recursive: true });
      await Promise.all(scenarioIds.map((id) => fsp.writeFile(path.join(paths.screenshotsRoot, `${id}.png`), png)));
      const privateRoot = path.dirname(paths.privateResult);
      const stdoutPath = path.join(privateRoot, 'copilot.stdout.log');
      const stderrPath = path.join(privateRoot, 'copilot.stderr.log');
      await fsp.writeFile(stdoutPath, 'reported');
      await fsp.writeFile(stderrPath, '');
      return { journalPath: paths.journal, stdoutPath, stderrPath, privateResult: paths.privateResult };
    },
  };
  const result = await runExecution({
    request: requestPath,
    candidate,
    evidence: publicEvidence,
    jobStart: new Date().toISOString(),
  }, adapters);
  return { ...result, publicEvidence, order };
}

function reporterGithub(state, archive) {
  const comments = [];
  const mutations = [];
  const github = {
    rest: {
      actions: {
        async getWorkflowRunAttempt() { return { data: structuredClone(state.workflow_run) }; },
        async listWorkflowRuns() { return { data: { workflow_runs: [structuredClone(state.workflow_run)] } }; },
        async listWorkflowRunArtifacts() {
          return { data: { artifacts: archive ? [{ id: 501, name: 'agent-qa-42-100-1', expired: false, workflow_run: { id: 100 } }] : [] } };
        },
        async downloadArtifact() { return { data: archive }; },
      },
      repos: {
        async get() { return { data: structuredClone(state.repository) }; },
        async getCollaboratorPermissionLevel() { return { data: structuredClone(state.permission) }; },
      },
      pulls: { async get() { return { data: structuredClone(state.pull_request) }; } },
      issues: {
        async listComments() { return { data: structuredClone(comments) }; },
        async createComment({ issue_number: issueNumber, body }) {
          const comment = { id: 9001, user: { login: BOT_LOGIN }, body };
          comments.push(comment);
          mutations.push({ method: 'create', issueNumber, body });
          return { data: structuredClone(comment) };
        },
        async updateComment({ comment_id: commentId, body }) {
          mutations.push({ method: 'update', commentId, body });
          return { data: { id: commentId } };
        },
      },
    },
  };
  return { github, mutations };
}

test('workflow structure preserves trusted boundaries, least privilege, pins, and separate serialization', () => {
  const qa = parseWorkflow('agent-qa.yml');
  const reporter = parseWorkflow('agent-qa-report.yml');
  const trigger = qa.true.pull_request_target;
  assert.deepEqual(trigger.types, [
    'opened', 'synchronize', 'reopened', 'ready_for_review', 'edited', 'converted_to_draft', 'closed',
    'labeled', 'unlabeled',
  ]);
  assert.equal(Object.hasOwn(trigger, 'branches'), false);
  assert.equal(qa['run-name'], 'Agent QA PR #${{ github.event.pull_request.number }} head ${{ github.event.pull_request.head.sha }}');
  assert.deepEqual(qa.permissions, {});
  assert.deepEqual(reporter.permissions, {});
  assert.deepEqual(qa.concurrency, {
    group: 'gods-eye-agent-qa-pr-${{ github.event.pull_request.number }}',
    'cancel-in-progress': true,
  });
  assert.deepEqual(qa.jobs.qa['runs-on'], ['self-hosted', 'linux', 'x64', 'gods-eye-agent-qa']);
  assert.equal(qa.jobs.qa['timeout-minutes'], 15);
  assert.equal(qa.jobs.admission['runs-on'], 'ubuntu-24.04');
  assert.equal(reporter.jobs.correlate['runs-on'], 'ubuntu-24.04');
  assert.equal(reporter.jobs.publish['runs-on'], 'ubuntu-24.04');
  assert.deepEqual(qa.jobs.qa.permissions, { actions: 'read', contents: 'read', 'pull-requests': 'read' });
  assert.deepEqual(reporter.jobs.publish.permissions, { actions: 'read', contents: 'read', 'pull-requests': 'write' });
  assert.deepEqual(qa.jobs.qa.concurrency, {
    group: 'gods-eye-agent-qa-global', 'cancel-in-progress': false, queue: 'max',
  });
  assert.deepEqual(reporter.jobs.publish.concurrency, {
    group: 'gods-eye-agent-qa-report-pr-${{ needs.correlate.outputs.pr_number }}',
    'cancel-in-progress': false,
    queue: 'max',
  });
  const allJobs = [...Object.values(qa.jobs), ...Object.values(reporter.jobs)];
  assert.equal(allJobs.filter((job) => Array.isArray(job['runs-on'])).length, 1);
  assert.equal(allJobs.flatMap((job) => stepUses(job, checkout)).length, 5);
  assert.equal(allJobs.flatMap((job) => stepUses(job, githubScript)).length, 4);
  assert.equal(stepUses(qa.jobs.qa, uploadArtifact).length, 1);
  const trustedCheckouts = allJobs.flatMap((job) => stepUses(job, checkout))
    .filter((step) => step.name !== 'Fetch the candidate through the base repository PR ref');
  assert.equal(trustedCheckouts.length, 4);
  for (const step of trustedCheckouts) {
    assert.equal(step.with.ref, '${{ github.workflow_sha }}');
    assert.equal(step.with['persist-credentials'], false);
  }
  const candidateCheckout = qa.jobs.qa.steps.find((step) => step.name === 'Fetch the candidate through the base repository PR ref');
  assert.equal(candidateCheckout.with.ref, 'refs/pull/${{ github.event.pull_request.number }}/head');
  assert.equal(candidateCheckout.with.path, 'candidate-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.equal(candidateCheckout.with['persist-credentials'], false);
  assert.equal(qa.jobs.qa.steps[0].name, 'Capture the running-job start time');
  const executeStep = qa.jobs.qa.steps.find((step) => step.name === 'Run bounded Copilot browser QA');
  assert.match(executeStep.run, /execute\.cjs" run/u);
  assert.match(executeStep.run, /--job-start "\$JOB_START"/u);
  assert.equal(executeStep.env.CANDIDATE_PATH, '${{ github.workspace }}/candidate-${{ github.run_id }}-${{ github.run_attempt }}');
  // The agent holds a Copilot credential and nothing else: no repository token, no other provider.
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'GOOGLE_API_KEY']) {
    assert.equal(executeStep.env[key], '');
  }
  assert.equal(executeStep.env.QA_COPILOT_TOKEN, '${{ secrets.AGENT_QA_COPILOT_TOKEN }}');
  assert.equal(Object.values(executeStep.env).some((value) => /secrets\.GITHUB_TOKEN/u.test(String(value))), false);
  const upload = qa.jobs.qa.steps.find((step) => step.name === 'Upload validated public evidence');
  assert.equal(upload.if, "always() && steps.stage.outputs.ready == 'true'");
  assert.equal(upload.with['retention-days'], 14);
});

test('parsed workflow dependency environment loads trusted controller modules from the pinned toolchain', async (t) => {
  const qa = parseWorkflow('agent-qa.yml');
  const expectedNodePath = '${{ steps.paths.outputs.qa_root }}/toolchain/node_modules';
  const recheck = qa.jobs.qa.steps.find((step) => step.name === 'Recheck current pull request eligibility');
  const stage = qa.jobs.qa.steps.find((step) => step.name === 'Stage validated public evidence');
  assert.equal(recheck.env.NODE_PATH, expectedNodePath);
  assert.equal(stage.env.NODE_PATH, expectedNodePath);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gods-eye-workflow-dependency-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const trustedRoot = path.join(root, 'trusted-control', '.github', 'agent-qa');
  await fsp.mkdir(trustedRoot, { recursive: true });
  for (const filename of [
    'controller.cjs',
    'contracts.cjs',
    'evidence-contracts.cjs',
    'request.schema.json',
    'agent-result.schema.json',
    'report.schema.json',
  ]) {
    await fsp.copyFile(path.join(workflowRoot, '..', 'agent-qa', filename), path.join(trustedRoot, filename));
  }
  const toolchainModules = path.join(root, 'qa-root', 'toolchain', 'node_modules');
  await fsp.mkdir(toolchainModules, { recursive: true });
  for (const dependency of ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string']) {
    await fsp.cp(
      path.join(workflowRoot, '..', 'agent-qa', 'node_modules', dependency),
      path.join(toolchainModules, dependency),
      { recursive: true },
    );
  }
  assert.equal(fs.existsSync(path.join(root, 'trusted-control', '.github', 'agent-qa', 'node_modules')), false);

  const modulePaths = [
    path.join(trustedRoot, 'controller.cjs'),
    path.join(trustedRoot, 'contracts.cjs'),
  ];
  const requireModules = (nodePath) => spawnSync(
    process.execPath,
    ['-e', `for (const modulePath of ${JSON.stringify(modulePaths)}) require(modulePath);`],
    {
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: nodePath },
    },
  );
  const missingDependency = requireModules('');
  assert.notEqual(missingDependency.status, 0);
  assert.match(`${missingDependency.stdout}${missingDependency.stderr}`, /Cannot find module ['"]ajv\/dist\/2020['"]/u);
  const configuredDependency = requireModules(path.join(root, 'qa-root', 'toolchain', 'node_modules'));
  assert.equal(configuredDependency.status, 0, configuredDependency.stderr);
});

test('inline reporter correlation accepts the actual run identity and rejects forged metadata', () => {
  const reporter = parseWorkflow('agent-qa-report.yml');
  const step = reporter.jobs.correlate.steps.find(
    ({ name }) => name === 'Parse the typed trusted run identity',
  );
  assert.match(step.with.script, /reporter\.parseWorkflowRunIdentity\(run\)/u);
  assert.doesNotMatch(step.with.script, /run\?\.name !== ['"]Agent QA['"]/u);

  const actualRun = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, 'actions-run-identity.json'), 'utf8'),
  ).agent_qa_run;
  const actualPayload = {
    repository: { full_name: 'jayn2u/gods-eye' },
    workflow_run: actualRun,
  };
  const accepted = runInlineCorrelation(actualPayload);
  assert.equal(accepted.failed, null);
  assert.deepEqual(accepted.outputs, { pr_number: '53' });

  for (const [label, target, mutate] of [
    ['name-title mismatch', 'run', (run) => { run.name = 'Agent QA'; }],
    ['forged workflow path', 'run', (run) => { run.path = '.github/workflows/agent-qa.yml.evil'; }],
    ['repository mismatch', 'payload', (payload) => { payload.repository.full_name = 'attacker/repo'; }],
    ['run repository mismatch', 'run', (run) => { run.repository.full_name = 'attacker/repo'; }],
    ['wrong event', 'run', (run) => { run.event = 'pull_request'; }],
    ['wrong status', 'run', (run) => { run.status = 'in_progress'; }],
    ['invalid run id', 'run', (run) => { run.id = 0; }],
    ['invalid run attempt', 'run', (run) => { run.run_attempt = 0; }],
    ['missing workflow run', 'payload', (payload) => { payload.workflow_run = null; }],
  ]) {
    const payload = structuredClone(actualPayload);
    mutate(target === 'payload' ? payload : payload.workflow_run);
    const rejected = runInlineCorrelation(payload);
    assert.ok(rejected.failed, `${label} must be rejected`);
    assert.deepEqual(rejected.outputs, {}, `${label} must not emit a PR number`);
  }
});

test('real admission, recheck, executor, and reporter preserve one typed identity', async (t) => {
  const state = structuredClone(events);
  const github = admissionGithub(state);
  const admitted = await admitPullRequest({ github, ...state.event });
  assert.equal(admitted.status, 'admitted');
  const rechecked = await recheckPullRequest({ github, request: admitted.request });
  assert.equal(rechecked.status, 'admitted');
  const executed = await executeAdmittedRequest(t, admitted.request);
  assert.deepEqual(executed.order, ['executor']);
  assert.equal(executed.report.status, 'no_findings');
  assert.equal(executed.report.tested_head_sha, state.event.eventHeadSha);
  assert.deepEqual(executed.report.request.run, { id: state.event.runId, attempt: state.event.runAttempt });
  const entries = [{ name: 'report.json', data: fs.readFileSync(executed.reportPath) }];
  for (const item of executed.report.evidence) {
    entries.push({ name: item.path, data: fs.readFileSync(path.join(executed.publicEvidence, item.path)) });
  }
  const publication = reporterGithub(state, zip(entries));
  const outcome = await publishWorkflowRun({
    github: publication.github,
    workflowRun: state.workflow_run,
    repository: state.repository.full_name,
  });
  assert.equal(outcome.status, 'published');
  assert.equal(outcome.reportStatus, 'no_findings');
  assert.equal(publication.mutations.length, 1);
  assert.match(publication.mutations[0].body, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/u);
  await fsp.mkdir(evidenceRoot, { recursive: true });
  await fsp.writeFile(path.join(evidenceRoot, 'workflow-contracts.txt'), [
    'scenario=eligible metadata -> admission -> recheck -> executor -> reporter',
    `request_head=${executed.report.tested_head_sha}`,
    `request_run=${executed.report.request.run.id}/${executed.report.request.run.attempt}`,
    `executor_invocations=${executed.order.length}`,
    `report_status=${executed.report.status}`,
    `comment_mutations=${publication.mutations.length}`,
    `publication_status=${outcome.status}/${outcome.reportStatus}`,
  ].join('\n') + '\n');
});

test('ineligible metadata never reaches candidate execution and missing cancelled output publishes honestly', async () => {
  const observed = [];
  for (const [name, mutate, reason] of [
    ['draft', (state) => { state.pull_request.draft = true; }, 'pull_request_draft'],
    ['develop', (state) => { state.pull_request.base.ref = 'develop'; }, 'qa_not_requested'],
    ['develop with an unrelated label', (state) => {
      state.pull_request.base.ref = 'develop';
      state.pull_request.labels = [{ name: 'documentation' }];
    }, 'qa_not_requested'],
    ['permission', (state) => { state.permission.permission = 'read'; }, 'permission_insufficient'],
  ]) {
    const state = structuredClone(events);
    mutate(state);
    let executorInvocations = 0;
    const decision = await admitPullRequest({ github: admissionGithub(state), ...state.event });
    if (decision.status === 'admitted') executorInvocations += 1;
    assert.equal(decision.status, 'skipped', name);
    assert.equal(decision.reason, reason, name);
    assert.equal(executorInvocations, 0, name);
    observed.push({ scenario: name, admission: decision.status, reason, executor_invocations: executorInvocations });
  }
  const cancelled = structuredClone(events);
  cancelled.workflow_run.conclusion = 'cancelled';
  const publication = reporterGithub(cancelled, null);
  const outcome = await publishWorkflowRun({ github: publication.github, workflowRun: cancelled.workflow_run });
  assert.equal(outcome.status, 'published');
  assert.equal(outcome.reportStatus, 'cancelled');
  assert.equal(publication.mutations.length, 1);
  observed.push({ scenario: 'cancelled_missing_artifact', publication: outcome.status, report_status: outcome.reportStatus, comment_mutations: 1 });
  await fsp.mkdir(evidenceRoot, { recursive: true });
  await fsp.writeFile(path.join(evidenceRoot, 'negative-contracts.json'), `${JSON.stringify(observed, null, 2)}\n`);
});

test('workflow policy rejects inherited write tokens and PR-sourced control code', () => {
  assertWorkflowPolicy(fs.readFileSync(path.join(workflowRoot, 'agent-qa.yml'), 'utf8'));
  for (const fixture of ['unsafe-write-token.yml', 'unsafe-pr-control.yml']) {
    assert.throws(
      () => assertWorkflowPolicy(fs.readFileSync(path.join(workflowFixtureRoot, fixture), 'utf8')),
      /inherits a write token|candidate control code|control checkout uses PR source|persists a GitHub credential/u,
      fixture,
    );
  }
});
