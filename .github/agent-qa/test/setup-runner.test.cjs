'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const setup = path.join(projectRoot, '.github/agent-qa/setup-runner.sh');

function executable(target, body) {
  fs.writeFileSync(target, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o700 });
}

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-qa-setup-'));
  t.after(() => {
    fs.rmSync(temp, { recursive: true, force: true });
    assert.equal(fs.existsSync(temp), false);
  });
  const qaRoot = path.join(temp, 'qa-root');
  const source = path.join(temp, 'toolchain-source');
  const systemd = path.join(temp, 'systemd');
  const state = path.join(temp, 'state');
  const testHome = path.join(temp, 'home');
  fs.mkdirSync(source);
  fs.mkdirSync(state);
  fs.mkdirSync(path.join(testHome, '.copilot'), { recursive: true });
  fs.writeFileSync(path.join(testHome, '.copilot/mcp-config.json'), 'DEVELOPER_CONFIG_SENTINEL');
  fs.writeFileSync(path.join(source, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(path.join(source, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');

  const archiveRoot = path.join(temp, 'archive-root');
  fs.mkdirSync(archiveRoot);
  executable(path.join(archiveRoot, 'run.sh'), 'exit 0');
  executable(path.join(archiveRoot, 'config.sh'), String.raw`
name=''; labels=''; url=''
while (($#)); do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --labels) labels="$2"; shift 2 ;;
    --url) url="$2"; shift 2 ;;
    --token) shift 2 ;;
    *) shift ;;
  esac
done
printf '%s|%s|%s\n' "$name" "$labels" "$url" >"$QA_TEST_STATE/registered"
printf '\357\273\277%s' '{"agentName":"gods-eye-agent-qa","gitHubUrl":"https://github.com/jayn2u/gods-eye"}' > .runner
printf '%s' 'runner-credential-marker' > .credentials
printf '%s' 'runner-rsa-marker' > .credentials_rsaparams
chmod 664 .runner .credentials
chmod 600 .credentials_rsaparams`);
  const archive = path.join(temp, 'runner.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', archiveRoot, '.']);
  const digest = execFileSync('sha256sum', [archive], { encoding: 'utf8' }).split(/\s+/)[0];

  const npm = path.join(temp, 'npm');
  executable(npm, String.raw`
prefix=''
while (($#)); do if [[ "$1" == '--prefix' ]]; then prefix="$2"; shift 2; else shift; fi; done
mkdir -p "$prefix/node_modules/.bin"
cat >"$prefix/node_modules/.bin/copilot" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == '--version' ]]; then printf 'GitHub Copilot CLI 1.0.83.\nRun '\\''copilot update'\\'' to check for updates.\n'; exit; fi
printf '%s\n' "$*" >>"$QA_TEST_STATE/copilot-calls"
exit 1
EOF
chmod 700 "$prefix/node_modules/.bin/copilot"`);
  const browserInstall = path.join(temp, 'browser-install');
  executable(browserInstall, String.raw`mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"; : >"$PLAYWRIGHT_BROWSERS_PATH/installed"`);

  const gh = path.join(temp, 'gh');
  executable(gh, String.raw`
if [[ "$1" == 'repo' ]]; then printf '{"nameWithOwner":"jayn2u/gods-eye","isPrivate":true}\n'; exit; fi
if [[ "$*" == *'registration-token'* ]]; then printf 'REGISTRATION_TOKEN_CANARY\n'; exit; fi
if [[ -f "$QA_TEST_STATE/registered" ]]; then
  printf '{"runners":[{"name":"gods-eye-agent-qa","labels":[{"name":"gods-eye-agent-qa"}]}]}\n'
else
  printf '{"runners":[]}\n'
fi`);
  const systemctl = path.join(temp, 'systemctl');
  executable(systemctl, String.raw`
printf '%s
' "$*" >>"$QA_TEST_STATE/systemctl-calls"
printf 'active
'`);
  const pinnedNode = path.join(temp, 'node');
  executable(pinnedNode, `if [[ "\${1:-}" == '--version' ]]; then echo 'v24.12.0'; exit; fi; exit 1`);
  const loginctl = path.join(temp, 'loginctl');
  executable(loginctl, `printf 'yes\\n'`);
  const uv = path.join(temp, 'uv');
  executable(uv, `printf 'uv 0.12.6\\n'`);
  const pnpm = path.join(temp, 'pnpm');
  executable(pnpm, `printf '10.15.0\\n'`);
  const browserProbe = path.join(temp, 'browser-probe');
  executable(browserProbe, 'exit 0');
  const mcp = path.join(temp, 'playwright-mcp');
  executable(mcp, `printf 'Version 0.0.80\\n'`);

  const env = {
    ...process.env,
    HOME: testHome,
    QA_ROOT: qaRoot,
    QA_DEVELOPER_CHECKOUT: projectRoot,
    QA_SYSTEMD_DIR: systemd,
    QA_TEST_ADAPTERS: '1',
    QA_TEST_RUNNER_ARCHIVE_PATH: archive,
    QA_TEST_RUNNER_SHA256: digest,
    QA_TEST_TOOLCHAIN_SOURCE: source,
    QA_TEST_BROWSER_INSTALL_BIN: browserInstall,
    QA_NPM_BIN: npm,
    QA_GH_BIN: gh,
    QA_SYSTEMCTL_BIN: systemctl,
    QA_LOGINCTL_BIN: loginctl,
    QA_NODE_BIN: pinnedNode,
    QA_UV_BIN: uv,
    QA_PNPM_BIN: pnpm,
    QA_BROWSER_PROBE_BIN: browserProbe,
    QA_PLAYWRIGHT_MCP_BIN: mcp,
    QA_TEST_STATE: state,
  };
  return { temp, qaRoot, pinnedNode, source, systemd, state, testHome, archive, env };
}

test('install is idempotent, stores no agent credential, and preserves unrelated files', (t) => {
  const f = fixture(t);
  const first = execFileSync('bash', [setup, 'install'], { env: f.env, encoding: 'utf8' });
  fs.writeFileSync(path.join(f.qaRoot, 'unrelated-sentinel'), 'keep-me');
  const second = execFileSync('bash', [setup, 'install'], { env: f.env, encoding: 'utf8' });

  assert.match(first, /Installed runner 2\.337\.0/);
  assert.match(second, /Installed runner 2\.337\.0/);
  assert.doesNotMatch(`${first}${second}`, /DEVELOPER_CONFIG_SENTINEL/);
  assert.equal(fs.readFileSync(path.join(f.qaRoot, 'unrelated-sentinel'), 'utf8'), 'keep-me');
  // The agent authenticates from the workflow secret, so no credential directory is created here.
  assert.equal(fs.existsSync(path.join(f.qaRoot, 'codex-home')), false);
  assert.equal(fs.existsSync(path.join(f.qaRoot, 'copilot-home')), false);
  assert.equal(fs.readFileSync(path.join(f.testHome, '.copilot/mcp-config.json'), 'utf8'), 'DEVELOPER_CONFIG_SENTINEL');
  assert.equal(fs.statSync(f.qaRoot).mode & 0o777, 0o700);
  const unit = fs.readFileSync(path.join(f.systemd, 'gods-eye-agent-qa-runner.service'), 'utf8');
  assert.match(unit, new RegExp(`WorkingDirectory=${f.qaRoot}/runner`));
  assert.match(unit, /TimeoutStopSec=60/);
  assert.doesNotMatch(unit, /DISABLEUPDATE|--disableupdate/i);
});

test('install writes a systemd-parseable unit for a QA root with spaces and percent', (t) => {
  const f = fixture(t);
  const qaRoot = path.join(f.temp, 'qa root % value');
  const result = execFileSync('bash', [setup, 'install'], {
    env: { ...f.env, QA_ROOT: qaRoot }, encoding: 'utf8',
  });
  assert.match(result, /Installed runner 2\.337\.0/);
  const unit = path.join(f.systemd, 'gods-eye-agent-qa-runner.service');
  const parsed = spawnSync('systemd-analyze', ['--user', 'verify', unit], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, `${parsed.stdout}${parsed.stderr}`);
  assert.match(fs.readFileSync(unit, 'utf8'), new RegExp(`WorkingDirectory=${qaRoot.replaceAll(' ', '\\\\x20').replace('%', '%%')}/runner`));
});

test('install rejects a runner archive with the wrong digest', (t) => {
  const f = fixture(t);
  const result = spawnSync('bash', [setup, 'install'], {
    env: { ...f.env, QA_TEST_RUNNER_SHA256: '0'.repeat(64) }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum verification failed/);
  assert.equal(fs.existsSync(path.join(f.qaRoot, 'runner/.runner-version')), false);
});

test('register uses the exact repository, name, and label once without exposing its token', (t) => {
  const f = fixture(t);
  execFileSync('bash', [setup, 'install'], { env: f.env });
  const first = execFileSync('bash', [setup, 'register'], { env: f.env, encoding: 'utf8' });
  const second = execFileSync('bash', [setup, 'register'], { env: f.env, encoding: 'utf8' });
  assert.equal(fs.readFileSync(path.join(f.state, 'registered'), 'utf8').trim(),
    'gods-eye-agent-qa|gods-eye-agent-qa|https://github.com/jayn2u/gods-eye');
  assert.match(first, /Registered runner gods-eye-agent-qa/);
  assert.match(second, /already registered/);
  assert.doesNotMatch(`${first}${second}`, /REGISTRATION_TOKEN_CANARY/);
  for (const stateFile of ['.runner', '.credentials', '.credentials_rsaparams']) {
    assert.equal(fs.statSync(path.join(f.qaRoot, 'runner', stateFile)).mode & 0o777, 0o600);
  }
  fs.writeFileSync(path.join(f.qaRoot, 'register-auth-sentinel'),
    '{"sentinel":"STATUS_SECRET_CANARY"}', { mode: 0o600 });
  fs.writeFileSync(path.join(f.qaRoot, 'register-refreshed-sentinel'), 'refreshed');
  const status = spawnSync('bash', [setup, 'status'], { env: f.env, encoding: 'utf8' });
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).ok, true);
  assert.equal(fs.readFileSync(path.join(f.qaRoot, 'register-refreshed-sentinel'), 'utf8'), 'refreshed');
  assert.doesNotMatch(`${status.stdout}${status.stderr}`, /STATUS_SECRET_CANARY/);
});

test('register rejects a conflicting remote runner without requesting a token', (t) => {
  const f = fixture(t);
  execFileSync('bash', [setup, 'install'], { env: f.env });
  fs.writeFileSync(path.join(f.state, 'registered'), 'remote-conflict');
  const result = spawnSync('bash', [setup, 'register'], { env: f.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conflicting/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /REGISTRATION_TOKEN_CANARY/);
});

test('there is no login subcommand and no agent credential is ever written', (t) => {
  const f = fixture(t);
  execFileSync('bash', [setup, 'install'], { env: f.env });
  execFileSync('bash', [setup, 'register'], { env: f.env });
  for (const args of [['login'], ['login', '--device-auth'], ['login', '--with-api-key'], ['token', 'x']]) {
    const result = spawnSync('bash', [setup, ...args], { env: f.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(f.state, 'copilot-calls')), false);
  assert.equal(fs.existsSync(path.join(f.qaRoot, 'codex-home')), false);
  assert.equal(fs.readFileSync(path.join(f.testHome, '.copilot/mcp-config.json'), 'utf8'), 'DEVELOPER_CONFIG_SENTINEL');
  const started = execFileSync('bash', [setup, 'start'], { env: f.env, encoding: 'utf8' });
  assert.match(started, /Started gods-eye-agent-qa-runner\.service/);
});

test('the unit unsets every competing provider credential and pins the copilot binary', (t) => {
  const f = fixture(t);
  execFileSync('bash', [setup, 'install'], { env: f.env });
  const unit = fs.readFileSync(path.join(f.systemd, 'gods-eye-agent-qa-runner.service'), 'utf8');
  for (const name of ['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'COPILOT_GITHUB_TOKEN']) {
    assert.match(unit, new RegExp(`UnsetEnvironment=.*\\b${name}\\b`), name);
  }
  assert.match(unit, /QA_COPILOT_BIN=.*node_modules\/\.bin\/copilot/);
  assert.doesNotMatch(unit, /CODEX_HOME|QA_CODEX_BIN/);
});

test('the unit pins the verified Node directory on PATH instead of inheriting an ambient one', (t) => {
  const f = fixture(t);
  execFileSync('bash', [setup, 'install'], { env: f.env });
  const unit = fs.readFileSync(path.join(f.systemd, 'gods-eye-agent-qa-runner.service'), 'utf8');
  const pinnedDir = path.dirname(f.pinnedNode);
  // A version-managed Node is invisible to the systemd user manager, so the pin must be explicit.
  assert.match(unit, new RegExp(`Environment="PATH=${pinnedDir}:`));
  assert.match(unit, /Environment="PATH=[^"]*:\/usr\/bin:/);
  // Pinning only Node would hide uv and pnpm, which live wherever their own installers put them.
  const declared = /Environment="PATH=([^"]*)"/u.exec(unit)[1].split(':');
  for (const tool of [f.env.QA_UV_BIN, f.env.QA_PNPM_BIN]) {
    assert.ok(declared.includes(path.dirname(tool)), `${tool} directory must be on the unit PATH`);
  }
  assert.equal(new Set(declared).size, declared.length, 'the unit PATH must not repeat a directory');
});

test('install refuses to write a unit when a required host tool is absent', async (t) => {
  for (const missing of ['QA_UV_BIN', 'QA_PNPM_BIN']) {
    await t.test(missing, (subtest) => {
      const f = fixture(subtest);
      const result = spawnSync('bash', [setup, 'install'], {
        env: { ...f.env, [missing]: path.join(f.temp, 'absent-tool') }, encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /is not executable|is not on PATH/);
      assert.equal(fs.existsSync(path.join(f.systemd, 'gods-eye-agent-qa-runner.service')), false);
    });
  }
});

test('install refuses a Node that does not satisfy the pin', (t) => {
  const f = fixture(t);
  const wrong = path.join(f.temp, 'wrong-node');
  executable(wrong, `if [[ "\${1:-}" == '--version' ]]; then echo 'v20.20.2'; exit; fi; exit 1`);
  const result = spawnSync('bash', [setup, 'install'], {
    env: { ...f.env, QA_NODE_BIN: wrong }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /node 24\.12\.0 is required/);
  assert.equal(fs.existsSync(path.join(f.systemd, 'gods-eye-agent-qa-runner.service')), false);
});

test('start restarts the service so a rewritten unit cannot keep running the old environment', (t) => {
  const f = fixture(t);
  execFileSync('bash', [setup, 'install'], { env: f.env });
  execFileSync('bash', [setup, 'register'], { env: f.env });
  execFileSync('bash', [setup, 'start'], { env: f.env });
  const calls = fs.readFileSync(path.join(f.state, 'systemctl-calls'), 'utf8');
  assert.match(calls, /daemon-reload/);
  assert.match(calls, /restart gods-eye-agent-qa-runner\.service/);
});

test('help exposes only the non-destructive lifecycle commands', () => {
  const output = execFileSync('bash', [setup, '--help'], { encoding: 'utf8' });
  for (const command of ['install', 'register', 'start', 'status']) assert.match(output, new RegExp(command));
  assert.doesNotMatch(output, /^\s*login\b/mu);
  assert.match(output, /AGENT_QA_COPILOT_TOKEN/);
  assert.doesNotMatch(output, /reset|reinstall/);
});

test('malformed commands fail without changing a QA root', (t) => {
  const f = fixture(t);
  const result = spawnSync('bash', [setup, 'reset'], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(fs.existsSync(f.qaRoot), false);
});

test('install resumes after repeated process-group interruptions', async (t) => {
  const f = fixture(t);
  const npmBody = fs.readFileSync(f.env.QA_NPM_BIN, 'utf8');
  executable(f.env.QA_NPM_BIN, ': >"$QA_TEST_STATE/npm-started"; sleep 30');

  async function interruptOnce() {
    fs.rmSync(path.join(f.state, 'npm-started'), { force: true });
    const child = spawn('bash', [setup, 'install'], {
      env: f.env,
      detached: true,
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(f.state, 'npm-started')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(path.join(f.state, 'npm-started')), true);
    process.kill(-child.pid, 'SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }

  await interruptOnce();
  await interruptOnce();
  fs.writeFileSync(f.env.QA_NPM_BIN, npmBody, { mode: 0o700 });
  const resumed = execFileSync('bash', [setup, 'install'], { env: f.env, encoding: 'utf8' });
  assert.match(resumed, /Installed runner 2\.337\.0/);
  assert.equal(fs.readFileSync(path.join(f.testHome, '.copilot/mcp-config.json'), 'utf8'), 'DEVELOPER_CONFIG_SENTINEL');
  assert.deepEqual(fs.readdirSync(f.qaRoot).filter((name) => name.startsWith('.runner.')), []);
});
