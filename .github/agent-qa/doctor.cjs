#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED = Object.freeze({
  runner: '2.337.0',
  copilot: '1.0.83',
  claude: '2.1.283',
  bun: '1.3.14',
  playwright_mcp: '0.0.80',
  node: '24.12.0',
  uv: '0.12.6',
  pnpm: '10.15.0',
});

function usage() {
  return 'Usage: node doctor.cjs --json [--phase start]\n';
}

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 15_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function versionFrom(text) {
  return text.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] || null;
}

function agentTokenReadiness(token) {
  // A secret stored from a file or `echo` keeps a trailing newline, which GitHub rejects as bad credentials.
  const wellFormed = token === token.trim() && !/\s/u.test(token);
  return { present: token.trim().length >= 20 && wellFormed, wellFormed };
}

function modeOf(target) {
  try {
    return (fs.statSync(target).mode & 0o777).toString(8).padStart(4, '0');
  } catch {
    return null;
  }
}

function ownedByCurrentUser(target) {
  try {
    return typeof process.getuid !== 'function' || fs.statSync(target).uid === process.getuid();
  } catch {
    return false;
  }
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function add(checks, name, ok, metadata = {}) {
  checks.push({ name, ok: Boolean(ok), ...metadata });
}

function probePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.close((error) => resolve(!error));
    });
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

