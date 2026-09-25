#!/usr/bin/env node
'use strict';

const { createHash, randomBytes } = require('node:crypto');
const {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { SCENARIO_IDS, validateReport } = require('./contracts.cjs');
const {
  BOT_LOGIN, COMMENT_MARKER, WORKFLOW_PATH, inspectArtifactZip, parseWorkflowRunIdentity,
} = require('./reporter.cjs');

const EXPECTED_REPOSITORY = 'jayn2u/gods-eye';
const DEFAULT_BRANCH = 'develop';
const QA_WORKFLOW_FILE = 'agent-qa.yml';
const REPORT_WORKFLOW_FILE = 'agent-qa-report.yml';
const RUNNER_NAME = 'gods-eye-agent-qa';
const MAX_PAGES = 20;
const POLL_MS = 10_000;
const RUN_TIMEOUT_MS = 20 * 60_000;
const COMMENT_TIMEOUT_MS = 5 * 60_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TERMINAL = new Set(['completed']);

class LiveVerificationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LiveVerificationError';
    this.code = code;
    this.details = details;
  }
}

function usage() {
  return 'Usage: node .github/agent-qa/verify-live.cjs --repo jayn2u/gods-eye --evidence <path>';
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) throw new LiveVerificationError('invalid_arguments', usage());
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--repo', '--evidence'].includes(flag) || values.has(flag) || !value || value.startsWith('--')) {
      throw new LiveVerificationError('invalid_arguments', usage());
    }
    values.set(flag, value);
  }
  if (values.get('--repo') !== EXPECTED_REPOSITORY) {
    throw new LiveVerificationError('invalid_repository', `--repo must be ${EXPECTED_REPOSITORY}`);
  }
  return Object.freeze({ repository: EXPECTED_REPOSITORY, evidence: path.resolve(values.get('--evidence')) });
}

function redactError(value) {
  return String(value || '')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,})\b/gu, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, 'Bearer [redacted]')
    .slice(0, 500);
}

function runCommand(binary, args, options = {}) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new LiveVerificationError('invalid_command', 'command arguments must be a string array');
  }
  const result = spawnSync(binary, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: options.binary ? null : 'utf8',
    maxBuffer: options.maxBuffer || 110 * 1024 * 1024,
    timeout: options.timeout || 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new LiveVerificationError(
      options.code || 'command_failed',
      `${path.basename(binary)} failed`,
      { status: result.status, message: redactError(result.error?.message || result.stderr) },
    );
  }
  return result.stdout;
}

function parseJson(value, code) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new LiveVerificationError(code, 'command returned malformed JSON', { message: error.message });
  }
}

class GhAdapter {
  constructor({ repository = EXPECTED_REPOSITORY, gh = 'gh', command = runCommand } = {}) {
    this.repository = repository;
    this.gh = gh;
    this.command = command;
    [this.owner, this.repo] = repository.split('/');
  }

  ghCall(args, options = {}) {
    return this.command(this.gh, args, { ...options, code: options.code || 'github_cli_failed' });
  }

  api(endpoint, { method = 'GET', fields = {}, jsonBody, binary = false } = {}) {
    const args = ['api', endpoint, '--method', method];
    let input;
    if (jsonBody !== undefined) {
      args.push('--input', '-');
      input = JSON.stringify(jsonBody);
    } else {
      for (const [key, value] of Object.entries(fields)) {
        args.push('-f', `${key}=${String(value)}`);
      }
    }
    const output = this.ghCall(args, { binary, input });
    if (binary) return output;
    if (String(output).trim() === '') return null;
    return parseJson(output, 'github_json_invalid');
  }

