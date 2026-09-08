'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  EXCLUDED_PORTS,
  ProcessSupervisor,
  RuntimeError,
  allocateLoopbackPorts,
  fetchJsonUntil,
  identityMatches,
  monotonicDeadlineAfter,
  readProcessIdentity,
  reclaimStaleManifest,
  remainingMilliseconds,
  sanitizedChildEnvironment,
} = require('../runtime.cjs')

const fixtures = path.join(__dirname, 'fixtures')

async function temporaryDirectory(t, name) {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), `${name}-`))
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }))
  return directory
}

async function waitFor(check, message, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(message)
}

function pidExists(pid) {
  return readProcessIdentity(pid) !== null
}

async function listen(port = 0) {
  const server = net.createServer(socket => socket.end('sentinel'))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}

test('monotonic deadlines have explicit millisecond semantics', () => {
  const deadline = monotonicDeadlineAfter(500)
  assert.ok(remainingMilliseconds(deadline) <= 500)
  assert.ok(remainingMilliseconds(deadline) > 0)
  assert.throws(() => monotonicDeadlineAfter(0), { code: 'INVALID_DEADLINE' })
  assert.throws(() => remainingMilliseconds(Date.now()), { code: 'INVALID_DEADLINE' })
})

test('CLI rejects malformed or incomplete probe input before starting children', () => {
  const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'runtime.cjs'), 'probe'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^USAGE: Both --candidate and --evidence are required/m)
})

test('child environment preserves HOME and excludes credentials', async t => {
  const root = await temporaryDirectory(t, 'runtime-env')
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'runtime-secret-canary'
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  })
  const environment = sanitizedChildEnvironment(root, { GODS_EYE_USE_FIXTURES: 'true' })
  assert.equal(environment.HOME, process.env.HOME)
  assert.equal(environment.GITHUB_TOKEN, undefined)
  assert.equal(environment.SSH_AUTH_SOCK, undefined)
  assert.equal(environment.AWS_ACCESS_KEY_ID, undefined)
  assert.equal(environment.GODS_EYE_USE_FIXTURES, 'true')
  assert.equal(environment.TMPDIR, path.join(root, 'tmp'))
})

test('supervised children use a short private temporary directory when the run root is long', async t => {
  const root = await temporaryDirectory(t, 'runtime-long-root')
  const evidenceRoot = path.join(root, 'long-evidence-segment-'.repeat(7))
  const runRoot = path.join(evidenceRoot, 'runtime-fixed')
  const receipt = path.join(root, 'child-tmpdir.txt')
  const sentinel = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gods-eye-agent-qa-unrelated-'))
  t.after(() => fsPromises.rm(sentinel, { recursive: true, force: true }))
  await fsPromises.mkdir(evidenceRoot, { recursive: true })

  const supervisor = await new ProcessSupervisor({ runRoot, deadline: monotonicDeadlineAfter(5000) }).initialize()
  t.after(() => supervisor.stop('test_cleanup'))
  await supervisor.runToDeadline('capture-tmpdir', process.execPath, [
    '-e', "require('node:fs').writeFileSync(process.argv[1], process.env.TMPDIR)", receipt,
  ], { cwd: root, env: sanitizedChildEnvironment(runRoot) })

  const childTemporaryDirectory = await fsPromises.readFile(receipt, 'utf8')
  assert.ok(runRoot.length > 150, `test run root was only ${runRoot.length} characters`)
  assert.equal(path.dirname(childTemporaryDirectory), path.resolve(os.tmpdir()))
  assert.match(path.basename(childTemporaryDirectory), /^gods-eye-agent-qa-/)
  assert.ok(childTemporaryDirectory.length < 80, `child TMPDIR was ${childTemporaryDirectory.length} characters`)
  assert.equal(fs.statSync(childTemporaryDirectory).mode & 0o777, 0o700)

  const cleanup = await supervisor.stop('normal')
  assert.equal(fs.existsSync(childTemporaryDirectory), false)
  assert.equal(fs.existsSync(sentinel), true)
  assert.deepEqual(
    cleanup.paths.find(item => item.kind === 'temporary-directory'),
    { path: childTemporaryDirectory, kind: 'temporary-directory', cleanup: true, outcome: 'removed' },
  )
})

