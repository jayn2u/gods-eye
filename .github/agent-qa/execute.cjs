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
const { runDoctor } = require('./doctor.cjs');
const { parseBrowserJournal, readJournal, scenarioActionRequirements } = require('./journal.cjs');
const { runCopilot } = require('./agents/copilot.cjs');
const { RuntimeError, remainingMilliseconds, sanitizedChildEnvironment, startRuntime } = require('./runtime.cjs');

const INTERNAL_DEADLINE_MS = 12 * 60 * 1000;
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
  return 'Usage: node execute.cjs run --request <json> --candidate <absolute-path> --evidence <absolute-path> --job-start <timestamp>\n';
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (command !== 'run' || rest.length !== 8) throw new ExecutionError('USAGE', usage().trim());
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!['--request', '--candidate', '--evidence', '--job-start'].includes(flag) || !rest[index + 1] || values[flag]) {
      throw new ExecutionError('USAGE', usage().trim());
    }
    values[flag] = rest[index + 1];
  }
  for (const flag of ['--request', '--candidate', '--evidence']) {
    if (!path.isAbsolute(values[flag])) throw new ExecutionError('INVALID_PATH', `${flag} must be an absolute path`);
  }
  return {
    command,
    request: path.resolve(values['--request']),
    candidate: path.resolve(values['--candidate']),
    evidence: path.resolve(values['--evidence']),
    jobStart: values['--job-start'],
  };
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
 * Codex constrained the final document with --output-schema. Copilot has no such flag, so the shape
 * has to be stated in the prompt. It is rendered from the schema the validator uses, so the two
 * cannot drift apart.
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
  if (error?.code === 'CANCELLED') return 'cancelled';
  if (error?.code === 'DEADLINE_EXCEEDED' || /timed?\s*out|deadline/iu.test(combined)) return 'timeout';
  if (/rate.?limit|too many requests|\b429\b|quota/iu.test(combined)) return 'rate_limited';
  if (/not logged in|login required|authentication|unauthorized|\b401\b/iu.test(combined)) return 'auth_required';
  if (/browser.*(?:not found|missing|unavailable)|chromium.*(?:not found|missing)|mcp.*(?:start|initializ).*fail/iu.test(combined)) return 'browser_unavailable';
  return 'invalid_output';
}