  async authStatus() {
    try {
      this.ghCall(['auth', 'status', '--hostname', 'github.com']);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.code };
    }
  }

  async repositoryMetadata() {
    return this.api(`repos/${this.repository}`);
  }

  async defaultRef(branch) {
    return this.api(`repos/${this.repository}/git/ref/heads/${encodeURIComponent(branch)}`);
  }

  async workflows() {
    return this.paginate(`repos/${this.repository}/actions/workflows`, 'workflows');
  }

  async runners() {
    return this.paginate(`repos/${this.repository}/actions/runners`, 'runners');
  }

  async requiredChecks(branch) {
    try {
      const value = this.api(`repos/${this.repository}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`);
      return { observable: true, source: 'classic_branch_protection', contexts: value.contexts || [], checks: value.checks || [] };
    } catch (error) {
      if (!/HTTP 404/iu.test(error.details?.message || '')) {
        return { observable: false, source: null, contexts: [], checks: [], reason: 'branch_protection_unavailable' };
      }
      try {
        const summaries = this.api(`repos/${this.repository}/rulesets?includes_parents=true`);
        if (!Array.isArray(summaries)) throw new Error('malformed ruleset list');
        const contexts = [];
        for (const summary of summaries.filter(({ enforcement }) => enforcement === 'active')) {
          const ruleset = this.api(`repos/${this.repository}/rulesets/${summary.id}`);
          for (const rule of ruleset?.rules || []) {
            if (rule.type === 'required_status_checks') {
              contexts.push(...(rule.parameters?.required_status_checks || []).map(({ context }) => context));
            }
          }
        }
        return { observable: true, source: 'repository_rulesets', contexts, checks: [] };
      } catch {
        return { observable: false, source: null, contexts: [], checks: [], reason: 'branch_protection_and_rulesets_unavailable' };
      }
    }
  }

  async trustedBlob(pathname, ref) {
    try {
      return this.api(`repos/${this.repository}/contents/${pathname}?ref=${encodeURIComponent(ref)}`);
    } catch {
      return null;
    }
  }

  async localBlobSha(pathname) {
    return String(runCommand('git', ['hash-object', pathname], { cwd: path.resolve(__dirname, '../..') })).trim();
  }

  async doctor() {
    const doctorPath = path.join(__dirname, 'doctor.cjs');
    const result = spawnSync(process.execPath, [doctorPath, '--json'], {
      encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 60_000,
    });
    let report = null;
    try { report = JSON.parse(result.stdout); } catch { /* fail closed below */ }
    return { ok: result.status === 0 && report?.ok === true, report };
  }

  async paginate(endpoint, property) {
    const values = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const join = endpoint.includes('?') ? '&' : '?';
      const response = this.api(`${endpoint}${join}per_page=100&page=${page}`);
      const pageValues = Array.isArray(response) ? response : response?.[property];
      if (!Array.isArray(pageValues)) throw new LiveVerificationError('github_page_invalid', `missing ${property} page`);
      values.push(...pageValues);
      if (pageValues.length < 100) return values;
    }
    throw new LiveVerificationError('github_pagination_limit', `${property} exceeded ${MAX_PAGES} pages`);
  }

  async createBranch(name, sha) {
    return this.api(`repos/${this.repository}/git/refs`, {
      method: 'POST', jsonBody: { ref: `refs/heads/${name}`, sha },
    });
  }

  async findBranch(name) {
    try {
      return this.api(`repos/${this.repository}/git/ref/heads/${encodeURIComponent(name)}`);
    } catch (error) {
      if (/HTTP 404/iu.test(error.details?.message || '')) return null;
      throw error;
    }
  }

  async deleteBranch(name) {
    this.api(`repos/${this.repository}/git/refs/heads/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  async createPull({ title, head, base, body }) {
    return this.api(`repos/${this.repository}/pulls`, {
      method: 'POST', jsonBody: { title, head, base, body, draft: false },
    });
  }

  async getPull(number) {
    try {
      return this.api(`repos/${this.repository}/pulls/${number}`);
    } catch (error) {
      if (/HTTP 404/iu.test(error.details?.message || '')) return null;
      throw error;
    }
  }

  async findPull(resource) {
    const pulls = await this.paginate(
      `repos/${this.repository}/pulls?state=all&head=${this.owner}%3A${encodeURIComponent(resource.head)}`,
      'items',
    );
    const matches = pulls.filter((pull) => pull.title === resource.title
      && pull.head?.ref === resource.head && pull.base?.ref === resource.base
      && typeof pull.body === 'string' && pull.body.includes(resource.marker));
    if (matches.length > 1) throw new LiveVerificationError('pull_reconciliation_ambiguous', 'multiple exact owned pull requests found');
    return matches[0] || null;
  }

  async updatePull(number, fields) {
    return this.api(`repos/${this.repository}/pulls/${number}`, { method: 'PATCH', jsonBody: fields });
  }

  async convertToDraft(nodeId) {
    const query = 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id isDraft}}}';
    return this.api('graphql', { method: 'POST', fields: { query, id: nodeId } });
  }

  async closePull(number) {
    return this.updatePull(number, { state: 'closed' });
  }

  async commit({ branch, message, file }) {
    const ref = await this.api(`repos/${this.repository}/git/ref/heads/${encodeURIComponent(branch)}`);
    const parentSha = ref.object.sha;
    const parent = await this.api(`repos/${this.repository}/git/commits/${parentSha}`);
    let treeSha = parent.tree.sha;
    if (file) {
      const blob = await this.api(`repos/${this.repository}/git/blobs`, {
        method: 'POST', jsonBody: { content: Buffer.from(file.contents).toString('base64'), encoding: 'base64' },
      });
      const tree = await this.api(`repos/${this.repository}/git/trees`, {
        method: 'POST',
        jsonBody: {
          base_tree: treeSha,
          tree: [{ path: file.path, mode: '100644', type: 'blob', sha: blob.sha }],
        },
      });
      treeSha = tree.sha;
    }
    const commit = await this.api(`repos/${this.repository}/git/commits`, {
      method: 'POST', jsonBody: { message, tree: treeSha, parents: [parentSha] },
    });
    await this.api(`repos/${this.repository}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH', jsonBody: { sha: commit.sha, force: false },
    });
    return commit.sha;
  }

  async file(pathname, ref) {
    const value = await this.api(`repos/${this.repository}/contents/${pathname}?ref=${encodeURIComponent(ref)}`);
    return Buffer.from(String(value.content || '').replaceAll('\n', ''), 'base64').toString('utf8');
  }

  async workflowRuns() {
    return this.paginate(`repos/${this.repository}/actions/workflows/${QA_WORKFLOW_FILE}/runs?event=pull_request_target`, 'workflow_runs');
  }

  async jobs(runId, attempt = 1) {
    return this.paginate(`repos/${this.repository}/actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs');
  }

  async artifacts(runId) {
    return this.paginate(`repos/${this.repository}/actions/runs/${runId}/artifacts`, 'artifacts');
  }

  async downloadArtifact(artifactId) {
    return this.api(`repos/${this.repository}/actions/artifacts/${artifactId}/zip`, { binary: true });
  }

  async comments(prNumber) {
    return this.paginate(`repos/${this.repository}/issues/${prNumber}/comments`, 'items');
  }

  async cancelRun(runId) {
    return this.api(`repos/${this.repository}/actions/runs/${runId}/cancel`, { method: 'POST' });
  }
}

function checkDoctor(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const named = Object.fromEntries(checks.map((check) => [check.name, check]));
  return {
    ok: report?.ok === true,
    subscription_auth: named.subscription_auth?.ok === true,
    runner_service: named.runner_service?.ok === true,
    tool_versions: named.tool_versions?.ok === true,
    browser: named.browser?.ok === true,
    api_environment_absent: named.subscription_auth?.api_environment_present === false,
  };
}

async function preflight(adapter) {
  const checks = [];
  const missing = [];
  const add = (name, ok, observable, reason) => {
    checks.push({ name, ok, observable });
    if (!ok) missing.push(reason || name);
  };
  const auth = await adapter.authStatus();
  add('github_auth', auth.ok === true, { authenticated: auth.ok === true }, 'github_cli_authentication_required');
  if (!auth.ok) return { ok: false, checks, missing };

  const repo = await adapter.repositoryMetadata();
  const defaultRef = await adapter.defaultRef(DEFAULT_BRANCH);
  const defaultSha = defaultRef?.object?.sha;
  add('private_repository', repo.full_name === EXPECTED_REPOSITORY && repo.private === true,
    { full_name: repo.full_name, private: repo.private }, 'expected_private_repository_unavailable');
  add('default_branch', repo.default_branch === DEFAULT_BRANCH,
    { default_branch: repo.default_branch, sha: SHA_PATTERN.test(defaultSha || '') ? defaultSha : null },
    'default_branch_is_not_develop');
  add('default_branch_head', SHA_PATTERN.test(defaultSha || ''),
    { sha: SHA_PATTERN.test(defaultSha || '') ? defaultSha : null }, 'default_branch_head_invalid');

  const workflows = await adapter.workflows();
  for (const file of [QA_WORKFLOW_FILE, REPORT_WORKFLOW_FILE]) {
    const workflow = workflows.find((item) => item.path === `.github/workflows/${file}`);
    add(`workflow_${file}`, workflow?.state === 'active',
      { present: Boolean(workflow), state: workflow?.state || null, id: workflow?.id || null },
      `default_branch_${file}_not_active`);
  }

  const trustedPaths = [
    '.github/agent-qa/verify-live.cjs', '.github/agent-qa/controller.cjs',
    '.github/agent-qa/reporter.cjs', '.github/agent-qa/contracts.cjs',
  ];
  for (const pathname of trustedPaths) {
    const blob = await adapter.trustedBlob(pathname, DEFAULT_BRANCH);
    const localSha = blob?.sha ? await adapter.localBlobSha(pathname) : null;
    add(`trusted_${path.basename(pathname)}`, Boolean(blob?.sha) && blob.sha === localSha,
      { present: Boolean(blob?.sha), default_blob_sha: blob?.sha || null, local_blob_sha: localSha },
      blob?.sha ? `local_${pathname}_does_not_match_default` : `default_branch_missing_${pathname}`);
  }

  const runners = await adapter.runners();
  const namedRunners = runners.filter((runner) => runner.name === RUNNER_NAME);
  const runner = namedRunners[0];
  const labels = new Set((runner?.labels || []).map((label) => label.name));
  const runnerReady = namedRunners.length === 1 && runner.status === 'online'
    && ['self-hosted', 'Linux', 'X64', RUNNER_NAME].every((label) => labels.has(label));
  add('runner', runnerReady, {
    exact_count: namedRunners.length, status: runner?.status || null, busy: runner?.busy ?? null,
    labels: [...labels].sort(),
  }, namedRunners.length === 0 ? 'runner_provisioning_required' : 'runner_not_online_with_exact_labels');

  const doctorResult = await adapter.doctor();
  const doctor = checkDoctor(doctorResult.report);
  add('runner_doctor', doctorResult.ok && doctor.ok, doctor,
    doctor.subscription_auth ? 'runner_doctor_not_ready' : 'ci_subscription_login_required');

  const required = await adapter.requiredChecks(DEFAULT_BRANCH);
  const requiredNames = [
    ...(required.contexts || []), ...(required.checks || []).map((check) => check.context),
  ];
  add('advisory_not_required', required.observable === true
    && !requiredNames.some((name) => /Agent QA/iu.test(name)), {
    observable: required.observable, required_names: requiredNames.sort(), reason: required.reason || null,
    source: required.source || null,
  }, required.observable ? 'agent_qa_is_a_required_check' : 'required_checks_not_observable');

  return { ok: missing.length === 0, checks, missing, repository: {
    full_name: repo.full_name, private: repo.private, default_branch: repo.default_branch,
    default_branch_sha: defaultSha,
  } };
}

function ownedRegistry(prefix) {
  return { schema_version: 1, repository: EXPECTED_REPOSITORY, prefix, branches: [], pulls: [], processes: [] };
}

function registryPath(evidenceRoot) {
  return path.join(evidenceRoot, 'cleanup-registry.json');
}

function validateRegistry(value) {
  if (!value || value.schema_version !== 1 || value.repository !== EXPECTED_REPOSITORY
      || typeof value.prefix !== 'string' || !/^agent-qa-live-[0-9]+-[0-9a-f]{6}$/u.test(value.prefix)
      || !Array.isArray(value.branches) || !Array.isArray(value.pulls) || !Array.isArray(value.processes)
      || value.processes.length !== 0
      || value.branches.some(({ name, state }) => typeof name !== 'string'
        || (name !== `release/${value.prefix}` && !name.startsWith(`${value.prefix}-`))
        || !['intent', 'created', 'ambiguous'].includes(state))
      || value.pulls.some(({ number, marker, head, base, title, state }) => (
        (number !== null && (!Number.isSafeInteger(number) || number < 1))
        || typeof marker !== 'string' || marker !== value.prefix
        || typeof head !== 'string' || !head.startsWith(`${value.prefix}-`)
        || base !== `release/${value.prefix}` || typeof title !== 'string'
        || !title.includes(value.prefix) || !['intent', 'created', 'ambiguous'].includes(state)
      ))) {
    throw new LiveVerificationError('cleanup_registry_invalid', 'refusing an invalid or non-owned cleanup registry');
  }
  return value;
}

function persistRegistry(evidenceRoot, registry) {
  writeFileSync(registryPath(evidenceRoot), `${JSON.stringify(validateRegistry(registry), null, 2)}\n`, { mode: 0o600 });
}

function loadRegistry(evidenceRoot) {
  try {
    return validateRegistry(JSON.parse(readFileSync(registryPath(evidenceRoot), 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof LiveVerificationError) throw error;
    throw new LiveVerificationError('cleanup_registry_invalid', 'cleanup registry is unreadable or malformed');
  }
}

function matchingRun(run, prNumber, headSha) {
  const identity = parseWorkflowRunIdentity(run);
  return run?.repository?.full_name === EXPECTED_REPOSITORY
    && run?.path === WORKFLOW_PATH
    && run?.event === 'pull_request_target'
    && identity?.prNumber === prNumber && identity?.headSha === headSha;
}

async function poll(probe, accept, {
  timeout = RUN_TIMEOUT_MS, interval = POLL_MS, now = Date.now, wait, signal,
} = {}) {
  const deadline = now() + timeout;
  const pause = wait || ((milliseconds) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new LiveVerificationError('interrupted', 'live verification interrupted'));
    }, { once: true });
  }));
  while (now() <= deadline) {
    if (signal?.aborted) throw signal.reason || new LiveVerificationError('interrupted', 'live verification interrupted');
    const value = await probe();
    if (accept(value)) return value;
    await pause(interval);
  }
  throw new LiveVerificationError('poll_timeout', 'live GitHub observable did not reach the required state');
}

async function waitForRun(adapter, prNumber, headSha, predicate = (run) => TERMINAL.has(run.status), options) {
  return poll(async () => {
    const runs = (await adapter.workflowRuns()).filter((run) => matchingRun(run, prNumber, headSha));
    return runs.sort((left, right) => (right.id - left.id) || (right.run_attempt - left.run_attempt))[0] || null;
  }, (run) => Boolean(run && predicate(run)), options);
}

async function managedComment(adapter, prNumber, predicate = () => true, options) {
  return poll(async () => {
    const comments = await adapter.comments(prNumber);
    const managed = comments.filter((comment) => comment.user?.login === BOT_LOGIN
      && typeof comment.body === 'string' && comment.body.includes(COMMENT_MARKER));
    if (managed.length > 1) throw new LiveVerificationError('multiple_managed_comments', 'more than one Agent QA bot comment exists');
    return managed[0] || null;
  }, (comment) => Boolean(comment && predicate(comment)), { timeout: COMMENT_TIMEOUT_MS, ...options });
}

function inspectPng(contents, expected) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  if (contents.length < 33 || !contents.subarray(0, 8).equals(signature)
      || contents.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new LiveVerificationError('invalid_png', `invalid screenshot ${expected.path}`);
  }
  const sha256 = createHash('sha256').update(contents).digest('hex');
  if (sha256 !== expected.sha256 || contents.length !== expected.size_bytes) {
    throw new LiveVerificationError('screenshot_metadata_mismatch', `screenshot metadata mismatch for ${expected.path}`);
  }
  const width = contents.readUInt32BE(16);
  const height = contents.readUInt32BE(20);
  if (width < 320 || height < 240) throw new LiveVerificationError('screenshot_dimensions_invalid', `${expected.path} is too small`);
  return { path: expected.path, size_bytes: contents.length, sha256, width, height };
}

function extractZipEntry(archive, entryName) {
  const root = mkdtempSync(path.join(tmpdir(), 'gods-eye-live-artifact-'));
  try {
    const archivePath = path.join(root, 'artifact.zip');
    writeFileSync(archivePath, archive, { mode: 0o600 });
    return runCommand('unzip', ['-p', archivePath, entryName], { binary: true, code: 'artifact_extract_failed' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function inspectRunEvidence(adapter, run, pr, evidenceRoot, expectedStatus) {
  const artifacts = (await adapter.artifacts(run.id)).filter((artifact) => (
    artifact.name === `agent-qa-${pr.number}-${run.id}-${run.run_attempt}`
    && artifact.expired === false && artifact.workflow_run?.id === run.id
  ));
  if (artifacts.length !== 1) throw new LiveVerificationError('artifact_identity_invalid', 'expected one exact non-expired artifact');
  const archive = await adapter.downloadArtifact(artifacts[0].id);
  const inspected = inspectArtifactZip(archive);
  const report = validateReport(inspected.report, inspected.report.request);
  if (report.request.pr_number !== pr.number || report.tested_head_sha !== pr.head.sha
      || report.request.run.id !== run.id || report.request.run.attempt !== run.run_attempt
      || report.controller_sha !== run.head_sha
      || report.status !== expectedStatus) {
    throw new LiveVerificationError('report_identity_invalid', 'report does not match authoritative PR/run/status');
  }
  if (new Set(report.scenarios.map(({ id }) => id)).size !== SCENARIO_IDS.length
      || SCENARIO_IDS.some((id) => !report.scenarios.some((scenario) => scenario.id === id))) {
    throw new LiveVerificationError('scenario_matrix_incomplete', 'report does not contain the exact six scenarios');
  }
  const screenshots = [];
  for (const entry of report.evidence.filter(({ kind }) => kind === 'screenshot')) {
    const contents = extractZipEntry(archive, entry.path);
    const metadata = inspectPng(contents, entry);
    const destination = path.join(evidenceRoot, 'screenshots', `${run.id}-${path.basename(entry.path)}`);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, contents, { mode: 0o600 });
    screenshots.push({ ...metadata, captured_path: destination });
  }
  const screenshotPaths = new Set(report.evidence.filter(({ kind }) => kind === 'screenshot').map(({ path: p }) => p));
  for (const scenario of report.scenarios) {
    const calls = report.tool_calls.filter((call) => call.scenario_id === scenario.id && call.status === 'completed');
    if (!calls.some(({ tool }) => tool === 'browser_navigate')
      || !calls.some(({ tool }) => ['browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key'].includes(tool))
      || !calls.some(({ tool, evidence }) => tool === 'browser_take_screenshot' && screenshotPaths.has(evidence))) {
      throw new LiveVerificationError('tool_ledger_incomplete', `scenario ${scenario.id} lacks browser tool evidence`);
    }
  }
  return {
    run: { id: run.id, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion },
    head_sha: report.tested_head_sha,
    report_status: report.status,
    scenarios: report.scenarios.map(({ id, status, evidence }) => ({ id, status, evidence })),
    findings: report.findings,
    tool_calls: report.tool_calls,
    screenshots,
    artifact: { id: artifacts[0].id, name: artifacts[0].name },
    timeline: { started_at: report.started_at, finished_at: report.finished_at },
  };
}

async function cleanupOwned(adapter, registry, { deadlineMs = 2 * 60_000, now = Date.now } = {}) {
  const actions = [];
  const deadline = now() + deadlineMs;
  for (const pull of [...registry.pulls].reverse()) {
    if (now() > deadline) {
      pull.state = 'ambiguous';
      pull.last_error = 'cleanup_deadline';
      actions.push({ type: 'pull', number: pull.number, final_state: 'unknown', ok: false, reason: 'cleanup_deadline' });
      continue;
    }
    try {
      const remote = pull.number === null ? await adapter.findPull(pull) : await adapter.getPull(pull.number);
      if (remote && pull.state !== 'created' && (remote.title !== pull.title || remote.head?.ref !== pull.head
        || remote.base?.ref !== pull.base || typeof remote.body !== 'string'
        || !remote.body.includes(pull.marker))) {
        throw new LiveVerificationError('ownership_mismatch', `pull ${remote.number} no longer matches its registry identity`);
      }
      if (remote?.state === 'open') await adapter.closePull(remote.number);
      actions.push({ type: 'pull', number: remote?.number || pull.number, marker: pull.marker,
        final_state: remote ? 'closed' : 'absent', ok: true });
      registry.pulls.splice(registry.pulls.indexOf(pull), 1);
    } catch (error) {
      pull.state = 'ambiguous';
      pull.last_error = error.code || 'cleanup_failed';
      actions.push({ type: 'pull', number: pull.number, marker: pull.marker,
        final_state: 'unknown', ok: false, reason: pull.last_error });
    }
  }
  for (const branch of [...registry.branches].reverse()) {
    if (now() > deadline) {
      branch.state = 'ambiguous';
      branch.last_error = 'cleanup_deadline';
      actions.push({ type: 'branch', name: branch.name, final_state: 'unknown', ok: false, reason: 'cleanup_deadline' });
      continue;
    }
    try {
      const remote = await adapter.findBranch(branch.name);
      if (remote && branch.state !== 'created' && remote.object?.sha !== branch.expected_sha) {
        throw new LiveVerificationError('ownership_mismatch', `branch ${branch.name} no longer points to its registered SHA`);
      }
      if (remote) await adapter.deleteBranch(branch.name);
      actions.push({ type: 'branch', name: branch.name, final_state: remote ? 'deleted' : 'absent', ok: true });
      registry.branches.splice(registry.branches.indexOf(branch), 1);
    } catch (error) {
      branch.state = 'ambiguous';
      branch.last_error = error.code || 'cleanup_failed';
      actions.push({ type: 'branch', name: branch.name, final_state: 'unknown', ok: false, reason: branch.last_error });
    }
  }
  return { attempted: true, completed: actions.every(({ ok }) => ok), actions, processes: registry.processes };
}

function ensureActive(signal) {
  if (signal?.aborted) throw signal.reason || new LiveVerificationError('interrupted', 'live verification interrupted');
}

async function createOwnedBranch(adapter, evidenceRoot, registry, name, sha, signal) {
  ensureActive(signal);
  if (await adapter.findBranch(name)) throw new LiveVerificationError('resource_collision', `branch ${name} already exists`);
  const resource = { name, expected_sha: sha, state: 'intent' };
  registry.branches.push(resource);
  persistRegistry(evidenceRoot, registry);
  try {
    const created = await adapter.createBranch(name, sha);
    if (created?.ref !== `refs/heads/${name}` || created?.object?.sha !== sha) {
      throw new LiveVerificationError('branch_create_response_invalid', `branch ${name} response did not match intent`);
    }
    resource.state = 'created';
    persistRegistry(evidenceRoot, registry);
    return created;
  } catch (error) {
    resource.state = 'ambiguous';
    resource.last_error = error.code || 'branch_create_failed';
    persistRegistry(evidenceRoot, registry);
    throw error;
  }
}

async function createOwnedPull(adapter, evidenceRoot, registry, input, signal) {
  ensureActive(signal);
  const resource = { number: null, marker: registry.prefix, title: input.title,
    head: input.head, base: input.base, state: 'intent' };
  if (await adapter.findPull(resource)) throw new LiveVerificationError('resource_collision', `pull marker ${registry.prefix} already exists`);
  registry.pulls.push(resource);
  persistRegistry(evidenceRoot, registry);
  try {
    const created = await adapter.createPull(input);
    if (!Number.isSafeInteger(created?.number) || created.number < 1 || created.title !== input.title
      || created.head?.ref !== input.head || created.base?.ref !== input.base
      || typeof created.body !== 'string' || !created.body.includes(registry.prefix)) {
      throw new LiveVerificationError('pull_create_response_invalid', 'pull response did not match owned intent');
    }
    resource.number = created.number;
    resource.state = 'created';
    persistRegistry(evidenceRoot, registry);
    return created;
  } catch (error) {
    resource.state = 'ambiguous';
    resource.last_error = error.code || 'pull_create_failed';
    persistRegistry(evidenceRoot, registry);
    throw error;
  }
}

function branchNames(prefix) {
  return {
    base: `release/${prefix}`, clean: `${prefix}-clean`, other: `${prefix}-other`, cancel: `${prefix}-cancel`,
  };
}

function defectSource(source) {
  const original = '<button className="primary" disabled={props.selectedModel?.ready !== true}>Search gallery';
  const replacement = '<button className="primary" disabled={true}>Search gallery';
  if (!source.includes(original) || source.includes(replacement)) {
    throw new LiveVerificationError('defect_anchor_missing', 'temporary disabled-search defect anchor was not exact');
  }
  return source.replace(original, replacement);
}

async function executeMatrix(adapter, repo, evidenceRoot, registry, options = {}) {
  const scenarios = {};
  const names = branchNames(registry.prefix);
  for (const name of Object.values(names)) {
    await createOwnedBranch(adapter, evidenceRoot, registry, name, repo.default_branch_sha, options.signal);
  }
  const makePull = async (branch, suffix) => {
    ensureActive(options.signal);
    await adapter.commit({ branch, message: `Agent QA live: initialize ${suffix}` });
    const input = {
      title: `[Agent QA live ${registry.prefix}] ${suffix}`,
      head: branch, base: names.base,
      body: `Disposable Agent QA validation resource ${registry.prefix}. Never merge.`,
    };
    return createOwnedPull(adapter, evidenceRoot, registry, input, options.signal);
  };

  const cleanPr = await makePull(names.clean, 'clean and defect lifecycle');
  const cleanRun = await waitForRun(adapter, cleanPr.number, cleanPr.head.sha, undefined, options.poll);
  const cleanProof = await inspectRunEvidence(adapter, cleanRun, cleanPr, evidenceRoot, 'no_findings');
  const cleanComment = await managedComment(adapter, cleanPr.number,
    (comment) => comment.body.includes(cleanPr.head.sha) && comment.body.includes(`/runs/${cleanRun.id}/`), options.poll);
  scenarios.a_clean = { ...cleanProof, pr: cleanPr.number, comment_id: cleanComment.id };

  ensureActive(options.signal);
  const secondSha = await adapter.commit({ branch: names.clean, message: 'Agent QA live: repeat clean generation' });
  cleanPr.head.sha = secondSha;
  const repeatRun = await waitForRun(adapter, cleanPr.number, secondSha, undefined, options.poll);
  const repeatProof = await inspectRunEvidence(adapter, repeatRun, cleanPr, evidenceRoot, 'no_findings');
  const repeatComment = await managedComment(adapter, cleanPr.number,
    (comment) => comment.body.includes(secondSha) && comment.body.includes(`/runs/${repeatRun.id}/`), options.poll);
  if (repeatComment.id !== cleanComment.id) throw new LiveVerificationError('comment_not_upserted', 'new generation did not update the same comment');
  scenarios.b_repeat = { ...repeatProof, pr: cleanPr.number, comment_id: repeatComment.id,
    previous_comment_id: cleanComment.id };

  ensureActive(options.signal);
  const source = await adapter.file('web/src/screens.tsx', names.clean);
  const defectSha = await adapter.commit({
    branch: names.clean, message: 'Agent QA live: intentionally disable search submit',
    file: { path: 'web/src/screens.tsx', contents: defectSource(source) },
  });
  cleanPr.head.sha = defectSha;
  const defectRun = await waitForRun(adapter, cleanPr.number, defectSha, undefined, options.poll);
  const defectProof = await inspectRunEvidence(adapter, defectRun, cleanPr, evidenceRoot, 'findings');
  if (defectProof.findings.length === 0 || defectProof.screenshots.length === 0) {
    throw new LiveVerificationError('defect_not_observed', 'disabled submit defect lacks a finding and screenshot');
  }
  scenarios.c_defect = { ...defectProof, pr: cleanPr.number, injected_sha: defectSha,
    injection: { path: 'web/src/screens.tsx', replacement: 'disabled={true}' } };

  const otherPr = await makePull(names.other, 'global queue witness');
  const cancelPr = await makePull(names.cancel, 'same PR supersession witness');
  const oldCancelSha = cancelPr.head.sha;
  const oldCancelRun = await waitForRun(adapter, cancelPr.number, oldCancelSha,
    (run) => ['queued', 'in_progress'].includes(run.status), options.poll);
  const otherRun = await waitForRun(adapter, otherPr.number, otherPr.head.sha,
    (run) => ['queued', 'in_progress'].includes(run.status), options.poll);
  ensureActive(options.signal);
  const newerSha = await adapter.commit({ branch: names.cancel, message: 'Agent QA live: supersede same PR generation' });
  cancelPr.head.sha = newerSha;
  const newerRun = await waitForRun(adapter, cancelPr.number, newerSha, undefined, options.poll);
  const oldTerminal = await waitForRun(adapter, cancelPr.number, oldCancelSha,
    (run) => run.id === oldCancelRun.id && run.status === 'completed', options.poll);
  const otherTerminal = await waitForRun(adapter, otherPr.number, otherPr.head.sha, undefined, options.poll);
  if (oldTerminal.conclusion !== 'cancelled' || otherTerminal.conclusion === 'cancelled') {
    throw new LiveVerificationError('concurrency_contract_failed', 'same-PR supersession or cross-PR preservation failed');
  }
  const otherProof = await inspectRunEvidence(adapter, otherTerminal, otherPr, evidenceRoot, 'no_findings');
  const newerProof = await inspectRunEvidence(adapter, newerRun, cancelPr, evidenceRoot, 'no_findings');
  const qaIntervals = [];
  for (const run of [otherTerminal, newerRun]) {
    const job = (await adapter.jobs(run.id, run.run_attempt)).find((item) => item.name === 'Fixture browser QA');
    if (!job || job.run_id !== run.id || !Number.isSafeInteger(job.id) || job.id < 1
      || job.status !== 'completed' || job.conclusion !== 'success'
      || !Number.isFinite(Date.parse(job.started_at)) || !Number.isFinite(Date.parse(job.completed_at))
      || Date.parse(job.completed_at) < Date.parse(job.started_at)) {
      throw new LiveVerificationError('qa_timeline_incomplete', `run ${run.id} lacks an exact successful QA-job interval`);
    }
    qaIntervals.push({ run_id: run.id, job_id: job.id,
      started_at: job.started_at, completed_at: job.completed_at, conclusion: job.conclusion });
  }
  const sorted = qaIntervals.slice().sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  for (let index = 1; index < sorted.length; index += 1) {
    if (Date.parse(sorted[index].started_at) < Date.parse(sorted[index - 1].completed_at)) {
      throw new LiveVerificationError('global_execution_overlap', 'Fixture browser QA jobs overlapped');
    }
  }
  scenarios.d_concurrency = { old_same_pr: { id: oldTerminal.id, conclusion: oldTerminal.conclusion },
    newer_same_pr: { id: newerRun.id, conclusion: newerRun.conclusion }, other_pr: { id: otherTerminal.id, conclusion: otherTerminal.conclusion },
    serial_timeline: sorted, other_proof: otherProof, newer_proof: newerProof };

  const beforeInvalidation = (await adapter.workflowRuns()).map(({ id }) => id);
  ensureActive(options.signal);
  await adapter.convertToDraft(cleanPr.node_id);
  ensureActive(options.signal);
  await adapter.updatePull(cleanPr.number, { base: DEFAULT_BRANCH });
  const invalidationRuns = await poll(async () => {
    const runs = await adapter.workflowRuns();
    return runs.filter((run) => matchingRun(run, cleanPr.number, defectSha)
      && !beforeInvalidation.includes(run.id) && run.status === 'completed');
  }, (runs) => runs.length >= 2, { ...options.poll, timeout: RUN_TIMEOUT_MS });
  const invalidationReceipts = [];
  for (const invalidationRun of invalidationRuns) {
    const invalidationJobs = await adapter.jobs(invalidationRun.id, invalidationRun.run_attempt);
    const invalidationQa = invalidationJobs.find((job) => job.name === 'Fixture browser QA');
    if (invalidationQa && invalidationQa.conclusion !== 'skipped') {
      throw new LiveVerificationError('ineligible_browser_ran', 'draft/retarget invalidation ran browser QA');
    }
    invalidationReceipts.push({ run_id: invalidationRun.id,
      browser_job: invalidationQa ? invalidationQa.conclusion : 'absent' });
  }
  const invalidatedComment = await managedComment(adapter, cleanPr.number,
    (comment) => comment.body.includes('not_applicable'), options.poll);
  scenarios.e_invalidation = { runs: invalidationReceipts, comment_id: invalidatedComment.id,
    base: DEFAULT_BRANCH, draft: true };

  ensureActive(options.signal);
  const cancellationSha = await adapter.commit({ branch: names.other, message: 'Agent QA live: cancellation without artifact' });
  otherPr.head.sha = cancellationSha;
  const running = await waitForRun(adapter, otherPr.number, cancellationSha,
    (run) => run.status === 'in_progress', options.poll);
  await poll(async () => (await adapter.jobs(running.id, running.run_attempt))
    .find((job) => job.name === 'Fixture browser QA') || null,
  (job) => job?.status === 'in_progress', options.poll);
  ensureActive(options.signal);
  await adapter.cancelRun(running.id);
  const cancelled = await waitForRun(adapter, otherPr.number, cancellationSha,
    (run) => run.id === running.id && run.status === 'completed', options.poll);
  if (cancelled.conclusion !== 'cancelled') throw new LiveVerificationError('run_not_cancelled', 'cancel API did not yield cancelled run');
  const cancellationArtifacts = await adapter.artifacts(cancelled.id);
  const cancellationComment = await managedComment(adapter, otherPr.number,
    (comment) => comment.body.includes(cancellationSha)
      && (comment.body.includes('**Status:** cancelled') || comment.body.includes('**Status:** incomplete')), options.poll);
  scenarios.f_cancel = { run_id: cancelled.id, head_sha: cancellationSha, conclusion: cancelled.conclusion,
    artifact_count: cancellationArtifacts.length, comment_id: cancellationComment.id,
    report_status: cancellationComment.body.includes('**Status:** cancelled') ? 'cancelled' : 'incomplete' };
  return scenarios;
}

function adversarialLedger(status, scenarios = {}) {
  const observed = status === 'passed';
  const classes = [
    ['absent_auth', 'adapter_test'], ['absent_runner', 'adapter_test'],
    ['workflow_not_promoted', 'live_preflight'], ['model_prose_without_artifact', 'artifact_contract'],
    ['head_sha_mismatch', 'artifact_contract'], ['unstable_comment_id', 'live_matrix_b'],
    ['disabled_submit_not_observed', 'live_matrix_c'], ['cross_pr_overlap', 'live_matrix_d'],
    ['cancelled_missing_artifact', 'live_matrix_f'],
  ];
  return { schema_version: 1, status, classes: classes.map(([name, channel]) => ({
    name, channel, status: observed || channel === 'adapter_test' ? 'covered' : 'pending_prerequisite',
  })), scenario_keys: Object.keys(scenarios) };
}

async function runLive({ adapter, repository, evidence, prefix, poll: pollOptions } = {}) {
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const priorRegistry = loadRegistry(evidence);
  let recovery = null;
  if (priorRegistry && (priorRegistry.branches.length || priorRegistry.pulls.length)) {
    recovery = await cleanupOwned(adapter, priorRegistry);
    if (!recovery.completed) {
      const blocked = {
        schema_version: 1, repository, generated_at: new Date().toISOString(), status: 'failed',
        preflight: null, scenarios: {}, owned_resources: priorRegistry, cleanup: recovery,
        failure: { code: 'prior_cleanup_incomplete', message: 'owned resources from the prior run remain' },
      };
      writeFileSync(path.join(evidence, 'live.json'), `${JSON.stringify(blocked, null, 2)}\n`, { mode: 0o600 });
      writeFileSync(path.join(evidence, 'cleanup.json'), `${JSON.stringify(recovery, null, 2)}\n`, { mode: 0o600 });
      return blocked;
    }
  }
  const registry = ownedRegistry(prefix || `agent-qa-live-${Date.now()}-${randomBytes(3).toString('hex')}`);
  persistRegistry(evidence, registry);
  const result = {
    schema_version: 1, repository, generated_at: new Date().toISOString(), status: 'live_incomplete',
    preflight: null, scenarios: {}, owned_resources: registry, cleanup: { attempted: false, completed: true, actions: [] },
  };
  if (recovery) result.recovered_cleanup = recovery;
  try {
    result.preflight = await preflight(adapter);
    if (!result.preflight.ok) return result;
    const repo = await adapter.repositoryMetadata();
    repo.default_branch_sha = result.preflight.repository.default_branch_sha;
    result.scenarios = await executeMatrix(adapter, repo, evidence, registry, {
      poll: pollOptions, signal: pollOptions?.signal,
    });
    result.status = 'passed';
    return result;
  } catch (error) {
    result.status = 'failed';
    result.failure = { code: error.code || 'unexpected_error', message: redactError(error.message), details: error.details };
    return result;
  } finally {
    if (registry.branches.length || registry.pulls.length || registry.processes.length) {
      result.cleanup = await cleanupOwned(adapter, registry);
      if (!result.cleanup.completed) result.status = 'failed';
      persistRegistry(evidence, registry);
    }
    writeFileSync(path.join(evidence, 'live.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(path.join(evidence, 'adversarial.json'), `${JSON.stringify(adversarialLedger(result.status, result.scenarios), null, 2)}\n`, { mode: 0o600 });
    writeFileSync(path.join(evidence, 'cleanup.json'), `${JSON.stringify(result.cleanup, null, 2)}\n`, { mode: 0o600 });
  }
}

async function runLiveWithSignals(options, processObject = process) {
  const controller = new AbortController();
  const interrupt = (signal) => {
    if (!controller.signal.aborted) {
      controller.abort(new LiveVerificationError('interrupted', `received ${signal}; stopping new work and cleaning owned resources`));
    }
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  processObject.on('SIGINT', onInt);
  processObject.on('SIGTERM', onTerm);
  try {
    return await runLive({ ...options, poll: { ...(options.poll || {}), signal: controller.signal } });
  } finally {
    processObject.off('SIGINT', onInt);
    processObject.off('SIGTERM', onTerm);
  }
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const result = await runLiveWithSignals({ ...options,
    adapter: new GhAdapter({ repository: options.repository }) });
  process.stdout.write(`${JSON.stringify({ status: result.status, evidence: options.evidence, missing: result.preflight?.missing || [] })}\n`);
  return result.status === 'passed' ? 0 : 1;
}

module.exports = Object.freeze({
  EXPECTED_REPOSITORY,
  GhAdapter,
  LiveVerificationError,
  adversarialLedger,
  branchNames,
  cleanupOwned,
  createOwnedBranch,
  createOwnedPull,
  defectSource,
  executeMatrix,
  inspectPng,
  loadRegistry,
  managedComment,
  matchingRun,
  parseArgs,
  poll,
  preflight,
  persistRegistry,
  runCommand,
  runLive,
  runLiveWithSignals,
  waitForRun,
});

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${redactError(error.message)}\n`);
    process.exitCode = 1;
  });
}