test('port allocation is separate, loopback-bindable, and excludes developer ports', async t => {
  const attempts = await Promise.allSettled([...EXCLUDED_PORTS].map(port => listen(port)))
  const sentinels = attempts.filter(result => result.status === 'fulfilled').map(result => result.value)
  t.after(() => Promise.all(sentinels.map(server => new Promise(resolve => server.close(resolve)))))
  const ports = await allocateLoopbackPorts()
  assert.notEqual(ports.api, ports.web)
  assert.equal(EXCLUDED_PORTS.has(ports.api), false)
  assert.equal(EXCLUDED_PORTS.has(ports.web), false)
  const probes = await Promise.all([listen(ports.api), listen(ports.web)])
  await Promise.all(probes.map(server => new Promise(resolve => server.close(resolve))))
  for (const server of sentinels) assert.equal(server.listening, true)
})

test('readiness rejects a healthy response with the wrong fixture identity', async t => {
  const helper = path.join(fixtures, 'runtime-http.cjs')
  const port = (await allocateLoopbackPorts()).api
  const server = childProcess.spawn(process.execPath, [helper, String(port), JSON.stringify({
    ready: true,
    model_id: 'real/model',
    active_index_version: 'real-index',
    gallery_count: 100,
  })], { stdio: 'ignore' })
  t.after(() => server.kill('SIGTERM'))
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}`)).ok } catch { return false }
  }, 'wrong-identity helper did not start')
  await assert.rejects(fetchJsonUntil(`http://127.0.0.1:${port}`, {
    deadline: monotonicDeadlineAfter(1000),
    label: 'wrong fixture',
    accept: payload => payload.model_id === 'fixture' || 'wrong fixture identity',
  }), error => error.code === 'WRONG_FIXTURE_IDENTITY')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`an actual ${signal} invokes scoped cleanup for the owned grandchild`, async t => {
    const root = await temporaryDirectory(t, `runtime-real-${signal.toLowerCase()}`)
    const signalReceipt = path.join(root, 'signal.json')
    const owner = childProcess.spawn(process.execPath, [
      path.join(fixtures, 'runtime-signal-owner.cjs'), root, signalReceipt,
    ], { stdio: 'ignore' })
    t.after(() => { if (pidExists(owner.pid)) owner.kill('SIGKILL') })
    await waitFor(async () => {
      const content = await fsPromises.readFile(path.join(root, 'pids.txt'), 'utf8').catch(() => '')
      return fs.existsSync(path.join(root, 'ready')) && content.includes('child=')
    }, 'signal owner and grandchild did not become ready')
    const pids = Object.fromEntries((await fsPromises.readFile(path.join(root, 'pids.txt'), 'utf8')).trim().split('\n').map(line => line.split('=')))
    owner.kill(signal)
    await waitFor(() => fs.existsSync(signalReceipt), 'signal cleanup receipt was not written')
    await waitFor(() => !pidExists(Number(pids.parent)) && !pidExists(Number(pids.child)), 'signal left owned descendants alive')
    const receipt = JSON.parse(await fsPromises.readFile(signalReceipt, 'utf8'))
    assert.equal(receipt.signal, signal)
    assert.equal(receipt.error, null)
    assert.equal(receipt.cleanup.allProcessesStopped, true)
    const temporaryPath = receipt.cleanup.paths.find(item => item.kind === 'temporary-directory')
    assert.equal(temporaryPath.outcome, 'removed')
    assert.equal(fs.existsSync(temporaryPath.path), false)
  })
}

test('repeated interrupts during cleanup do not widen or duplicate process termination', async t => {
  const root = await temporaryDirectory(t, 'runtime-repeated-interrupt')
  const signalReceipt = path.join(root, 'signal.json')
  const owner = childProcess.spawn(process.execPath, [
    path.join(fixtures, 'runtime-signal-owner.cjs'), root, signalReceipt,
  ], { stdio: 'ignore' })
  t.after(() => { if (pidExists(owner.pid)) owner.kill('SIGKILL') })
  await waitFor(async () => {
    const content = await fsPromises.readFile(path.join(root, 'pids.txt'), 'utf8').catch(() => '')
    return content.includes('child=')
  }, 'repeated-interrupt process tree did not become ready')
  owner.kill('SIGINT')
  await new Promise(resolve => setTimeout(resolve, 10))
  owner.kill('SIGTERM')
  await waitFor(() => fs.existsSync(signalReceipt), 'repeated-interrupt cleanup receipt was not written')
  const receipt = JSON.parse(await fsPromises.readFile(signalReceipt, 'utf8'))
  assert.equal(receipt.signal, 'SIGINT')
  assert.equal(receipt.cleanup.processes.length, 1)
  assert.equal(receipt.cleanup.allProcessesStopped, true)
})