function toolsFromDoctor(doctor, chromium = 'unavailable') {
  const versions = doctor?.checks?.find((check) => check.name === 'tool_versions') ?? {};
  const model = process.env.QA_AGENT_MODEL;
  return {
    node: versions.node ?? process.versions.node,
    agent: {
      name: 'copilot',
      version: versions.copilot ?? 'unavailable',
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

async function runExecution(options, adapters = {}) {
  const deps = {
    runDoctor: adapters.runDoctor ?? runDoctor,
    startRuntime: adapters.startRuntime ?? startRuntime,
    runBaseline: adapters.runBaseline ?? defaultRunBaseline,
    runAgent: adapters.runAgent ?? runCopilot,
    snapshotTrackedFiles: adapters.snapshotTrackedFiles ?? snapshotTrackedFiles,
    candidateHead: adapters.candidateHead ?? candidateHead,
    candidateTrackedClean: adapters.candidateTrackedClean ?? candidateTrackedClean,
    boundedDiffContext: adapters.boundedDiffContext ?? boundedDiffContext,
    chromiumVersion: adapters.chromiumVersion ?? chromiumVersion,
    clocks: adapters.clocks,
  };
  const request = validateRequest(readBoundedJson(options.request));
  const roots = await prepareRoots(options.candidate, options.evidence);
  const deadline = deadlineFromJobStart(options.jobStart, deps.clocks);
  const startedAt = new Date().toISOString();
  const reportPath = path.join(roots.evidence, 'report.json');
  const privateRoot = path.join(roots.evidence, '.private-execution');
  const screenshotsRoot = path.join(roots.evidence, 'screenshots');
  await fsp.mkdir(privateRoot, { mode: 0o700 });
  await fsp.mkdir(screenshotsRoot, { mode: 0o700 });

  let runtime;
  let before;
  let doctor;
  let tools = {
    node: process.versions.node, agent: { name: 'copilot', version: 'unavailable' },
    playwright_mcp: 'unavailable', chromium: 'unavailable',
  };
  let deterministic = [{ name: 'candidate-playwright', status: 'not_run', harness_started: false, app_started: false, duration_ms: 0 }];
  let parsed = { complete: false, errorText: '', proof: new Map(SCENARIO_IDS.map((id) => [id, { screenshot: null }])), toolCalls: [] };
  let agentResult;
  let reason;
  let cancelled = false;
  let stale = false;
  let cleanupReceipt;
  let cleanupError;
  let privateOutputDeleted = false;
  let privatePaths = [];
  const phases = [];
  let phaseStart = performance.now();
  const markPhase = (name) => {
    phases.push(`${name}=${Math.round((performance.now() - phaseStart) / 1000)}s`);
    phaseStart = performance.now();
  };
  try {
    if (remainingMilliseconds(deadline) === 0) throw new RuntimeError('DEADLINE_EXCEEDED', 'Internal deadline expired before doctor');
    if (deps.candidateHead(roots.candidate) !== request.head.sha || !deps.candidateTrackedClean(roots.candidate)) {
      stale = true;
      throw new ExecutionError('STALE_CANDIDATE', 'Candidate is not a clean checkout of the admitted head');
    }
    before = deps.snapshotTrackedFiles(roots.candidate);
    doctor = await deps.runDoctor({ env: process.env, phase: 'status' });
    markPhase('doctor');
    const stateRoot = path.resolve(process.env.QA_ROOT || path.join(process.env.HOME || os.homedir(), '.local/share/gods-eye-agent-qa'));
    const toolchain = path.join(stateRoot, 'toolchain');
    tools = toolsFromDoctor(doctor, deps.chromiumVersion(toolchain));
    if (!doctor.ok) {
      reason = doctorReason(doctor);
      // The doctor emits only non-secret readiness metadata, so naming the failed checks in the job
      // log is safe and is the only way an operator can tell which prerequisite broke.
      const failed = doctor.checks.filter((check) => !check.ok).map((check) => check.name).join(', ');
      process.stderr.write(`Agent QA doctor rejected execution; failed checks: ${failed || 'unknown'}\n`);
      throw new ExecutionError('DOCTOR_FAILED', 'Runner doctor rejected execution');
    }
    runtime = await deps.startRuntime({
      candidate: roots.candidate, evidence: path.join(privateRoot, 'runtime'), deadline,
      // Shared across runs: a per-run cache made every run refetch every dependency.
      cacheRoot: path.join(stateRoot, 'cache'),
      signal: options.signal,
    });
    markPhase('runtime');
    deterministic = [await deps.runBaseline({
      candidate: roots.candidate, evidence: path.join(privateRoot, 'baseline'), runtime, deadline,
    })];
    markPhase('baseline');
    const workDir = path.join(privateRoot, 'work');
    await fsp.mkdir(workDir, { mode: 0o700 });
    const privateResult = path.join(privateRoot, 'agent-result.json');
    const prompt = agentPrompt(runtime.origin, screenshotsRoot, request, deps.boundedDiffContext(roots.candidate, request));
    const agent = await deps.runAgent({
      runtime, prompt, deadline,
      paths: {
        copilotBin: process.env.QA_COPILOT_BIN || path.join(toolchain, 'node_modules', '.bin', 'copilot'),
        mcpBin: process.env.QA_PLAYWRIGHT_MCP_BIN || path.join(toolchain, 'node_modules', '.bin', 'playwright-mcp'),
        agentHome: path.join(privateRoot, 'agent-home'), browsers: path.join(toolchain, 'browsers'),
        initPage: path.join(qaRoot, 'browser-init.ts'), journal: path.join(privateRoot, 'browser-journal.jsonl'),
        model: process.env.QA_AGENT_MODEL || '',
        origin: runtime.origin, screenshotsRoot, privateResult, workDir,
      },
      environment: {
        flockBin: process.env.QA_FLOCK_BIN || 'flock',
        lockFile: path.join(stateRoot, 'auth.lock'),
        copilotToken: (process.env.QA_COPILOT_TOKEN || '').trim(),
      },
      sanitizedChildEnvironment,
    });
    markPhase('agent');
    privatePaths = [agent.journalPath, agent.stdoutPath, agent.stderrPath, agent.configPath, agent.privateResult]
      .filter(Boolean);
    let journal = [];
    try {
      journal = readJournal(agent.journalPath);
    } catch (error) {
      if (!agent.processError) {
        // Missing evidence is invalid output; only the agent's own failure classifies the run.
        reason = 'invalid_output';
        process.stderr.write(`Agent QA browser journal unusable: ${sanitizeText(error.message)}\n`);
      }
    }
    parsed = parseBrowserJournal(journal, { origin: runtime.origin, screenshotsRoot });
    // Emitted before anything that can throw: a rejected result document used to jump straight to the
    // catch block and the run reported a one-word reason with no trace of what the agent did.
    if (!options.signal?.aborted && (agent.processError || !parsed.complete)) {
      for (const [label, file] of [['stderr', agent.stderrPath], ['stdout', agent.stdoutPath]]) {
        try {
          const tail = fs.readFileSync(file, 'utf8').slice(-2000);
          if (tail.trim()) process.stderr.write(`Agent QA agent ${label}: ${sanitizeText(tail)}\n`);
        } catch { /* an unreadable log must not replace the classified reason */ }
      }
      process.stderr.write(`Agent QA journal entries: ${journal.length}; proven scenarios: ${
        [...parsed.proof.entries()].filter(([, item]) => item.receipt && item.screenshot).length
      }; phases: ${phases.join(' ')}\n`);
    }
    if (fs.existsSync(agent.privateResult)) {
      try {
        agentResult = validateAgentResult(readBoundedJson(agent.privateResult));
      } catch (error) {
        // A malformed document is missing output, not an infrastructure fault.
        reason = 'invalid_output';
        process.stderr.write(`Agent QA agent result rejected: ${sanitizeText(error.message)}\n`);
      }
    }
    if (options.signal?.aborted) cancelled = true;
    else if (agent.processError) reason = mapFailure(agent.processError, parsed.errorText);
    else if (!agentResult || !parsed.complete) reason ??= 'invalid_output';
  } catch (error) {
    if (options.signal?.aborted || error.code === 'CANCELLED') cancelled = true;
    else if (!stale && !reason) reason = error.code === 'BASELINE_SETUP_FAILED' ? 'setup_failed' : mapFailure(error, parsed.errorText);
    // A run that dies before the agent has no agent log to report, so the phase timings are the only
    // way to see which stage consumed the deadline.
    if (!cancelled) process.stderr.write(`Agent QA failed during ${sanitizeText(error.code ?? error.name)}; phases: ${phases.join(' ') || 'none'}\n`);
  } finally {
    for (const target of privatePaths) {
      await fsp.rm(target, { force: true }).catch((error) => { cleanupError ??= error; });
    }
    if (runtime) {
      cleanupReceipt = await runtime.stop(cancelled ? 'cancelled' : 'execution_complete').catch((error) => {
        cleanupError ??= error;
        return null;
      });
    }
    await fsp.rm(privateRoot, { recursive: true, force: true }).then(() => {
      privateOutputDeleted = true;
    }).catch((error) => { cleanupError ??= error; });
    await pruneScreenshotOutput(screenshotsRoot, parsed.proof).catch((error) => { cleanupError ??= error; });
  }

  let changed = false;
  if (before) {
    try {
      changed = JSON.stringify(before) !== JSON.stringify(deps.snapshotTrackedFiles(roots.candidate))
        || !deps.candidateTrackedClean(roots.candidate);
    } catch { changed = true; }
  }
  if (changed) {
    reason = 'source_changed';
    cancelled = false;
    stale = false;
  } else if (cleanupError) {
    reason = 'runner_failed';
    cancelled = false;
    stale = false;
  }
  const evidence = evidenceManifest(roots.evidence, parsed.proof);
  validateEvidenceManifest(roots.evidence, evidence);
  const agent = agentResult ? publicAgentResult(agentResult, parsed) : {
    summary: 'The browser agent did not produce a complete validated result.',
    scenarios: incompleteScenarios(),
    findings: [],
  };
  const outcome = deriveReportOutcome({
    cancelled, stale, infrastructureReason: reason,
    evidenceComplete: parsed.complete,
    agentResult: agentResult && parsed.complete ? agent : null,
    deterministicResults: deterministic,
  });
  const stopped = cleanupReceipt?.processes?.filter((item) => item.outcome === 'stopped').length ?? 0;
  const report = {
    schema_version: 1, request, tested_head_sha: request.head.sha, controller_sha: request.controller_sha,
    started_at: startedAt, finished_at: new Date().toISOString(), tools,
    status: outcome.status, reason: outcome.reason, deterministic_results: deterministic,
    scenarios: agent.scenarios, findings: agent.findings, tool_calls: parsed.toolCalls, evidence,
    ...(parsed.usage ? { usage: parsed.usage } : {}),
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

async function main() {
  const options = parseCli(process.argv.slice(2));
  const controller = new AbortController();
  let interrupted;
  const onInt = () => { interrupted = 'SIGINT'; controller.abort(); };
  const onTerm = () => { interrupted = 'SIGTERM'; controller.abort(); };
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  try {
    const result = await runExecution({ ...options, signal: controller.signal });
    process.stdout.write(`${JSON.stringify({ status: result.report.status, reason: result.report.reason, report: result.reportPath })}\n`);
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  }
  if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
}

module.exports = Object.freeze({
  ALLOWED_TOOLS, ExecutionError, INTERNAL_DEADLINE_MS, agentPrompt, deadlineFromJobStart, resultContract,
  parseCli, runExecution, snapshotTrackedFiles,
});

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? error.name}: ${error.message}\n`);
    process.exitCode = ['USAGE', 'INVALID_PATH', 'INVALID_JOB_START'].includes(error.code) ? 2 : 1;
  });
}
