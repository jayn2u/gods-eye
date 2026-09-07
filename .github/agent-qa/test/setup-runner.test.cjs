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
  fs.mkdirSync(path.join(testHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(testHome, '.codex/auth.json'), 'DEVELOPER_AUTH_SENTINEL');
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
cat >"$prefix/node_modules/.bin/codex" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == '--version' ]]; then echo 'codex-cli 0.153.3'; exit; fi
if [[ "$1" == 'login' && "$#" -ge 2 && "$2" == 'status' ]]; then echo 'Logged in using ChatGPT'; exit; fi
if [[ "$1" == 'login' ]]; then
  if [[ -v OPENAI_API_KEY ]]; then api_key='set'; else api_key='unset'; fi
  printf '%s\t%s\t%s\n' "$CODEX_HOME" "$*" "$api_key" >>"$QA_TEST_STATE/codex-login-calls"
  printf '{"auth_mode":"chatgpt","tokens":{"access_token":"LOGIN_CANARY"}}' >"$CODEX_HOME/auth.json"
  exit
fi
exit 1
EOF
chmod 700 "$prefix/node_modules/.bin/codex"`);
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
  executable(systemctl, `printf 'active\\n'`);
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
    QA_UV_BIN: uv,
    QA_PNPM_BIN: pnpm,
    QA_BROWSER_PROBE_BIN: browserProbe,
    QA_PLAYWRIGHT_MCP_BIN: mcp,
    QA_TEST_STATE: state,
  };
  return { temp, qaRoot, source, systemd, state, testHome, archive, env };
}

test('install is idempotent and preserves CI auth and unrelated files', (t) => {
  const f = fixture(t);
  const first = execFileSync('bash', [setup, 'install'], { env: f.env, encoding: 'utf8' });
  fs.writeFileSync(path.join(f.qaRoot, 'codex-home/auth.json'), '{"auth_mode":"chatgpt","sentinel":"AUTH_CANARY"}', { mode: 0o600 });
  fs.writeFileSync(path.join(f.qaRoot, 'unrelated-sentinel'), 'keep-me');
  fs.writeFileSync(path.join(f.qaRoot, 'codex-home/refreshed-sentinel'), 'keep-refreshed');
  const second = execFileSync('bash', [setup, 'install'], { env: f.env, encoding: 'utf8' });

  assert.match(first, /Installed runner 2\.337\.0/);
  assert.match(second, /Installed runner 2\.337\.0/);
  assert.doesNotMatch(`${first}${second}`, /DEVELOPER_AUTH_SENTINEL/);
  assert.equal(fs.readFileSync(path.join(f.qaRoot, 'unrelated-sentinel'), 'utf8'), 'keep-me');
  assert.equal(fs.readFileSync(path.join(f.qaRoot, 'codex-home/refreshed-sentinel'), 'utf8'), 'keep-refreshed');
  assert.match(fs.readFileSync(path.join(f.qaRoot, 'codex-home/auth.json'), 'utf8'), /AUTH_CANARY/);
  assert.equal(fs.readFileSync(path.join(f.testHome, '.codex/auth.json'), 'utf8'), 'DEVELOPER_AUTH_SENTINEL');
  assert.notEqual(fs.readFileSync(path.join(f.qaRoot, 'codex-home/auth.json'), 'utf8'), 'DEVELOPER_AUTH_SENTINEL');
  assert.equal(fs.statSync(f.qaRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.qaRoot, 'codex-home/auth.json')).mode & 0o777, 0o600);
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
  fs.writeFileSync(path.join(f.qaRoot, 'codex-home/auth.json'),
    '{"auth_mode":"chatgpt","tokens":{"access_token":"STATUS_SECRET_CANARY"}}', { mode: 0o600 });
  fs.writeFileSync(path.join(f.qaRoot, 'codex-home/refreshed-sentinel'), 'refreshed');
  const status = spawnSync('bash', [setup, 'status'], { env: f.env, encoding: 'utf8' });
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).ok, true);
  assert.equal(fs.readFileSync(path.join(f.qaRoot, 'codex-home/refreshed-sentinel'), 'utf8'), 'refreshed');
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

test('device-auth login fails on an occupied auth lock before invoking Codex', (t) => {
  const f = fixture(t);
  execFileSync('bash', [setup, 'install'], { env: f.env });
  const flock = path.join(f.temp, 'busy-flock');
  executable(flock, 'exit 1');
  const result = spawnSync('bash', [setup, 'login', '--device-auth'], {
    env: { ...f.env, QA_FLOCK_BIN: flock }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /auth lock is occupied/);
  assert.equal(fs.existsSync(path.join(f.qaRoot, 'codex-home/auth.json')), false);
  assert.equal(fs.existsSync(path.join(f.state, 'codex-login-calls')), false);
});

test('bare and device-auth login use only the CI auth home after all preflight checks pass', (t) => {
  const f = fixture(t);
  execFileSync('bash', [setup, 'install'], { env: f.env });
  execFileSync('bash', [setup, 'register'], { env: f.env });
  fs.writeFileSync(path.join(f.qaRoot, 'codex-home/refreshed-sentinel'), 'preserve-me');
  execFileSync('bash', [setup, 'login'], { env: { ...f.env, OPENAI_API_KEY: 'API_KEY_SENTINEL' } });
  execFileSync('bash', [setup, 'login', '--device-auth'], { env: { ...f.env, OPENAI_API_KEY: 'API_KEY_SENTINEL' } });
  const ciAuth = fs.readFileSync(path.join(f.qaRoot, 'codex-home/auth.json'), 'utf8');
  assert.match(ciAuth, /"auth_mode":"chatgpt"/);
  assert.equal(fs.statSync(path.join(f.qaRoot, 'codex-home/auth.json')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(f.qaRoot, 'codex-home/refreshed-sentinel'), 'utf8'), 'preserve-me');
  assert.equal(fs.readFileSync(path.join(f.testHome, '.codex/auth.json'), 'utf8'), 'DEVELOPER_AUTH_SENTINEL');
  assert.deepEqual(
    fs.readFileSync(path.join(f.state, 'codex-login-calls'), 'utf8').trim().split('\n'),
    [`${path.join(f.qaRoot, 'codex-home')}\tlogin\tunset`, `${path.join(f.qaRoot, 'codex-home')}\tlogin --device-auth\tunset`],
  );
  const started = execFileSync('bash', [setup, 'start'], { env: f.env, encoding: 'utf8' });
  assert.match(started, /Started gods-eye-agent-qa-runner\.service/);
});

test('login rejects unallowlisted and extra options without invoking Codex', (t) => {
  const f = fixture(t);
  execFileSync('bash', [setup, 'install'], { env: f.env });
  for (const args of [
    ['login', '--with-api-key'],
    ['login', '--device-auth', '--enable', 'unsafe'],
  ]) {
    const result = spawnSync('bash', [setup, ...args], { env: f.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /only accepts|at most one option/);
  }
  assert.equal(fs.existsSync(path.join(f.state, 'codex-login-calls')), false);
  assert.equal(fs.existsSync(path.join(f.qaRoot, 'codex-home/auth.json')), false);
});

test('help exposes only the non-destructive lifecycle commands', () => {
  const output = execFileSync('bash', [setup, '--help'], { encoding: 'utf8' });
  for (const command of ['install', 'register', 'login', 'start', 'status']) assert.match(output, new RegExp(command));
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
  assert.equal(fs.readFileSync(path.join(f.testHome, '.codex/auth.json'), 'utf8'), 'DEVELOPER_AUTH_SENTINEL');
  assert.deepEqual(fs.readdirSync(f.qaRoot).filter((name) => name.startsWith('.runner.')), []);
});