for (const reason of ['SIGINT', 'SIGTERM']) {
  test(`scoped ${reason} cleanup stops an owned parent and grandchild`, async t => {
    const root = await temporaryDirectory(t, `runtime-${reason.toLowerCase()}`)
    const receipt = path.join(root, 'pids.txt')
    const supervisor = await new ProcessSupervisor({ runRoot: path.join(root, 'run'), deadline: monotonicDeadlineAfter(5000) }).initialize()
    const record = await supervisor.spawn('tree', process.execPath, [
      path.join(fixtures, 'runtime-grandchild.cjs'), 'parent', receipt,
    ], { cwd: root, env: sanitizedChildEnvironment(root) })
    await waitFor(async () => (await fsPromises.readFile(receipt, 'utf8').catch(() => '')).includes('child='), 'grandchild did not start')
    const pids = Object.fromEntries((await fsPromises.readFile(receipt, 'utf8')).trim().split('\n').map(line => line.split('=')))
    assert.equal(identityMatches(record.identity), true)
    const cleanup = await supervisor.stop(reason)
    await waitFor(() => !pidExists(Number(pids.parent)) && !pidExists(Number(pids.child)), 'owned process tree survived cleanup')
    assert.equal(cleanup.allProcessesStopped, true)
    assert.deepEqual(cleanup.processes[0].signals, ['SIGTERM'])
  })
}

