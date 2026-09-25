#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');

const {
  SCENARIO_IDS, deriveReportOutcome, readBoundedJson, validateAgentResult,
  validateEvidenceFile, validateEvidenceManifest, validateReport, validateRequest,
} = require('./contracts.cjs');
const { agentTokenReadiness, runDoctor } = require('./doctor.cjs');
const { parseBrowserJournal, readJournal, scenarioActionRequirements } = require('./journal.cjs');
const { runCopilot } = require('./agents/copilot.cjs');
const {
  ProcessSupervisor, RuntimeError, reclaimStaleManifest, remainingMilliseconds,
  sanitizedChildEnvironment, startRuntime, stopHandedOffRuntime,
} = require('./runtime.cjs');
const { profileFor } = require('./agents/profiles.cjs');

// Two consecutive runs of the same code took 230s and 546s for the same six scenarios, so the budget
// has to cover agent variance rather than its best case. The runner is self-hosted, so the extra
// wall time costs nothing and QA still runs one job at a time.
const INTERNAL_DEADLINE_MS = 25 * 60 * 1000;
const MAX_DIFF_BYTES = 100 * 1024;
const MAX_EVENT_BYTES = 50 * 1024 * 1024;
const qaRoot = fs.realpathSync(__dirname);
const scenarioContract = require('./scenarios.json');
const ALLOWED_TOOLS = Object.freeze([...scenarioContract.browser.allowed_tools]);
const scenariosById = new Map(scenarioContract.scenarios.map((scenario) => [scenario.id, scenario]));

class ExecutionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
    this.details = details;
  }
}

function usage() {
  return [
    'Usage:',
    '  node execute.cjs prepare --request <absolute-path> --candidate <absolute-path> --evidence <absolute-path> --job-start <timestamp>',
    '  node execute.cjs agent --state <absolute-path>',
    '  node execute.cjs finalize --state <absolute-path> [--cancelled]',
    '',
  ].join('\n');
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const flagsByCommand = {
    prepare: ['--request', '--candidate', '--evidence', '--job-start'],
    agent: ['--state'],
    finalize: ['--state'],
  };
  const allowed = flagsByCommand[command];
  if (!allowed) throw new ExecutionError('USAGE', usage().trim());
  const values = {};
  let cancelled = false;
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    if (command === 'finalize' && flag === '--cancelled' && !cancelled) {
      cancelled = true;
      index += 1;
      continue;
    }
    if (!allowed.includes(flag) || !rest[index + 1] || values[flag]) {
      throw new ExecutionError('USAGE', usage().trim());
    }
    values[flag] = rest[index + 1];
    index += 2;
  }
  if (allowed.some((flag) => !values[flag])) throw new ExecutionError('USAGE', usage().trim());
  const pathFlags = command === 'prepare' ? ['--request', '--candidate', '--evidence'] : ['--state'];
  for (const flag of pathFlags) {
    if (!path.isAbsolute(values[flag])) throw new ExecutionError('INVALID_PATH', `${flag} must be an absolute path`);
  }
  if (command === 'prepare') return {
    command,
    request: path.resolve(values['--request']),
    candidate: path.resolve(values['--candidate']),
    evidence: path.resolve(values['--evidence']),
    jobStart: values['--job-start'],
  };
  return { command, statePath: path.resolve(values['--state']), cancelled };
}

function deadlineFromJobStart(jobStart, clocks = {}) {
  const wallNow = clocks.wallNow ?? Date.now();
  const monotonicNow = clocks.monotonicNow ?? performance.now();
  const started = Date.parse(jobStart);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(jobStart)
      || !Number.isFinite(started) || started > wallNow + 1000) {
    throw new ExecutionError('INVALID_JOB_START', '--job-start must be a current or past RFC 3339 timestamp');
  }
  return monotonicNow + Math.max(0, INTERNAL_DEADLINE_MS - Math.max(0, wallNow - started));
}