async function runDoctor({ env = process.env, phase = 'status', agent = 'copilot' } = {}) {
  if (!['copilot', 'claude'].includes(agent)) throw new Error(`Unsupported Agent QA agent: ${agent}`);
  const home = env.HOME || os.homedir();
  const qaRoot = path.resolve(env.QA_ROOT || path.join(home, '.local/share/gods-eye-agent-qa'));
  const inWorkflow = env.GITHUB_ACTIONS === 'true';
  // Inside a job the working directory is the runner workspace, which lives under QA_ROOT by design.
  // Only a declared developer checkout can be compared against the CI state root.
  const declaredCheckout = env.QA_DEVELOPER_CHECKOUT || (inWorkflow ? '' : process.cwd());
  const checkout = declaredCheckout ? path.resolve(declaredCheckout) : '';
  const runnerDir = path.join(qaRoot, 'runner');
  const toolchainDir = path.join(qaRoot, 'toolchain');
  const repo = env.QA_REPOSITORY || 'jayn2u/gods-eye';
  const checks = [];

  let realQaRoot = qaRoot;
  let realCheckout = checkout;
  try { realQaRoot = fs.realpathSync(qaRoot); } catch {}
  try { if (checkout) realCheckout = fs.realpathSync(checkout); } catch {}
  const separateFromCheckout = checkout === ''
    || (!inside(realCheckout, realQaRoot) && !inside(realQaRoot, realCheckout));
  const pathSafe = path.isAbsolute(qaRoot) && separateFromCheckout
    && path.resolve(qaRoot) !== path.resolve(path.join(home, '.copilot'));
  add(checks, 'paths', pathSafe, {
    outside_developer_checkout: pathSafe,
    developer_checkout: checkout ? 'declared' : 'not-applicable',
  });

  const rootMode = modeOf(qaRoot);
  const toolchainMode = modeOf(toolchainDir);
  const ownershipOk = [qaRoot, runnerDir, toolchainDir]
    .every((target) => ownedByCurrentUser(target));
  add(checks, 'ownership', ownershipOk, { current_user: ownershipOk });
  add(checks, 'permissions', rootMode === '0700' && toolchainMode === '0700', {
    qa_root_mode: rootMode,
    toolchain_mode: toolchainMode,
  });

  const runnerVersion = (() => {
    try { return fs.readFileSync(path.join(runnerDir, '.runner-version'), 'utf8').trim(); } catch { return null; }
  })();
  add(checks, 'runner_tool', runnerVersion === EXPECTED.runner && fs.existsSync(path.join(runnerDir, 'run.sh')), {
    present: fs.existsSync(path.join(runnerDir, 'run.sh')),
    version: runnerVersion,
  });

  const bins = {
    copilot: env.QA_COPILOT_BIN || path.join(toolchainDir, 'node_modules/.bin/copilot'),
    claude: env.QA_CLAUDE_BIN || path.join(toolchainDir, 'node_modules/@anthropic-ai/claude-code-linux-x64/claude'),
    bun: env.QA_BUN_BIN || path.join(toolchainDir, 'node_modules/@oven/bun-linux-x64/bin/bun'),
    playwright_mcp: env.QA_PLAYWRIGHT_MCP_BIN || path.join(toolchainDir, 'node_modules/.bin/playwright-mcp'),
    uv: env.QA_UV_BIN || 'uv',
    pnpm: env.QA_PNPM_BIN || 'pnpm',
  };
  const versions = { node: process.versions.node };
  const agentTools = agent === 'claude' ? ['claude', 'bun'] : ['copilot'];
  const versionCommands = [
    ...agentTools.map((name) => [name, ['--version']]),
    ['playwright_mcp', ['--version']],
    ['uv', ['--version']],
    ['pnpm', ['--version']],
  ];
  let versionCommandsOk = true;
  for (const [name, args] of versionCommands) {
    const result = command(bins[name], args, { env });
    versionCommandsOk &&= result.ok;
    versions[name] = versionFrom(`${result.stdout}\n${result.stderr}`);
  }
  const pinned = ['node', ...agentTools, 'playwright_mcp'];
  const versionsOk = versionCommandsOk
    && pinned.every((name) => versions[name] === EXPECTED[name])
    && ['uv', 'pnpm'].every((name) => typeof versions[name] === 'string' && versions[name].length > 0);
  add(checks, 'tool_versions', versionsOk, { agent, ...versions, pinned: pinned.join(',') });

  const browserProbe = env.QA_BROWSER_PROBE_BIN
    ? command(env.QA_BROWSER_PROBE_BIN, [], { cwd: toolchainDir, env, timeout: 30_000 })
    : command(process.execPath, ['-e', "require('playwright').chromium.launch({headless:true}).then(async b=>{await b.close()}).catch(e=>{console.error(e.message);process.exit(1)})"], {
      cwd: toolchainDir,
      env: { ...env, PLAYWRIGHT_BROWSERS_PATH: path.join(toolchainDir, 'browsers') },
      timeout: 30_000,
    });
  add(checks, 'browser', browserProbe.ok, { available: browserProbe.ok });
  const portOk = await probePort();
  add(checks, 'loopback_port', portOk, { allocatable: portOk });

  const ghBin = env.QA_GH_BIN || 'gh';
  const repoResult = command(ghBin, ['repo', 'view', repo, '--json', 'nameWithOwner,isPrivate'], { env });
  const repoData = parseJson(repoResult.stdout);
  const privateRepo = repoResult.ok && repoData?.nameWithOwner === repo && repoData?.isPrivate === true;
  add(checks, 'repository', privateRepo, { identity_matches: repoData?.nameWithOwner === repo, private: repoData?.isPrivate === true });

  const runnersResult = command(ghBin, ['api', `repos/${repo}/actions/runners`, '--paginate', '--slurp'], { env });
  const runnersData = parseJson(runnersResult.stdout);
  const runners = Array.isArray(runnersData) ? runnersData.flatMap((page) => page.runners || []) : runnersData?.runners || [];
  const named = runners.filter((runner) => runner?.name === 'gods-eye-agent-qa');
  const localRunner = parseJson((() => {
    try { return fs.readFileSync(path.join(runnerDir, '.runner'), 'utf8'); } catch { return ''; }
  })());
  const localConfigured = localRunner?.agentName === 'gods-eye-agent-qa'
    && localRunner?.gitHubUrl === `https://github.com/${repo}`;
  const runnerRegistered = runnersResult.ok && named.length === 1
    && (named[0].labels || []).some((label) => label?.name === 'gods-eye-agent-qa') && localConfigured;
  add(checks, 'runner_registration', runnerRegistered, {
    registered: runnerRegistered,
    exact_count: named.length,
    local_configured: localConfigured,
  });

  const systemctlBin = env.QA_SYSTEMCTL_BIN || 'systemctl';
  const serviceResult = command(systemctlBin, ['--user', 'is-active', 'gods-eye-agent-qa-runner.service'], { env });
  add(checks, 'runner_service', serviceResult.ok && serviceResult.stdout.trim() === 'active', {
    active: serviceResult.ok && serviceResult.stdout.trim() === 'active',
    required: phase !== 'start',
  });
  const loginctlBin = env.QA_LOGINCTL_BIN || 'loginctl';
  const currentUser = env.QA_CURRENT_USER || os.userInfo().username;
  const lingerResult = command(loginctlBin, ['show-user', currentUser, '--property=Linger', '--value'], { env });
  const lingerEnabled = lingerResult.ok && lingerResult.stdout.trim() === 'yes';
  add(checks, 'user_linger', lingerEnabled, { enabled: lingerEnabled });

  // Copilot CLI authenticates from COPILOT_GITHUB_TOKEN and exposes no read-only login-status
  // command, so readiness is the presence of a non-empty repository-scoped token plus the absence of
  // competing provider credentials. A token that is present is not proof that Copilot will answer;
  // the first run reports auth_required if it does not.
  const foreignVariables = ['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY'];
  const foreignEnvironment = foreignVariables.some((name) => Boolean(env[name]));
  const tokenVariable = agent === 'claude' ? 'QA_CLAUDE_TOKEN' : 'QA_COPILOT_TOKEN';
  const token = env[tokenVariable] || '';
  const { present: tokenPresent, wellFormed: tokenWellFormed } = agentTokenReadiness(token);
  // The token reaches the agent only from the workflow secret, so it is absent when an operator runs
  // a read-only check from a shell. Require it inside Actions and report its absence honestly outside.
  const prepare = phase === 'prepare';
  add(checks, 'subscription_auth', (prepare || tokenPresent || !inWorkflow) && !foreignEnvironment, {
    token_present: tokenPresent,
    token_well_formed: token.length === 0 || tokenWellFormed,
    token_source: prepare ? 'agent-step' : tokenPresent ? tokenVariable : inWorkflow ? 'missing' : 'workflow-secret',
    required: prepare ? false : inWorkflow,
    foreign_provider_environment: foreignEnvironment,
  });

  const ok = checks.every((check) => check.ok || (phase === 'start' && check.name === 'runner_service'));
  return { schema_version: 1, ok, phase, checks };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage());
    return;
  }
  if (!args.includes('--json')) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }
  const statusArgs = args.length === 1 && args[0] === '--json';
  const startArgs = args.length === 3 && args[0] === '--json' && args[1] === '--phase' && args[2] === 'start';
  if (!statusArgs && !startArgs) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }
  const phase = startArgs ? 'start' : 'status';
  const report = await runDoctor({ phase });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

module.exports = { EXPECTED, agentTokenReadiness, runDoctor, versionFrom };

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ schema_version: 1, ok: false, phase: 'status', checks: [{ name: 'doctor', ok: false }] })}\n`);
    process.exitCode = 1;
  });
}