test('TERM escalation kills an owned group whose descendants ignore TERM', async t => {
  const root = await temporaryDirectory(t, 'runtime-escalation')
  const receipt = path.join(root, 'pids.txt')
  const supervisor = await new ProcessSupervisor({ runRoot: path.join(root, 'run'), deadline: monotonicDeadlineAfter(5000) }).initialize()
  await supervisor.spawn('stubborn-tree', process.execPath, [
    path.join(fixtures, 'runtime-grandchild.cjs'), 'parent', receipt,
  ], { cwd: root, env: { ...sanitizedChildEnvironment(root), RUNTIME_IGNORE_TERM: '1' } })
  await waitFor(async () => (await fsPromises.readFile(receipt, 'utf8').catch(() => '')).includes('child='), 'stubborn grandchild did not start')
  const cleanup = await supervisor.stop('timeout')
  assert.deepEqual(cleanup.processes[0].signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(cleanup.processes[0].outcome, 'stopped')
})

test('cleanup stops an owned descendant after its recorded group leader exits', async t => {
  const root = await temporaryDirectory(t, 'runtime-orphan')
  const receipt = path.join(root, 'pids.txt')
  const supervisor = await new ProcessSupervisor({ runRoot: path.join(root, 'run'), deadline: monotonicDeadlineAfter(5000) }).initialize()
  const record = await supervisor.spawn('orphan-tree', process.execPath, [
    path.join(fixtures, 'runtime-grandchild.cjs'), 'orphan-parent', receipt,
  ], { cwd: root, env: sanitizedChildEnvironment(root) })
  await waitFor(async () => {
    const content = await fsPromises.readFile(receipt, 'utf8').catch(() => '')
    return content.includes('child=') && !identityMatches(record.identity)
  }, 'group leader did not exit while its child remained')
  const childPid = Number((await fsPromises.readFile(receipt, 'utf8')).match(/child=(\d+)/)[1])
  assert.equal(pidExists(childPid), true)
  const cleanup = await supervisor.stop('orphan_cleanup')
  await waitFor(() => !pidExists(childPid), 'owned orphan descendant survived cleanup')
  assert.equal(cleanup.processes[0].outcome, 'stopped')
})

test('runToDeadline stops the owned group when the shared deadline expires', async t => {
  const root = await temporaryDirectory(t, 'runtime-deadline')
  const supervisor = await new ProcessSupervisor({ runRoot: path.join(root, 'run'), deadline: monotonicDeadlineAfter(150) }).initialize()
  await assert.rejects(
    supervisor.runToDeadline('deadline-tree', process.execPath, [
      path.join(fixtures, 'runtime-grandchild.cjs'), 'parent', path.join(root, 'pids.txt'),
    ], { cwd: root, env: sanitizedChildEnvironment(root) }),
    error => error instanceof RuntimeError && error.code === 'DEADLINE_EXCEEDED',
  )
  assert.equal(JSON.parse(await fsPromises.readFile(supervisor.manifestPath, 'utf8')).processes.length, 0)
  await supervisor.stop('test_complete')
})

test('a persistent server group is cleaned when the supervisor deadline arrives', async t => {
  const root = await temporaryDirectory(t, 'runtime-persistent-deadline')
  const supervisor = await new ProcessSupervisor({ runRoot: path.join(root, 'run'), deadline: monotonicDeadlineAfter(150) }).initialize()
  const record = await supervisor.spawn('persistent', process.execPath, [
    path.join(fixtures, 'runtime-grandchild.cjs'), 'parent', path.join(root, 'pids.txt'),
  ], { cwd: root, env: sanitizedChildEnvironment(root) })
  await waitFor(() => fs.existsSync(supervisor.receiptPath), 'deadline cleanup receipt was not written')
  await waitFor(() => !identityMatches(record.identity), 'persistent group leader survived the shared deadline')
  const cleanup = JSON.parse(await fsPromises.readFile(supervisor.receiptPath, 'utf8'))
  assert.equal(cleanup.reason, 'deadline')
  assert.equal(cleanup.allProcessesStopped, true)
  const temporaryPath = cleanup.paths.find(item => item.kind === 'temporary-directory')
  assert.equal(temporaryPath.outcome, 'removed')
  assert.equal(fs.existsSync(temporaryPath.path), false)
})

test('stale manifest refuses a reused PID identity and leaves the unrelated process alive', async t => {
  const root = await temporaryDirectory(t, 'runtime-stale')
  const unrelatedTemporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gods-eye-agent-qa-unrelated-'))
  t.after(() => fsPromises.rm(unrelatedTemporaryDirectory, { recursive: true, force: true }))
  const sentinel = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  t.after(() => {
    try { process.kill(-sentinel.pid, 'SIGKILL') } catch {}
  })
  await new Promise(resolve => sentinel.once('spawn', resolve))
  const identity = readProcessIdentity(sentinel.pid)
  const manifest = path.join(root, 'processes.json')
  await fsPromises.writeFile(manifest, JSON.stringify({
    version: 1,
    runRoot: root,
    processes: [{ name: 'stale', identity: { ...identity, startTicks: `${identity.startTicks}0` } }],
    ownedPaths: [{ path: unrelatedTemporaryDirectory, kind: 'temporary-directory', cleanup: true }],
  }))
  const results = await reclaimStaleManifest({ manifestPath: manifest, runRoot: root })
  assert.equal(results[0].outcome, 'identity_mismatch')
  assert.equal(pidExists(sentinel.pid), true)
  assert.equal(fs.existsSync(unrelatedTemporaryDirectory), true)
})

test('cleanup removes only registered run children and preserves auth and sentinels', async t => {
  const root = await temporaryDirectory(t, 'runtime-paths')
  const auth = path.join(root, 'auth.json')
  await fsPromises.writeFile(auth, 'auth-byte-sentinel')
  const runRoot = path.join(root, 'run')
  const supervisor = await new ProcessSupervisor({ runRoot, deadline: monotonicDeadlineAfter(5000) }).initialize()
  const owned = path.join(runRoot, 'assets')
  await fsPromises.mkdir(owned)
  await fsPromises.writeFile(path.join(owned, 'fixture'), 'x')
  supervisor.registerOwnedPath(owned, 'fixture-assets')
  assert.throws(() => supervisor.registerOwnedPath(auth, 'auth'), { code: 'PATH_OUTSIDE_RUN' })
  const cleanup = await supervisor.stop('normal')
  assert.equal(fs.existsSync(owned), false)
  assert.equal(await fsPromises.readFile(auth, 'utf8'), 'auth-byte-sentinel')
  assert.equal(cleanup.paths[0].outcome, 'removed')
})