function deadlineFromEpoch(epochMs, clocks = {}) {
  const now = clocks.now ?? Date.now;
  const monotonic = clocks.monotonic ?? (() => performance.now());
  return monotonic() + Math.max(1, epochMs - now());
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function prepareRoots(candidate, evidence) {
  const candidateReal = await fsp.realpath(candidate);
  await fsp.mkdir(evidence, { recursive: true, mode: 0o700 });
  const evidenceStats = await fsp.lstat(evidence);
  if (evidenceStats.isSymbolicLink() || !evidenceStats.isDirectory()) {
    throw new ExecutionError('INVALID_EVIDENCE', 'Evidence root must be a directory, not a symlink');
  }
  const evidenceReal = await fsp.realpath(evidence);
  if (within(candidateReal, evidenceReal) || within(evidenceReal, candidateReal)) {
    throw new ExecutionError('INVALID_EVIDENCE', 'Evidence and candidate roots must be separate');
  }
  await fsp.chmod(evidenceReal, 0o700);
  return { candidate: candidateReal, evidence: evidenceReal };
}

function git(candidate, args, encoding = 'utf8', maxBuffer = 20 * 1024 * 1024) {
  const result = childProcess.spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', candidate, ...args], {
    encoding,
    maxBuffer,
    timeout: 15_000,
    env: {
      HOME: process.env.HOME, PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  if (result.error || result.status !== 0) throw new ExecutionError('GIT_FAILED', `git ${args[0]} failed for the candidate`);
  return result.stdout;
}

function candidateHead(candidate) {
  return git(candidate, ['rev-parse', '--verify', 'HEAD']).trim();
}

function candidateTrackedClean(candidate) {
  return git(candidate, ['status', '--porcelain=v1', '--untracked-files=no']).trim() === '';
}

function snapshotTrackedFiles(candidate) {
  const files = git(candidate, ['ls-files', '-z'], 'buffer').toString('utf8').split('\0').filter(Boolean).sort();
  const snapshot = {};
  for (const relative of files) {
    const target = path.join(candidate, relative);
    let stats;
    try {
      stats = fs.lstatSync(target);
    } catch (error) {
      if (error.code === 'ENOENT') {
        snapshot[relative] = { kind: 'missing', sha256: null };
        continue;
      }
      throw error;
    }
    if (stats.isFile()) {
      snapshot[relative] = { kind: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') };
    } else if (stats.isSymbolicLink()) {
      snapshot[relative] = { kind: 'symlink', sha256: crypto.createHash('sha256').update(fs.readlinkSync(target)).digest('hex') };
    } else {
      snapshot[relative] = { kind: 'other', sha256: null };
    }
  }
  return snapshot;
}

function boundedDiffContext(candidate, request) {
  const result = childProcess.spawnSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-C', candidate, 'diff', '--no-ext-diff', '--no-textconv',
    '--unified=2', request.base.sha, request.head.sha, '--',
  ], {
    encoding: 'buffer', maxBuffer: MAX_DIFF_BYTES + 64 * 1024, timeout: 15_000,
    env: {
      HOME: process.env.HOME, PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  if ((result.error && result.error.code !== 'ENOBUFS') || (result.status !== 0 && !result.error)) {
    return { text: '[diff unavailable]', truncated: false };
  }
  const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
  return {
    text: bytes.subarray(0, MAX_DIFF_BYTES).toString('utf8'),
    truncated: bytes.length > MAX_DIFF_BYTES || Boolean(result.error),
  };
}

function sanitizeText(value, fallback = 'Details unavailable.') {
  let text = typeof value === 'string' ? value : fallback;
  text = text
    .replace(/\b(?:sk|sess|ghp|github_pat)_[A-Za-z0-9_-]{6,}\b/gu, '[redacted]')
    .replace(/\b(?:OPENAI_API_KEY|AZURE_OPENAI_API_KEY|CODEX_API_KEY|GITHUB_TOKEN|GH_TOKEN)\s*[:=]\s*[^\s,;]+/giu, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{6,}/giu, 'Bearer [redacted]')
    .replace(/(?:TOKEN|SECRET|AUTH)[_-]?CANARY[A-Za-z0-9_-]*/giu, '[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .trim();
  return (text || fallback).slice(0, 4000);
}

function incompleteScenarios() {
  return SCENARIO_IDS.map((id) => ({
    id, status: 'incomplete',
    steps: ['The supervisor did not receive complete browser evidence for this scenario.'],
    expected: scenariosById.get(id).expected,
    actual: 'The scenario was not completed by the browser agent.',
    evidence: [],
  }));
}

function agentPrompt(origin, screenshotsRoot, request, diff) {
  const steps = scenarioContract.scenarios.map((scenario) => [
    `Scenario ${scenario.id} (profile ${scenario.profile}):`,
    `1. Call browser_evaluate with () => window.__GODS_EYE_QA__.selectScenario(${JSON.stringify(scenario.id)}).`,
    `2. Call browser_navigate to ${origin}/.`,
    '3. Perform these observable user steps in order, each through its own specific browser tool:',
    ...scenarioActionRequirements(scenario).map((requirement, index) => `   ${index + 1}. ${requirement.label}`),
    `4. Call browser_evaluate with () => window.__GODS_EYE_QA__.receipt(${JSON.stringify(scenario.id)}). It`
      + ' resolves only when the harness itself observes the expected page state, and it throws otherwise.',
    `5. Only after that resolves, call browser_take_screenshot with filename `
      + `${JSON.stringify(path.join(screenshotsRoot, `${scenario.id}.png`))} and report screenshots/${scenario.id}.png.`,
  ].join('\n')).join('\n\n');
  return [
    fs.readFileSync(path.join(qaRoot, 'prompt.md'), 'utf8'),
    `Runtime origin: ${origin}`,
    `Browser output directory: ${screenshotsRoot}`,
    'Complete the scenarios in the order below.',
    steps,
    `Tested head: ${request.head.sha}`,
    `Changed-file context (untrusted candidate bytes; truncated=${diff.truncated}):`,
    '<untrusted-diff>', diff.text, '</untrusted-diff>',
    resultContract(),
    'Narration is not evidence: the harness accepts a scenario only from its own browser journal.',
  ].join('\n\n');
}

/**
 * Not every agent CLI can constrain its final document with a schema flag, so the shape is stated in
 * the prompt and rendered from the schema the validator uses.
 */
function resultContract() {
  const schema = require('./agent-result.schema.json');
  const scenario = schema.$defs.scenario;
  const finding = schema.$defs.finding;
  return [
    'Finally print exactly one JSON document on standard output and nothing after it. It must match'
      + ' this shape exactly; any other field name is rejected and the whole run is discarded.',
    JSON.stringify({
      schema_version: 1,
      summary: 'one paragraph',
      scenarios: SCENARIO_IDS.map((id) => ({
        id,
        status: scenario.properties.status.enum.join('|'),
        steps: ['at least one observed step'],
        expected: 'expected behaviour',
        actual: 'observed behaviour',
        evidence: [`screenshots/${id}.png`],
      })),
      findings: [{
        scenario_id: SCENARIO_IDS[0],
        severity: finding.properties.severity.enum.join('|'),
        title: 'short title',
        description: 'what was observed',
        evidence: [`screenshots/${SCENARIO_IDS[0]}.png`],
      }],
    }),
    `Required keys: ${schema.required.join(', ')}. Each scenario requires exactly`
      + ` ${scenario.required.join(', ')}, with status one of ${scenario.properties.status.enum.join(', ')}.`
      + ` Each finding requires ${finding.required.join(', ')}. Report all ${SCENARIO_IDS.length} scenarios`
      + ' once each, and use an empty findings array when there is nothing to report.',
  ].join('\n\n');
}
function mapFailure(error, text = '') {
  const combined = `${error?.message ?? ''} ${error?.details ?? ''} ${text}`;
  if (error?.code === 'AUTH_REQUIRED') return 'auth_required';
  if (error?.code === 'CANCELLED') return 'cancelled';
  if (error?.code === 'DEADLINE_EXCEEDED' || /timed?\s*out|deadline/iu.test(combined)) return 'timeout';
  if (/rate.?limit|too many requests|\b429\b|quota/iu.test(combined)) return 'rate_limited';
  if (/not logged in|login required|authentication|unauthorized|\b401\b/iu.test(combined)) return 'auth_required';
  if (/browser.*(?:not found|missing|unavailable)|chromium.*(?:not found|missing)|mcp.*(?:start|initializ).*fail/iu.test(combined)) return 'browser_unavailable';
  return 'invalid_output';
}

function toolsFromDoctor(doctor, chromium = 'unavailable', agent = 'copilot', env = process.env) {
  const versions = doctor?.checks?.find((check) => check.name === 'tool_versions') ?? {};
  const profile = profileFor(agent);
  const model = env.QA_AGENT_MODEL;
  return {
    node: versions.node ?? process.versions.node,
    agent: {
      name: profile.agent,
      version: versions[profile.agent] ?? 'unavailable',
      ...(model ? { model } : {}),
    },
    playwright_mcp: versions.playwright_mcp ?? 'unavailable',
    chromium,
  };
}

function chromiumVersion(toolchainDir) {
  try {
    const toolchainRequire = createRequire(path.join(toolchainDir, 'package.json'));
    const executable = toolchainRequire('playwright').chromium.executablePath();
    const result = childProcess.spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    return result.status === 0 ? sanitizeText(result.stdout, 'unavailable').slice(0, 100) : 'unavailable';
  } catch { return 'unavailable'; }
}

function doctorReason(doctor) {
  const failed = new Set(doctor.checks.filter((check) => !check.ok).map((check) => check.name));
  if (failed.has('subscription_auth')) return 'auth_required';
  if (failed.has('browser')) return 'browser_unavailable';
  return 'setup_failed';
}

async function defaultRunBaseline({ candidate, evidence, runtime }) {
  await fsp.mkdir(evidence, { recursive: true, mode: 0o700 });
  const started = performance.now();
  let failure;
  try {
    await runtime.supervisor.runToDeadline(
      'baseline',
      path.join(candidate, 'web', 'node_modules', '.bin', 'playwright'),
      ['test', '--config', path.join(qaRoot, 'baseline.config.ts')],
      {
        cwd: path.join(candidate, 'web'),
        env: sanitizedChildEnvironment(runtime.supervisor.runRoot, {
          QA_CANDIDATE: candidate, QA_WEB_ORIGIN: runtime.origin, QA_EVIDENCE: evidence,
        }),
      },
    );
  } catch (error) { failure = error; }
  let result;
  try { result = readBoundedJson(path.join(evidence, 'baseline-results.json'), { maxBytes: 10 * 1024 * 1024 }); } catch {}
  const startedHarness = Boolean(
    result?.stats
      && Array.isArray(result?.suites)
      && Number.isSafeInteger(result.stats.expected)
      && result.stats.expected > 0,
  );
  if (!startedHarness) {
    throw new ExecutionError('BASELINE_SETUP_FAILED', 'Candidate Playwright baseline did not start', failure?.message);
  }
  const failed = Boolean(failure) || Number(result?.stats?.unexpected ?? 0) > 0;
  return {
    name: 'candidate-playwright', status: failed ? 'failed' : 'passed',
    harness_started: true, app_started: true,
    duration_ms: Math.min(900000, Math.max(0, Math.round(performance.now() - started))),
    ...(failed ? { details: 'Candidate Playwright reported a browser assertion failure.' } : {}),
  };
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(temporary, 0o600);
  await fsp.rename(temporary, file);
}

function publicAgentResult(agentResult, parsed) {
  const scenarios = agentResult.scenarios.map((scenario) => {
    const screenshot = parsed.proof.get(scenario.id)?.screenshot;
    return {
      id: scenario.id,
      status: parsed.complete ? scenario.status : 'incomplete',
      steps: scenario.steps.map((step) => sanitizeText(step)).slice(0, 20),
      expected: sanitizeText(scenario.expected),
      actual: sanitizeText(scenario.actual),
      evidence: screenshot ? [screenshot] : [],
    };
  });
  const findings = parsed.complete ? agentResult.findings.map((finding) => ({
    scenario_id: finding.scenario_id, severity: finding.severity,
    title: sanitizeText(finding.title).slice(0, 200),
    description: sanitizeText(finding.description),
    evidence: [parsed.proof.get(finding.scenario_id).screenshot],
  })) : [];
  return { summary: sanitizeText(agentResult.summary), scenarios, findings };
}

function evidenceManifest(evidenceRoot, proof) {
  const manifest = [];
  for (const { screenshot } of proof.values()) {
    if (!screenshot) continue;
    manifest.push({ ...validateEvidenceFile(evidenceRoot, screenshot, { allowedExtensions: ['.png'] }), kind: 'screenshot' });
  }
  return manifest;
}

async function pruneScreenshotOutput(screenshotsRoot, proof) {
  const allowed = new Set([...proof.values()].map(({ screenshot }) => screenshot && path.basename(screenshot)).filter(Boolean));
  for (const entry of await fsp.readdir(screenshotsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !allowed.has(entry.name)) {
      await fsp.rm(path.join(screenshotsRoot, entry.name), { recursive: true, force: true });
    }
  }
}

function executionDependencies(adapters) {
  return {
    env: adapters.env ?? process.env,
    runDoctor: adapters.runDoctor ?? runDoctor,
    startRuntime: adapters.startRuntime ?? startRuntime,
    stopHandedOffRuntime: adapters.stopHandedOffRuntime ?? stopHandedOffRuntime,
    runBaseline: adapters.runBaseline ?? defaultRunBaseline,
    runAgent: adapters.runAgent ?? runCopilot,
    ProcessSupervisor: adapters.ProcessSupervisor ?? ProcessSupervisor,
    snapshotTrackedFiles: adapters.snapshotTrackedFiles ?? snapshotTrackedFiles,
    candidateHead: adapters.candidateHead ?? candidateHead,
    candidateTrackedClean: adapters.candidateTrackedClean ?? candidateTrackedClean,
    boundedDiffContext: adapters.boundedDiffContext ?? boundedDiffContext,
    chromiumVersion: adapters.chromiumVersion ?? chromiumVersion,
    clocks: adapters.clocks,
  };
}

function initialDeterministicResult() {
  return [{ name: 'candidate-playwright', status: 'not_run', harness_started: false, app_started: false, duration_ms: 0 }];
}

function phaseTracker(records) {
  let phaseStart = performance.now();
  return {
    mark(name) {
      const seconds = Math.round((performance.now() - phaseStart) / 1000);
      records.push({ name, seconds });
      phaseStart = performance.now();
    },
  };
}

function phaseSummary(...groups) {
  return groups.flat().map(({ name, seconds }) => `${name}=${seconds}s`).join(' ');
}

function absoluteStatePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new ExecutionError('INVALID_PATH', '--state must be an absolute path');
  }
  return path.resolve(value);
}

function readExecutionState(statePath) {
  const absolutePath = absoluteStatePath(statePath);
  const state = readBoundedJson(absolutePath, { maxBytes: MAX_EVENT_BYTES });
  if (state?.schema_version !== 1 || typeof state.private_root !== 'string'
      || !path.isAbsolute(state.private_root)) {
    throw new ExecutionError('INVALID_STATE', 'Execution state is malformed');
  }
  for (const field of ['request_path', 'candidate', 'evidence', 'screenshots_root']) {
    if (typeof state[field] !== 'string' || !path.isAbsolute(state[field])) {
      throw new ExecutionError('INVALID_STATE', 'Execution state is malformed');
    }
  }
  if (state.private_root !== path.join(state.evidence, '.private-execution')
      || absolutePath !== path.join(state.private_root, 'state.json')
      || state.screenshots_root !== path.join(state.evidence, 'screenshots')) {
    throw new ExecutionError('INVALID_STATE', 'Execution state paths do not match the evidence root');
  }
  try {
    if (fs.realpathSync(state.private_root) !== state.private_root) {
      throw new ExecutionError('INVALID_STATE', 'Execution private root is not a real directory');
    }
  } catch (error) {
    if (error.code === 'INVALID_STATE') throw error;
    throw new ExecutionError('INVALID_STATE', 'Execution private root is unavailable');
  }
  if (state.runtime !== null) {
    if (!state.runtime || typeof state.runtime !== 'object'
        || typeof state.runtime.manifest_path !== 'string'
        || !path.isAbsolute(state.runtime.manifest_path)
        || typeof state.runtime.run_root !== 'string'
        || !path.isAbsolute(state.runtime.run_root)) {
      throw new ExecutionError('INVALID_STATE', 'Execution runtime paths are malformed');
    }
    const runtimeRoot = path.resolve(path.join(state.private_root, 'runtime'));
    const runRoot = path.resolve(state.runtime.run_root);
    if (runRoot === runtimeRoot || !within(runtimeRoot, runRoot)
        || state.runtime.manifest_path !== path.join(runRoot, 'processes.json')) {
      throw new ExecutionError('INVALID_STATE', 'Execution runtime paths do not match the private runtime root');
    }
  }
  return state;
}

function privateChildPath(privateRoot, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  const resolved = path.resolve(value);
  return resolved !== privateRoot && within(privateRoot, resolved) ? resolved : null;
}

async function removePrivatePath(privateRoot, value) {
  const target = privateChildPath(privateRoot, value);
  if (!target) return;
  let realTarget;
  try { realTarget = await fsp.realpath(target); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (within(privateRoot, realTarget)) await fsp.rm(target, { force: true });
}

async function writeExecutionState(statePath, state) {
  await fsp.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  await fsp.chmod(path.dirname(statePath), 0o700);
  await writeJsonAtomic(statePath, state);
  await fsp.chmod(statePath, 0o600);
}

function serializeProcessError(error) {
  return {
    code: String(error?.code ?? error?.name ?? 'PROCESS_FAILED'),
    message: sanitizeText(error?.message ?? error, 'Agent process failed'),
    details: error?.details == null ? null : sanitizeText(error.details),
  };
}

async function prepareExecution(options, adapters = {}) {
  const deps = executionDependencies(adapters);
  const requestPath = path.resolve(options.request);
  const request = validateRequest(readBoundedJson(requestPath));
  const roots = await prepareRoots(options.candidate, options.evidence);
  const deadline = deadlineFromJobStart(options.jobStart, deps.clocks);
  const privateRoot = path.join(roots.evidence, '.private-execution');
  const screenshotsRoot = path.join(roots.evidence, 'screenshots');
  const statePath = path.join(privateRoot, 'state.json');
  await fsp.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await fsp.chmod(privateRoot, 0o700);
  await fsp.mkdir(screenshotsRoot, { recursive: true, mode: 0o700 });
  await fsp.chmod(screenshotsRoot, 0o700);

  const stateRoot = path.resolve(deps.env.QA_ROOT || path.join(deps.env.HOME || os.homedir(), '.local/share/gods-eye-agent-qa'));
  const toolchain = path.join(stateRoot, 'toolchain');
  const startedAt = new Date().toISOString();
  const state = {
    schema_version: 1,
    request_path: requestPath,
    candidate: roots.candidate,
    evidence: roots.evidence,
    deadline_epoch_ms: Date.parse(options.jobStart) + INTERNAL_DEADLINE_MS,
    started_at: startedAt,
    private_root: privateRoot,
    screenshots_root: screenshotsRoot,
    before: null,
    tools: {
      node: process.versions.node,
      agent: { name: request.agent, version: 'unavailable' },
      playwright_mcp: 'unavailable',
      chromium: 'unavailable',
    },
    deterministic: initialDeterministicResult(),
    phases: [],
    reason: null,
    stale: false,
    runtime: null,
    prompt_path: null,
    agent_paths: null,
  };
  const tracker = phaseTracker(state.phases);
  let runtime;
  let handedOff = false;
  let doctor;
  try {
    if (remainingMilliseconds(deadline) === 0) throw new RuntimeError('DEADLINE_EXCEEDED', 'Internal deadline expired before doctor');
    if (options.signal?.aborted) throw new RuntimeError('CANCELLED', 'Execution was cancelled before doctor');
    if (deps.candidateHead(roots.candidate) !== request.head.sha || !deps.candidateTrackedClean(roots.candidate)) {
      state.stale = true;
      throw new ExecutionError('STALE_CANDIDATE', 'Candidate is not a clean checkout of the admitted head');
    }
    state.before = deps.snapshotTrackedFiles(roots.candidate);
    doctor = await deps.runDoctor({ env: deps.env, phase: 'prepare' });
    tracker.mark('doctor');
    state.tools = toolsFromDoctor(doctor, deps.chromiumVersion(toolchain), request.agent, deps.env);
    if (!doctor.ok) {
      state.reason = doctorReason(doctor);
      // The doctor emits only non-secret readiness metadata, so naming the failed checks in the job
      // log is safe and is the only way an operator can tell which prerequisite broke.
      const failed = doctor.checks.filter((check) => !check.ok).map((check) => check.name).join(', ');
      process.stderr.write(`Agent QA doctor rejected execution; failed checks: ${failed || 'unknown'}\n`);
      throw new ExecutionError('DOCTOR_FAILED', 'Runner doctor rejected execution');
    }
    runtime = await deps.startRuntime({
      candidate: roots.candidate,
      evidence: path.join(privateRoot, 'runtime'),
      deadline,
      // Shared across runs: a per-run cache made every run refetch every dependency.
      cacheRoot: path.join(stateRoot, 'cache'),
      signal: options.signal,
    });
    tracker.mark('runtime');
    state.deterministic = [await deps.runBaseline({
      candidate: roots.candidate,
      evidence: path.join(privateRoot, 'baseline'),
      runtime,
      deadline,
    })];
    tracker.mark('baseline');

    const agentPaths = {
      work_dir: path.join(privateRoot, 'work'),
      agent_home: path.join(privateRoot, 'agent-home'),
      journal: path.join(privateRoot, 'browser-journal.jsonl'),
      private_result: path.join(privateRoot, 'agent-result.json'),
    };
    await fsp.mkdir(agentPaths.work_dir, { mode: 0o700 });
    const prompt = agentPrompt(
      runtime.origin,
      screenshotsRoot,
      request,
      deps.boundedDiffContext(roots.candidate, request),
    );
    const promptPath = path.join(privateRoot, 'prompt.txt');
    await fsp.writeFile(promptPath, prompt, { mode: 0o600 });
    await fsp.chmod(promptPath, 0o600);
    const handoff = await runtime.supervisor.handOff();
    handedOff = true;
    state.runtime = {
      origin: runtime.origin,
      manifest_path: path.resolve(handoff.manifestPath),
      run_root: path.resolve(handoff.runRoot),
    };
    state.prompt_path = promptPath;
    state.agent_paths = agentPaths;
  } catch (error) {
    if (error?.code === 'STALE_CANDIDATE') state.stale = true;
    if (options.signal?.aborted || error?.code === 'CANCELLED') {
      state.reason = 'cancelled';
    } else if (!state.reason) {
      state.reason = error?.code === 'BASELINE_SETUP_FAILED' ? 'setup_failed' : mapFailure(error);
    }
    const cancelled = options.signal?.aborted || error?.code === 'CANCELLED';
    if (!cancelled) {
      process.stderr.write(`Agent QA failed during ${sanitizeText(error.code ?? error.name)}; phases: ${
        phaseSummary(state.phases) || 'none'
      }\n`);
    }
    if (runtime && !handedOff) {
      await runtime.stop('start_failed').catch((stopError) => {
        state.reason = 'runner_failed';
        state.cleanup_error = sanitizeText(stopError.message);
      });
    }
  }
  try {
    await writeExecutionState(statePath, state);
  } catch (error) {
    if (state.runtime) {
      await deps.stopHandedOffRuntime({
        manifestPath: state.runtime.manifest_path,
        runRoot: state.runtime.run_root,
        reason: 'prepare_state_failed',
      }).catch(() => {});
    }
    await fsp.rm(privateRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { statePath, state };
}

async function runAgentStep({ statePath, signal }, adapters = {}) {
  const deps = executionDependencies(adapters);
  const state = readExecutionState(statePath);
  const request = validateRequest(readBoundedJson(state.request_path));
  const profile = profileFor(request.agent);
  const outcomePath = path.join(state.private_root, 'agent-outcome.json');
  const agentPaths = state.agent_paths;
  const outcome = {
    process_error: null,
    journal_path: agentPaths?.journal ?? null,
    stdout_path: agentPaths ? path.join(state.private_root, 'agent-supervisor', 'logs', 'copilot.stdout.log') : null,
    stderr_path: agentPaths ? path.join(state.private_root, 'agent-supervisor', 'logs', 'copilot.stderr.log') : null,
    config_path: agentPaths ? path.join(agentPaths.agent_home, '.copilot', 'mcp-config.json') : null,
    private_result: agentPaths?.private_result ?? null,
    phases: [],
  };
  const started = performance.now();
  let supervisor;
  let supervisorInitialized = false;
  let interrupted = Boolean(signal?.aborted);
  const cancellation = new AbortController();
  const abort = () => {
    interrupted = true;
    cancellation.abort(new RuntimeError('CANCELLED', 'Agent execution was cancelled'));
    if (supervisorInitialized) void supervisor.stop('cancelled').catch(() => {});
  };
  const onInterrupt = () => abort();
  const onTerminate = () => abort();
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const onSignalAbort = () => abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', onSignalAbort, { once: true });
  try {
    if (!state.runtime) {
      outcome.process_error = { code: 'NOT_PREPARED', message: 'Agent runtime was not prepared', details: null };
    } else {
      const token = typeof deps.env.QA_COPILOT_TOKEN === 'string' ? deps.env.QA_COPILOT_TOKEN : '';
      if (interrupted) {
        outcome.process_error = { code: 'CANCELLED', message: 'Agent execution was cancelled', details: null };
      } else if (!agentTokenReadiness(token).present) {
        outcome.process_error = { code: 'AUTH_REQUIRED', message: 'Agent token missing or malformed', details: null };
      } else if (profile.agent !== 'copilot') {
        outcome.process_error = { code: 'UNKNOWN_AGENT', message: 'Agent profile has no runner adapter', details: null };
      } else {
        const deadline = deadlineFromEpoch(state.deadline_epoch_ms, deps.clocks);
        const runRoot = path.join(state.private_root, 'agent-supervisor');
        supervisor = new deps.ProcessSupervisor({ runRoot, deadline });
        await supervisor.initialize();
        supervisorInitialized = true;
        if (interrupted) throw new RuntimeError('CANCELLED', 'Agent execution was cancelled');
        const toolchain = path.join(
          path.resolve(deps.env.QA_ROOT || path.join(deps.env.HOME || os.homedir(), '.local/share/gods-eye-agent-qa')),
          'toolchain',
        );
        const paths = {
          copilotBin: deps.env.QA_COPILOT_BIN || path.join(toolchain, 'node_modules', '.bin', 'copilot'),
          mcpBin: deps.env.QA_PLAYWRIGHT_MCP_BIN || path.join(toolchain, 'node_modules', '.bin', 'playwright-mcp'),
          agentHome: agentPaths.agent_home,
          browsers: path.join(toolchain, 'browsers'),
          initPage: path.join(qaRoot, 'browser-init.ts'),
          journal: agentPaths.journal,
          model: deps.env.QA_AGENT_MODEL || '',
          origin: state.runtime.origin,
          screenshotsRoot: state.screenshots_root,
          privateResult: agentPaths.private_result,
          workDir: agentPaths.work_dir,
        };
        try {
          const agent = await deps.runAgent({
            runtime: { supervisor, origin: state.runtime.origin },
            paths,
            prompt: await fsp.readFile(state.prompt_path, 'utf8'),
            deadline,
            environment: { copilotToken: token.trim() },
            sanitizedChildEnvironment,
            signal: cancellation.signal,
          });
          outcome.process_error = agent.processError ? serializeProcessError(agent.processError) : null;
          outcome.journal_path = agent.journalPath ?? outcome.journal_path;
          outcome.stdout_path = agent.stdoutPath ?? outcome.stdout_path;
          outcome.stderr_path = agent.stderrPath ?? outcome.stderr_path;
          outcome.config_path = agent.configPath ?? outcome.config_path;
          outcome.private_result = agent.privateResult ?? outcome.private_result;
        } catch (error) {
          outcome.process_error = serializeProcessError(error);
        }
      }
    }
  } catch (error) {
    outcome.process_error ??= serializeProcessError(error);
  } finally {
    signal?.removeEventListener('abort', onSignalAbort);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    if (supervisorInitialized) {
      await supervisor.stop(interrupted ? 'cancelled' : 'agent_complete').catch((error) => {
        outcome.process_error ??= serializeProcessError(error);
      });
    }
    outcome.phases = [{ name: 'agent', seconds: Math.round((performance.now() - started) / 1000) }];
  }
  await writeExecutionState(outcomePath, outcome);
  return outcome;
}

async function finalizeExecution({ statePath, cancelled = false, signal }, adapters = {}) {
  const deps = executionDependencies(adapters);
  const started = performance.now();
  const state = readExecutionState(statePath);
  let request;
  let requestError;
  try { request = validateRequest(readBoundedJson(state.request_path)); } catch (error) { requestError = error; }
  const reportPath = path.join(state.evidence, 'report.json');
  const outcomePath = path.join(state.private_root, 'agent-outcome.json');
  let outcome;
  let outcomeReadError;
  if (fs.existsSync(outcomePath)) {
    try { outcome = readBoundedJson(outcomePath, { maxBytes: MAX_EVENT_BYTES }); } catch (error) { outcomeReadError = error; }
  }
  const outcomeMissing = !fs.existsSync(outcomePath);
  const isCancelled = Boolean(cancelled || signal?.aborted || state.reason === 'cancelled');
  let parsed = {
    complete: false,
    errorText: '',
    proof: new Map(SCENARIO_IDS.map((id) => [id, { screenshot: null }])),
    toolCalls: [],
  };
  let agentResult;
  let reason = null;
  let cleanupReceipt;
  let cleanupError = state.cleanup_error ? new Error(state.cleanup_error) : null;
  let privateOutputDeleted = false;
  const privatePaths = [
    state.prompt_path,
    outcome?.journal_path,
    outcome?.stdout_path,
    outcome?.stderr_path,
    outcome?.config_path,
    outcome?.private_result,
  ].map((target) => privateChildPath(state.private_root, target)).filter(Boolean);
  const deterministic = state.deterministic ?? initialDeterministicResult();
  const outcomePhases = outcome?.phases ?? [];
  const phaseRecords = [...(state.phases ?? []), ...outcomePhases];
  const phases = phaseSummary(state.phases ?? [], outcomePhases);
  const screenshotsRoot = state.screenshots_root;
  const journalPath = privateChildPath(state.private_root, outcome?.journal_path)
    ?? privateChildPath(state.private_root, state.agent_paths?.journal);
  let journal = [];
  try {
    if (state.runtime) {
      try {
        if (!journalPath) throw new Error('Agent QA browser journal path is missing');
        journal = readJournal(journalPath);
      } catch (error) {
        if (!outcome?.process_error) {
          reason = 'invalid_output';
          process.stderr.write(`Agent QA browser journal unusable: ${sanitizeText(error.message)}\n`);
        }
      }
      parsed = parseBrowserJournal(journal, {
        origin: state.runtime.origin,
        screenshotsRoot,
      });
      if (!isCancelled && (outcome?.process_error || !parsed.complete)) {
        for (const [label, candidate] of [['stderr', outcome?.stderr_path], ['stdout', outcome?.stdout_path]]) {
          const file = privateChildPath(state.private_root, candidate);
          if (!file) continue;
          try {
            const tail = fs.readFileSync(file, 'utf8').slice(-2000);
            if (tail.trim()) process.stderr.write(`Agent QA agent ${label}: ${sanitizeText(tail)}\n`);
          } catch { /* an unreadable log must not replace the classified reason */ }
        }
        process.stderr.write(`Agent QA journal entries: ${journal.length}; proven scenarios: ${
          [...parsed.proof.entries()].filter(([, item]) => item.proven && item.screenshot).length
        }; phases: ${phases}\n`);
        // Name what each unproven scenario is missing. A refused receipt carries the harness's own state
        // snapshot, which is the only way to see why the expected page state did not hold.
        for (const [id, item] of parsed.proof.entries()) {
          if (item.proven && item.screenshot) continue;
          const requirements = scenarioActionRequirements(scenariosById.get(id));
          const missing = [
            item.navigate ? null : 'origin',
            item.nextAction === requirements.length ? null : `actions ${item.nextAction}/${requirements.length}`,
            item.proven ? null : `receipt (attempts ${item.receiptAttempts})`,
            item.screenshot ? null : 'screenshot',
          ].filter(Boolean).join(', ');
          const receiptState = item.lastReceiptState ? ` refused with ${sanitizeText(JSON.stringify(item.lastReceiptState))}` : '';
          process.stderr.write(`Agent QA unproven ${id}: missing ${missing}.${receiptState}\n`);
        }
      }
      const privateResult = privateChildPath(state.private_root, outcome?.private_result);
      if (privateResult && fs.existsSync(privateResult)) {
        try {
          agentResult = validateAgentResult(readBoundedJson(privateResult));
        } catch (error) {
          reason = 'invalid_output';
          process.stderr.write(`Agent QA agent result rejected: ${sanitizeText(error.message)}\n`);
        }
      }
    }
    if (outcomeReadError) {
      reason = 'invalid_output';
      process.stderr.write(`Agent QA agent outcome rejected: ${sanitizeText(outcomeReadError.message)}\n`);
    }
    if (isCancelled) reason = null;
    else if (state.reason) reason = state.reason;
    else if (outcomeMissing && state.runtime) reason = 'runner_failed';
    else if (outcome?.process_error?.code === 'CANCELLED') reason = 'timeout';
    else if (outcome?.process_error?.code === 'AUTH_REQUIRED') reason = 'auth_required';
    else if (outcome?.process_error) reason = mapFailure(outcome.process_error, parsed.errorText);
    else if (!agentResult || !parsed.complete) reason ??= 'invalid_output';
  } catch (error) {
    if (!isCancelled && !state.reason) reason = mapFailure(error, parsed.errorText);
    if (!isCancelled) {
      process.stderr.write(`Agent QA failed during ${sanitizeText(error.code ?? error.name)}; phases: ${phases || 'none'}\n`);
    }
  } finally {
    if (state.runtime) {
      cleanupReceipt = await deps.stopHandedOffRuntime({
        manifestPath: state.runtime.manifest_path,
        runRoot: state.runtime.run_root,
        reason: isCancelled ? 'cancelled' : 'execution_complete',
      }).catch((error) => {
        cleanupError ??= error;
        return null;
      });
    }
    const agentSupervisorRoot = path.join(state.private_root, 'agent-supervisor');
    const agentManifestPath = path.join(agentSupervisorRoot, 'processes.json');
    if (fs.existsSync(agentManifestPath)) {
      try {
        const processResults = await reclaimStaleManifest({ manifestPath: agentManifestPath, runRoot: agentSupervisorRoot });
        if (processResults.some(({ outcome }) => outcome !== 'stopped' && outcome !== 'identity_mismatch')) {
          cleanupError ??= new Error('Agent process group cleanup did not complete');
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
    for (const target of privatePaths) {
      await removePrivatePath(state.private_root, target).catch((error) => { cleanupError ??= error; });
    }
    await fsp.rm(state.private_root, { recursive: true, force: true }).then(() => {
      privateOutputDeleted = true;
    }).catch((error) => { cleanupError ??= error; });
    await pruneScreenshotOutput(screenshotsRoot, parsed.proof).catch((error) => { cleanupError ??= error; });
  }

  if (requestError) throw requestError;

  let changed = false;
  if (state.before) {
    try {
      changed = JSON.stringify(state.before) !== JSON.stringify(deps.snapshotTrackedFiles(state.candidate))
        || !deps.candidateTrackedClean(state.candidate);
    } catch { changed = true; }
  }
  let wasCancelled = isCancelled;
  let stale = Boolean(state.stale);
  if (changed) {
    reason = 'source_changed';
    wasCancelled = false;
    stale = false;
  } else if (cleanupError) {
    reason = 'runner_failed';
    wasCancelled = false;
    stale = false;
  }
  const evidence = evidenceManifest(state.evidence, parsed.proof);
  validateEvidenceManifest(state.evidence, evidence);
  const agent = agentResult ? publicAgentResult(agentResult, parsed) : {
    summary: 'The browser agent did not produce a complete validated result.',
    scenarios: incompleteScenarios(),
    findings: [],
  };
  const reportOutcome = deriveReportOutcome({
    cancelled: wasCancelled,
    stale,
    infrastructureReason: reason,
    evidenceComplete: parsed.complete,
    agentResult: agentResult && parsed.complete ? agent : null,
    deterministicResults: deterministic,
  });
  const stopped = cleanupReceipt?.processes?.filter((item) => item.outcome === 'stopped').length ?? 0;
  const report = {
    schema_version: 1,
    request,
    tested_head_sha: request.head.sha,
    controller_sha: request.controller_sha,
    started_at: state.started_at,
    finished_at: new Date().toISOString(),
    tools: state.tools,
    status: reportOutcome.status,
    reason: reportOutcome.reason,
    deterministic_results: deterministic,
    scenarios: agent.scenarios,
    findings: agent.findings,
    tool_calls: parsed.toolCalls,
    evidence,
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    phases: [...phaseRecords, { name: 'finalize', seconds: Math.round((performance.now() - started) / 1000) }],
    cleanup: {
      attempted: true,
      completed: !cleanupError && privateOutputDeleted && (cleanupReceipt?.allProcessesStopped ?? true),
      processes_stopped: stopped,
      private_output_deleted: privateOutputDeleted,
    },
  };
  validateReport(report, request);
  await writeJsonAtomic(reportPath, report);
  return { report, reportPath };
}

async function runExecution(options, adapters = {}) {
  const { statePath } = await prepareExecution(options, adapters);
  await runAgentStep({ statePath, signal: options.signal }, adapters);
  return finalizeExecution({
    statePath,
    cancelled: Boolean(options.signal?.aborted),
    signal: options.signal,
  }, adapters);
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const controller = new AbortController();
  let interrupted;
  const onInt = () => { interrupted = 'SIGINT'; controller.abort(); };
  const onTerm = () => { interrupted = 'SIGTERM'; controller.abort(); };
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  try {
    if (options.command === 'prepare') {
      const result = await prepareExecution({ ...options, signal: controller.signal });
      process.stdout.write(`${JSON.stringify({ state: result.statePath, ready: Boolean(result.state.runtime) })}\n`);
    } else if (options.command === 'agent') {
      await runAgentStep({ statePath: options.statePath, signal: controller.signal });
      process.stdout.write(`${JSON.stringify({ outcome: path.join(path.dirname(options.statePath), 'agent-outcome.json') })}\n`);
    } else {
      const result = await finalizeExecution({
        statePath: options.statePath,
        cancelled: options.cancelled,
        signal: controller.signal,
      });
      process.stdout.write(`${JSON.stringify({
        status: result.report.status,
        reason: result.report.reason,
        report: result.reportPath,
      })}\n`);
    }
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  }
  if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
}

module.exports = Object.freeze({
  ALLOWED_TOOLS,
  ExecutionError,
  INTERNAL_DEADLINE_MS,
  agentPrompt,
  deadlineFromEpoch,
  deadlineFromJobStart,
  finalizeExecution,
  parseCli,
  prepareExecution,
  resultContract,
  runAgentStep,
  runExecution,
  snapshotTrackedFiles,
});

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? error.name}: ${error.message}\n`);
    process.exitCode = ['USAGE', 'INVALID_PATH', 'INVALID_JOB_START'].includes(error.code) ? 2 : 1;
  });
}
