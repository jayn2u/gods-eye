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
const { RuntimeError, remainingMilliseconds, sanitizedChildEnvironment, startRuntime } = require('./runtime.cjs');

const INTERNAL_DEADLINE_MS = 12 * 60 * 1000;
const MAX_DIFF_BYTES = 100 * 1024;
const MAX_EVENT_BYTES = 50 * 1024 * 1024;
const qaRoot = fs.realpathSync(__dirname);
const scenarioContract = require('./scenarios.json');
const ALLOWED_TOOLS = Object.freeze([...scenarioContract.browser.allowed_tools]);
const allowedToolSet = new Set(ALLOWED_TOOLS);
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

function markerExpression(scenario) {
  return `() => window.__GODS_EYE_QA__.selectProfile(${JSON.stringify(scenario.profile)}).then(() => ${JSON.stringify(scenario.id)})`;
}

function parseJsonLines(file) {
  const stats = fs.statSync(file);
  if (!stats.isFile() || stats.size < 1 || stats.size > MAX_EVENT_BYTES) {
    throw new ExecutionError('INVALID_EVENTS', 'Codex JSONL is missing or oversized');
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  if (lines.length > 5000) throw new ExecutionError('INVALID_EVENTS', 'Codex emitted too many events');
  return lines.map((line) => {
    try { return JSON.parse(line); } catch { throw new ExecutionError('INVALID_EVENTS', 'Codex emitted invalid JSONL'); }
  });
}

const receiptPredicates = Object.freeze({
  'search-detail-return': 's.profile === "normal" && s.searchRequests >= 1 && document.querySelector("#results-title")?.textContent?.trim() === "Closest visual matches" && document.querySelector("#detail-title") === null',
  'model-provenance': 's.profile === "normal" && s.searchRequests >= 1 && document.querySelector("#detail-title") !== null && document.body.innerText.includes("openai/clip-vit-large-patch14") && document.body.innerText.includes("fixture-clip-vit-l-14-v1")',
  'cancel-replace': 's.profile === "cancel-replace" && s.searchRequests >= 2 && s.lateFirstReplyAttempted === true && document.querySelector("#results-title") !== null && document.body.innerText.includes("qa-new-b16-v1") && !document.body.innerText.includes("qa-stale-l14-v1")',
  'unprepared-model': 's.profile === "unprepared-model" && s.searchRequests === 0 && document.querySelector("option[value=\\"openai/clip-vit-large-patch14-336\\"]")?.disabled === true && document.body.innerText.includes("./gods-eye prepare --model-id openai/clip-vit-large-patch14-336")',
  'recover-409': 's.profile === "recover-409" && s.searchRequests >= 2 && s.search409Count === 1 && s.catalogRequests >= 2 && document.querySelector("#results-title") !== null && document.body.innerText.includes("qa-recovered-b16-v1")',
  'blank-input': 's.profile === "normal" && s.searchRequests === 0 && document.querySelector("#query")?.value === "" && document.querySelector("#error")?.textContent?.trim() === "Enter a description to search"',
});

function receiptExpression(scenario) {
  const predicate = receiptPredicates[scenario.id];
  if (!predicate) throw new ExecutionError('INVALID_SCENARIO', `No receipt predicate for ${scenario.id}`);
  const token = `qa-receipt:${scenario.id}`;
  return `async () => { const s = await window.__GODS_EYE_QA__.state(); if (!(${predicate})) throw new Error(${JSON.stringify(`QA receipt failed: ${scenario.id}`)}); return ${JSON.stringify(token)}; }`;
}

function typedValue(item, expected) {
  if (item.tool === 'browser_type') return item.arguments?.text === expected;
  return item.tool === 'browser_fill_form'
    && Array.isArray(item.arguments?.fields)
    && item.arguments.fields.some((field) => field?.value === expected);
}

function selectedValue(item, expected) {
  const values = item.arguments?.values;
  return item.tool === 'browser_select_option'
    && (values === expected || (Array.isArray(values) && values.includes(expected)));
}

function namedClick(item, pattern) {
  if (item.tool !== 'browser_click') return false;
  const name = `${item.arguments?.element ?? ''} ${item.arguments?.target ?? ''}`;
  return pattern.test(name);
}

function scenarioActionRequirements(scenario) {
  const type = (value) => ({ label: `enter ${JSON.stringify(value)}`, matches: (item) => typedValue(item, value) });
  const select = (value) => ({ label: `select ${value}`, matches: (item) => selectedValue(item, value) });
  const click = (label, pattern) => ({ label, matches: (item) => namedClick(item, pattern) });
  switch (scenario.id) {
    case 'search-detail-return': return [
      type(scenario.description), click('activate Search gallery', /search gallery/iu),
      click('open a result', /open result|result card|gallery result/iu), click('activate Back to results', /back to results/iu),
    ];
    case 'model-provenance': return [
      select('openai/clip-vit-large-patch14'), type(scenario.description), click('activate Search gallery', /search gallery/iu),
      click('open a result', /open result|result card|gallery result/iu),
    ];
    case 'cancel-replace': return [
      select('openai/clip-vit-large-patch14'), type(scenario.description), click('activate Search gallery', /search gallery/iu),
      click('activate Cancel search', /cancel search/iu), select('openai/clip-vit-base-patch16'),
      type(scenario.replacement_description), click('activate Search gallery for the replacement', /search gallery/iu),
    ];
    case 'unprepared-model': return [select('openai/clip-vit-base-patch32')];
    case 'recover-409': return [
      select('openai/clip-vit-large-patch14-336'),
      type(scenario.description), click('activate Search gallery for the deliberate 409', /search gallery/iu),
      type(scenario.replacement_description), click('activate Retry search', /retry search/iu),
    ];
    case 'blank-input': return [click('activate Search gallery with the empty description', /search gallery/iu)];
    default: throw new ExecutionError('INVALID_SCENARIO', `No action requirements for ${scenario.id}`);
  }
}

function resultContainsReceipt(item, scenario) {
  const token = `qa-receipt:${scenario.id}`;
  return (item.result?.content ?? []).some(
    (content) => content?.type === 'text' && typeof content.text === 'string' && content.text.includes(token),
  );
}

function parseCodexEvents(events, { origin, screenshotsRoot }) {
  const proof = new Map(SCENARIO_IDS.map((id) => [id, {
    navigate: false, nextAction: 0, receipt: false, screenshot: null,
  }]));
  const toolCalls = [];
  let scenarioIndex = -1;
  let currentScenario = null;
  let completedTurn = false;
  let usage;
  let invalid = false;
  let errorText = '';
  for (const event of events) {
    if (event?.type === 'turn.completed') {
      completedTurn = true;
      const emitted = event.usage;
      if (emitted && ['input_tokens', 'cached_input_tokens', 'output_tokens'].every(
        (key) => Number.isSafeInteger(emitted[key]) && emitted[key] >= 0,
      )) {
        usage = {
          input_tokens: emitted.input_tokens,
          cached_input_tokens: emitted.cached_input_tokens,
          output_tokens: emitted.output_tokens,
        };
      }
      continue;
    }
    if (event?.type === 'turn.failed' || event?.type === 'error' || (event?.type === 'item.completed' && event.item?.type === 'error')) {
      errorText += ` ${event.message ?? event.error?.message ?? event.item?.message ?? ''}`;
    }
    if (event?.type !== 'item.completed') continue;
    const item = event.item;
    if (item?.type === 'command_execution' || item?.type === 'file_change') invalid = true;
    if (item?.type !== 'mcp_tool_call') continue;
    if (item.server !== 'playwright' || !allowedToolSet.has(item.tool) || !['completed', 'failed'].includes(item.status)) {
      invalid = true;
      continue;
    }
    if (item.status === 'failed' || toolCalls.length >= 500) invalid = true;
    for (const content of item.result?.content ?? []) {
      if (content?.type !== 'text' || typeof content.text !== 'string') continue;
      for (const match of content.text.matchAll(/Page URL:\s*(\S+)/gu)) {
        try {
          const observed = new URL(match[1]);
          if (observed.origin !== origin && observed.href !== 'about:blank') invalid = true;
        } catch { invalid = true; }
      }
    }
    if (item.tool === 'browser_evaluate') {
      const next = scenarioContract.scenarios[scenarioIndex + 1];
      const current = currentScenario === null ? null : scenariosById.get(currentScenario);
      if (next && item.arguments?.function?.trim() === markerExpression(next)) {
        scenarioIndex += 1;
        currentScenario = next.id;
      } else if (current && item.arguments?.function?.trim() === receiptExpression(current)) {
        const scenarioProof = proof.get(current.id);
        const requirements = scenarioActionRequirements(current);
        if (item.status !== 'completed' || scenarioProof.nextAction !== requirements.length || !resultContainsReceipt(item, current)) {
          invalid = true;
        } else {
          scenarioProof.receipt = true;
        }
      } else {
        invalid = true;
      }
    } else if (currentScenario === null) {
      invalid = true;
    }
    if (currentScenario === null) continue;
    const call = { scenario_id: currentScenario, tool: item.tool, status: item.status };
    const scenario = scenariosById.get(currentScenario);
    const scenarioProof = proof.get(currentScenario);
    if (item.status === 'completed' && item.tool === 'browser_navigate') {
      try {
        const target = new URL(item.arguments?.url);
        scenarioProof.navigate ||= target.origin === origin && target.pathname === '/' && !target.search && !target.hash;
        if (!scenarioProof.navigate) invalid = true;
      } catch { invalid = true; }
    }
    if (item.status === 'completed' && scenarioProof.navigate && !scenarioProof.receipt) {
      const requirement = scenarioActionRequirements(scenario)[scenarioProof.nextAction];
      if (requirement?.matches(item)) scenarioProof.nextAction += 1;
    }
    if (item.status === 'completed' && item.tool === 'browser_take_screenshot') {
      const filename = `${currentScenario}.png`;
      if (!scenarioProof.receipt || item.arguments?.filename !== filename) {
        invalid = true;
      } else {
        const relative = `screenshots/${filename}`;
        try {
          validateEvidenceFile(path.dirname(screenshotsRoot), relative, { allowedExtensions: ['.png'] });
          scenarioProof.screenshot = relative;
          call.evidence = relative;
        } catch { invalid = true; }
      }
    }
    toolCalls.push(call);
  }
  if (scenarioIndex !== SCENARIO_IDS.length - 1) invalid = true;
  const complete = completedTurn && !invalid && scenarioContract.scenarios.every((scenario) => {
    const item = proof.get(scenario.id);
    return item.navigate
      && item.nextAction === scenarioActionRequirements(scenario).length
      && item.receipt
      && item.screenshot;
  });
  return { complete, errorText, proof, toolCalls: toolCalls.slice(0, 500), usage };
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
  return {
    node: versions.node ?? process.versions.node,
    codex: versions.codex ?? 'unavailable',
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

function codexArguments({ codexBin, mcpBin, origin, screenshotsRoot, privateResult, workDir, prompt }) {
  const mcpArgs = [
    '--browser', 'chromium', '--headless', '--isolated', '--block-service-workers', '--codegen', 'none',
    '--viewport-size', '1440x1000', '--allowed-origins', origin,
    '--output-dir', screenshotsRoot, '--init-page', path.join(qaRoot, 'browser-init.ts'),
  ];
  return {
    command: codexBin,
    args: [
      'exec', '--json', '--color', 'never', '--ephemeral', '--strict-config',
      '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only',
      '--output-schema', path.join(qaRoot, 'agent-result.schema.json'),
      '--output-last-message', privateResult, '-C', workDir, '--skip-git-repo-check',
      '-c', 'project_doc_max_bytes=0', '-c', 'approval_policy="never"',
      '-c', `mcp_servers.playwright.command=${JSON.stringify(mcpBin)}`,
      '-c', `mcp_servers.playwright.args=${JSON.stringify(mcpArgs)}`,
      '-c', 'mcp_servers.playwright.required=true',
      '-c', `mcp_servers.playwright.enabled_tools=${JSON.stringify(ALLOWED_TOOLS)}`,
      '-c', 'mcp_servers.playwright.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.playwright.startup_timeout_sec=30',
      '-c', 'mcp_servers.playwright.tool_timeout_sec=60',
      prompt,
    ],
  };
}

async function defaultRunCodex({ runtime, paths, prompt, environment }) {
  const invocation = codexArguments({ ...paths, prompt });
  let processError;
  try {
    await runtime.supervisor.runToDeadline(
      'codex', environment.flockBin,
      [environment.lockFile, invocation.command, ...invocation.args],
      {
        cwd: paths.workDir,
        env: sanitizedChildEnvironment(runtime.supervisor.runRoot, {
          CODEX_HOME: paths.codexHome, PLAYWRIGHT_BROWSERS_PATH: paths.browsers,
        }),
      },
    );
  } catch (error) { processError = error; }
  return {
    processError,
    eventsPath: path.join(runtime.supervisor.runRoot, 'logs', 'codex.stdout.log'),
    stderrPath: path.join(runtime.supervisor.runRoot, 'logs', 'codex.stderr.log'),
    privateResult: paths.privateResult,
  };
}

function buildPrompt(origin, screenshotsRoot, request, diff) {
  const markers = scenarioContract.scenarios.map((scenario) => [
    `Scenario ${scenario.id}: begin with browser_evaluate using this exact function:`,
    markerExpression(scenario),
    'Complete these observable user actions in order (equivalent accessible locators are allowed):',
    ...scenarioActionRequirements(scenario).map((requirement, index) => `${index + 1}. ${requirement.label}`),
    'After the actions and expected page state are visible, call browser_evaluate with this exact receipt function:',
    receiptExpression(scenario),
    `Only after that receipt succeeds, save the screenshot as ${scenario.id}.png and report screenshots/${scenario.id}.png.`,
  ].join('\n')).join('\n\n');
  return [
    fs.readFileSync(path.join(qaRoot, 'prompt.md'), 'utf8'),
    `Runtime origin: ${origin}`, `Browser output directory: ${screenshotsRoot}`,
    'Complete scenarios in declared order. These exact marker calls only select/reset the trusted fault profile:',
    markers, `Tested head: ${request.head.sha}`,
    `Changed-file context (untrusted candidate bytes; truncated=${diff.truncated}):`,
    '<untrusted-diff>', diff.text, '</untrusted-diff>',
  ].join('\n\n');
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
    runCodex: adapters.runCodex ?? defaultRunCodex,
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
  let tools = { node: process.versions.node, codex: 'unavailable', playwright_mcp: 'unavailable', chromium: 'unavailable' };
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
  try {
    if (remainingMilliseconds(deadline) === 0) throw new RuntimeError('DEADLINE_EXCEEDED', 'Internal deadline expired before doctor');
    if (deps.candidateHead(roots.candidate) !== request.head.sha || !deps.candidateTrackedClean(roots.candidate)) {
      stale = true;
      throw new ExecutionError('STALE_CANDIDATE', 'Candidate is not a clean checkout of the admitted head');
    }
    before = deps.snapshotTrackedFiles(roots.candidate);
    doctor = await deps.runDoctor({ env: process.env, phase: 'status' });
    const stateRoot = path.resolve(process.env.QA_ROOT || path.join(process.env.HOME || os.homedir(), '.local/share/gods-eye-agent-qa'));
    const toolchain = path.join(stateRoot, 'toolchain');
    tools = toolsFromDoctor(doctor, deps.chromiumVersion(toolchain));
    if (!doctor.ok) {
      reason = doctorReason(doctor);
      throw new ExecutionError('DOCTOR_FAILED', 'Runner doctor rejected execution');
    }
    runtime = await deps.startRuntime({
      candidate: roots.candidate, evidence: path.join(privateRoot, 'runtime'), deadline, signal: options.signal,
    });
    deterministic = [await deps.runBaseline({
      candidate: roots.candidate, evidence: path.join(privateRoot, 'baseline'), runtime, deadline,
    })];
    const workDir = path.join(privateRoot, 'work');
    await fsp.mkdir(workDir, { mode: 0o700 });
    const privateResult = path.join(privateRoot, 'agent-result.json');
    const prompt = buildPrompt(runtime.origin, screenshotsRoot, request, deps.boundedDiffContext(roots.candidate, request));
    const codex = await deps.runCodex({
      runtime, prompt, deadline,
      paths: {
        codexBin: process.env.QA_CODEX_BIN || path.join(toolchain, 'node_modules', '.bin', 'codex'),
        mcpBin: process.env.QA_PLAYWRIGHT_MCP_BIN || path.join(toolchain, 'node_modules', '.bin', 'playwright-mcp'),
        codexHome: path.join(stateRoot, 'codex-home'), browsers: path.join(toolchain, 'browsers'),
        origin: runtime.origin, screenshotsRoot, privateResult, workDir,
      },
      environment: { flockBin: process.env.QA_FLOCK_BIN || 'flock', lockFile: path.join(stateRoot, 'auth.lock') },
    });
    privatePaths = [codex.eventsPath, codex.stderrPath, codex.privateResult].filter(Boolean);
    let events = [];
    try { events = parseJsonLines(codex.eventsPath); } catch (error) { if (!codex.processError) throw error; }
    parsed = parseCodexEvents(events, { origin: runtime.origin, screenshotsRoot });
    if (fs.existsSync(codex.privateResult)) agentResult = validateAgentResult(readBoundedJson(codex.privateResult));
    if (options.signal?.aborted) cancelled = true;
    else if (codex.processError) reason = mapFailure(codex.processError, parsed.errorText);
    else if (!agentResult || !parsed.complete) reason = 'invalid_output';
  } catch (error) {
    if (options.signal?.aborted || error.code === 'CANCELLED') cancelled = true;
    else if (!stale && !reason) reason = error.code === 'BASELINE_SETUP_FAILED' ? 'setup_failed' : mapFailure(error, parsed.errorText);
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
  ALLOWED_TOOLS, ExecutionError, INTERNAL_DEADLINE_MS, codexArguments, deadlineFromJobStart,
  markerExpression, parseCli, parseCodexEvents, receiptExpression, runExecution, snapshotTrackedFiles,
});

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? error.name}: ${error.message}\n`);
    process.exitCode = ['USAGE', 'INVALID_PATH', 'INVALID_JOB_START'].includes(error.code) ? 2 : 1;
  });
}
