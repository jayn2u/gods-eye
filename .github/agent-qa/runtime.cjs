#!/usr/bin/env node
'use strict'

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { pathToFileURL } = require('node:url')

const EXCLUDED_PORTS = new Set([8000, 5173, 15173])
const DEFAULT_RUNTIME_MS = 12 * 60 * 1000
const FIXTURE_MODEL_ID = 'openai/clip-vit-base-patch16'
const FIXTURE_INDEX_VERSION = 'fixture-clip-vit-b-16-v1'
const MANIFEST_VERSION = 1
const TEMPORARY_DIRECTORY_PREFIX = 'gods-eye-agent-qa-'

class RuntimeError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'RuntimeError'
    this.code = code
    this.details = details
  }
}

function monotonicDeadlineAfter(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new RuntimeError('INVALID_DEADLINE', 'Deadline duration must be a positive number of milliseconds')
  }
  return performance.now() + milliseconds
}

function remainingMilliseconds(deadline) {
  if (!Number.isFinite(deadline) || deadline <= 0 || deadline > performance.now() + 24 * 60 * 60 * 1000) {
    throw new RuntimeError('INVALID_DEADLINE', 'Deadline must be an absolute monotonic millisecond value')
  }
  return Math.max(0, deadline - performance.now())
}

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new RuntimeError('INVALID_PATH', `${label} must be an absolute path`)
  }
  return path.resolve(value)
}

function isWithin(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function ensurePrivateDirectory(directory) {
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 })
  await fsPromises.chmod(directory, 0o700)
}

function sanitizedChildEnvironment(runtimeRoot, additions = {}) {
  const environment = {}
  for (const key of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[key]) environment[key] = process.env[key]
  }
  if (!environment.HOME) {
    throw new RuntimeError('MISSING_HOME', 'HOME is required and is preserved for child processes')
  }
  environment.CI = '1'
  environment.NO_COLOR = '1'
  environment.TMPDIR = path.join(runtimeRoot, 'tmp')
  for (const [key, value] of Object.entries(additions)) {
    if (typeof value !== 'string') throw new RuntimeError('INVALID_ENV', `Environment value for ${key} must be a string`)
    environment[key] = value
  }
  return environment
}

function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(') ')
    if (close < 0) return null
    const fields = stat.slice(close + 2).trim().split(/\s+/)
    const pgid = Number(fields[2])
    const startTicks = fields[19]
    if (!Number.isSafeInteger(pgid) || !startTicks) return null
    return { pid, pgid, startTicks, uid: fs.statSync(`/proc/${pid}`).uid }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null
    throw error
  }
}

function identityMatches(expected) {
  if (!expected || !Number.isSafeInteger(expected.pid) || typeof expected.startTicks !== 'string') return false
  const actual = readProcessIdentity(expected.pid)
  return Boolean(
    actual &&
      actual.pgid === expected.pgid &&
      actual.startTicks === expected.startTicks &&
      (expected.uid === null || actual.uid === expected.uid),
  )
}

function processGroupMembers(pgid) {
  const members = []
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const identity = readProcessIdentity(Number(entry))
    if (identity?.pgid === pgid) members.push(identity.pid)
  }
  return members
}

function processHasTokenDigest(pid, expectedDigest) {
  try {
    const entries = fs.readFileSync(`/proc/${pid}/environ`).toString().split('\0')
    const prefix = 'GODS_EYE_AGENT_QA_PROCESS_TOKEN='
    const entry = entries.find(value => value.startsWith(prefix))
    if (!entry) return false
    const digest = crypto.createHash('sha256').update(entry.slice(prefix.length)).digest('hex')
    return digest === expectedDigest
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH' || error.code === 'EACCES') return false
    throw error
  }
}

function ownsProcessGroup(record) {
  if (identityMatches(record.identity)) return true
  if (!/^[a-f0-9]{64}$/.test(record.tokenDigest ?? '')) return false
  return processGroupMembers(record.identity.pgid).some(pid => processHasTokenDigest(pid, record.tokenDigest))
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function waitForGroupExit(pgid, milliseconds) {
  const until = performance.now() + milliseconds
  while (performance.now() < until) {
    if (processGroupMembers(pgid).length === 0) return true
    await delay(25)
  }
  return processGroupMembers(pgid).length === 0
}

async function terminateMatchingGroup(record, graceMilliseconds = 1500) {
  if (!ownsProcessGroup(record)) {
    return { name: record.name, pid: record.identity.pid, pgid: record.identity.pgid, outcome: 'identity_mismatch' }
  }
  const result = { name: record.name, pid: record.identity.pid, pgid: record.identity.pgid, signals: [] }
  try {
    process.kill(-record.identity.pgid, 'SIGTERM')
    result.signals.push('SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  if (!(await waitForGroupExit(record.identity.pgid, graceMilliseconds))) {
    if (!ownsProcessGroup(record)) {
      result.outcome = 'leader_identity_changed'
      return result
    }
    try {
      process.kill(-record.identity.pgid, 'SIGKILL')
      result.signals.push('SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    await waitForGroupExit(record.identity.pgid, 500)
  }
  result.remainingPids = processGroupMembers(record.identity.pgid)
  result.outcome = result.remainingPids.length === 0 ? 'stopped' : 'still_running'
  return result
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  await fsPromises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fsPromises.chmod(temporary, 0o600)
  await fsPromises.rename(temporary, file)
}

class ProcessSupervisor {
  constructor({ runRoot, deadline }) {
    this.runRoot = assertAbsolutePath(runRoot, 'runRoot')
    this.deadline = deadline
    remainingMilliseconds(deadline)
    this.manifestPath = path.join(this.runRoot, 'processes.json')
    this.receiptPath = path.join(this.runRoot, 'cleanup.json')
    this.records = new Map()
    this.ownedPaths = []
    this.temporaryDirectory = null
    this.stopped = false
    this.stopPromise = null
    this.deadlineTimer = null
    this.manifestWrite = Promise.resolve()
  }

  async initialize() {
    await ensurePrivateDirectory(this.runRoot)
    await ensurePrivateDirectory(path.join(this.runRoot, 'logs'))
    try {
      this.temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), TEMPORARY_DIRECTORY_PREFIX))
      await fsPromises.chmod(this.temporaryDirectory, 0o700)
      this.ownedPaths.push({ path: this.temporaryDirectory, kind: 'temporary-directory', cleanup: true })
      await this.#writeManifest()
    } catch (error) {
      if (this.temporaryDirectory) await fsPromises.rm(this.temporaryDirectory, { recursive: true, force: true })
      throw error
    }
    this.deadlineTimer = setTimeout(() => { void this.stop('deadline') }, remainingMilliseconds(this.deadline) + 25)
    return this
  }

  registerOwnedPath(target, kind, cleanup = true) {
    const resolved = assertAbsolutePath(target, 'owned path')
    if (!isWithin(this.runRoot, resolved)) {
      throw new RuntimeError('PATH_OUTSIDE_RUN', `Owned path is outside run root: ${resolved}`)
    }
    this.ownedPaths.push({ path: resolved, kind, cleanup })
  }

  async #writeManifest() {
    const manifest = {
      version: MANIFEST_VERSION,
      ownerPid: process.pid,
      runRoot: this.runRoot,
      processes: [...this.records.values()].map(record => ({
        name: record.name,
        command: record.command,
        cwd: record.cwd,
        identity: record.identity,
        tokenDigest: record.tokenDigest,
      })),
      ownedPaths: this.ownedPaths,
    }
    this.manifestWrite = this.manifestWrite.then(() => writeJsonAtomic(this.manifestPath, manifest))
    await this.manifestWrite
  }

  async spawn(name, command, args, { cwd, env }) {
    if (this.stopped) throw new RuntimeError('SUPERVISOR_STOPPED', 'Cannot start a process after cleanup')
    if (!this.temporaryDirectory) throw new RuntimeError('SUPERVISOR_NOT_INITIALIZED', 'Cannot start a process before initialization')
    if (remainingMilliseconds(this.deadline) <= 0) throw new RuntimeError('DEADLINE_EXCEEDED', `Deadline expired before ${name}`)
    const resolvedCwd = assertAbsolutePath(cwd, `${name} cwd`)
    const stdoutPath = path.join(this.runRoot, 'logs', `${name}.stdout.log`)
    const stderrPath = path.join(this.runRoot, 'logs', `${name}.stderr.log`)
    const stdout = fs.openSync(stdoutPath, 'a', 0o600)
    const stderr = fs.openSync(stderrPath, 'a', 0o600)
    const processToken = crypto.randomUUID()
    const tokenDigest = crypto.createHash('sha256').update(processToken).digest('hex')
    let child
    try {
      child = childProcess.spawn(command, args, {
        cwd: resolvedCwd,
        env: { ...env, TMPDIR: this.temporaryDirectory, GODS_EYE_AGENT_QA_PROCESS_TOKEN: processToken },
        detached: true,
        stdio: ['ignore', stdout, stderr],
      })
    } finally {
      fs.closeSync(stdout)
      fs.closeSync(stderr)
    }
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    let identity = null
    for (let attempt = 0; attempt < 20 && !identity; attempt += 1) {
      identity = readProcessIdentity(child.pid)
      if (!identity) await delay(5)
    }
    if (!identity || identity.pgid !== child.pid) {
      try { child.kill('SIGKILL') } catch {}
      throw new RuntimeError('PROCESS_IDENTITY', `Could not establish an isolated process group for ${name}`)
    }
    const record = {
      name,
      command: [command, ...args],
      cwd: resolvedCwd,
      identity,
      tokenDigest,
      stdoutPath,
      stderrPath,
      child,
      exit: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
    }
    this.records.set(name, record)
    await this.#writeManifest()
    return record
  }

  async runToDeadline(name, command, args, options) {
    const record = await this.spawn(name, command, args, options)
    const wait = remainingMilliseconds(this.deadline)
    let timer
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve({ deadline: true }), wait)
    })
    const outcome = await Promise.race([record.exit, timeout])
    clearTimeout(timer)
    if (outcome.deadline) {
      await terminateMatchingGroup(record, 500)
      this.records.delete(name)
      await this.#writeManifest()
      throw new RuntimeError('DEADLINE_EXCEEDED', `Deadline expired while running ${name}`)
    }
    this.records.delete(name)
    await this.#writeManifest()
    if (remainingMilliseconds(this.deadline) === 0) {
      throw new RuntimeError('DEADLINE_EXCEEDED', `Deadline expired while running ${name}`)
    }
    if (outcome.code !== 0) {
      const stderr = await fsPromises.readFile(record.stderrPath, 'utf8').catch(() => '')
      throw new RuntimeError('PROCESS_FAILED', `${name} exited with ${outcome.code ?? outcome.signal}`, stderr.slice(-4000))
    }
    return { ...outcome, stdoutPath: record.stdoutPath, stderrPath: record.stderrPath }
  }

  async stopProcess(name, reason = 'targeted_cleanup') {
    const record = this.records.get(name)
    if (!record) return { name, outcome: 'not_running', reason }
    const result = await terminateMatchingGroup(record, 500)
    this.records.delete(name)
    await this.#writeManifest()
    return { ...result, reason }
  }

  async stop(reason = 'normal') {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.#performStop(reason)
    return this.stopPromise
  }

  async #performStop(reason) {
    this.stopped = true
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    const processResults = []
    for (const record of [...this.records.values()].reverse()) {
      processResults.push(await terminateMatchingGroup(record))
    }
    this.records.clear()
    await this.#writeManifest()
    const pathResults = []
    for (const owned of [...this.ownedPaths].reverse()) {
      if (!owned.cleanup) {
        pathResults.push({ ...owned, outcome: 'retained' })
        continue
      }
      const isRunChild = isWithin(this.runRoot, owned.path) && owned.path !== this.runRoot
      const isPrivateTemporaryDirectory = owned.kind === 'temporary-directory' &&
        owned.path === this.temporaryDirectory &&
        path.dirname(owned.path) === path.resolve(os.tmpdir()) &&
        path.basename(owned.path).startsWith(TEMPORARY_DIRECTORY_PREFIX)
      if (!isRunChild && !isPrivateTemporaryDirectory) {
        pathResults.push({ ...owned, outcome: 'refused' })
        continue
      }
      await fsPromises.rm(owned.path, { recursive: true, force: true })
      pathResults.push({ ...owned, outcome: 'removed' })
    }
    const receipt = {
      version: 1,
      reason,
      finishedAt: new Date().toISOString(),
      processes: processResults,
      paths: pathResults,
      allProcessesStopped: processResults.every(item => item.outcome === 'stopped' || item.outcome === 'identity_mismatch'),
    }
    await writeJsonAtomic(this.receiptPath, receipt)
    return receipt
  }
}

async function runToDeadline(command, args, options) {
  const supervisor = options.supervisor
  if (!(supervisor instanceof ProcessSupervisor)) {
    throw new RuntimeError('INVALID_SUPERVISOR', 'runToDeadline requires a ProcessSupervisor')
  }
  return supervisor.runToDeadline(options.name ?? path.basename(command), command, args, options)
}

async function allocateLoopbackPort(excluded = EXCLUDED_PORTS) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.unref()
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = server.address()
        const selected = typeof address === 'object' && address ? address.port : null
        server.close(error => (error ? reject(error) : resolve(selected)))
      })
    })
    if (Number.isSafeInteger(port) && !excluded.has(port)) return port
  }
  throw new RuntimeError('PORT_ALLOCATION', 'Could not allocate an allowed loopback port')
}

async function allocateLoopbackPorts() {
  const api = await allocateLoopbackPort()
  const web = await allocateLoopbackPort(new Set([...EXCLUDED_PORTS, api]))
  return { api, web }
}

async function fetchJsonUntil(url, { deadline, accept, label, processRecord, signal }) {
  let lastError = 'no response'
  while (remainingMilliseconds(deadline) > 0) {
    if (signal?.aborted) throw new RuntimeError('CANCELLED', `${label} was cancelled`)
    if (processRecord && !identityMatches(processRecord.identity)) {
      throw new RuntimeError('PROCESS_EXITED', `${processRecord.name} exited before ${label} became ready`)
    }
    try {
      const timeout = Math.max(1, Math.floor(Math.min(1000, remainingMilliseconds(deadline))))
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
      if (response.ok) {
        const payload = await response.json()
        const accepted = accept(payload)
        if (accepted === true) return payload
        if (typeof accepted === 'string') throw new RuntimeError('WRONG_FIXTURE_IDENTITY', accepted)
        lastError = `${response.status}: response not ready`
      } else {
        lastError = `HTTP ${response.status}`
      }
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'WRONG_FIXTURE_IDENTITY') throw error
      lastError = error.message
    }
    await delay(Math.min(100, remainingMilliseconds(deadline)))
  }
  throw new RuntimeError('DEADLINE_EXCEEDED', `${label} did not become ready before the shared deadline`, lastError)
}

function installSignalHandlers(supervisor, onSignal = () => {}) {
  if (!(supervisor instanceof ProcessSupervisor)) {
    throw new RuntimeError('INVALID_SUPERVISOR', 'Signal cleanup requires a ProcessSupervisor')
  }
  let handling = false
  const handlers = {}
  for (const signal of ['SIGINT', 'SIGTERM']) {
    handlers[signal] = () => {
      if (handling) return
      handling = true
      void supervisor.stop(signal).then(
        cleanup => onSignal(null, { signal, cleanup }),
        error => onSignal(error, { signal, cleanup: null }),
      )
    }
    process.on(signal, handlers[signal])
  }
  return () => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, handlers[signal])
  }
}

function validateCandidate(candidate) {
  const required = ['pyproject.toml', 'uv.lock', 'pnpm-lock.yaml', path.join('web', 'vite.config.ts')]
  for (const relative of required) {
    const target = path.join(candidate, relative)
    if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
      throw new RuntimeError('INVALID_CANDIDATE', `Candidate is missing ${relative}`)
    }
  }
}

async function createViteWrapper(candidate, runRoot, ports) {
  const candidateConfig = pathToFileURL(path.join(candidate, 'web', 'vite.config.ts')).href
  const viteModule = pathToFileURL(path.join(candidate, 'web', 'node_modules', 'vite', 'dist', 'node', 'index.js')).href
  const wrapper = path.join(runRoot, 'vite.runtime.config.mjs')
  const source = [
    `import candidateConfig from ${JSON.stringify(candidateConfig)}`,
    `import { mergeConfig } from ${JSON.stringify(viteModule)}`,
    'export default env => {',
    "  const resolved = typeof candidateConfig === 'function' ? candidateConfig(env) : candidateConfig",
    `  return mergeConfig(resolved, {server:{host:'127.0.0.1',port:${ports.web},strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:${ports.api}'}}}})`,
    '}',
    '',
  ].join('\n')
  await fsPromises.writeFile(wrapper, source, { mode: 0o600 })
  return wrapper
}

function evidenceLocations(evidence) {
  const absolute = assertAbsolutePath(evidence, 'evidence')
  if (path.extname(absolute) === '.json') return { evidenceDir: path.dirname(absolute), resultPath: absolute }
  return { evidenceDir: absolute, resultPath: path.join(absolute, 'runtime.json') }
}

async function prepareCandidate({ candidate, supervisor, environment, cacheRoot }) {
  const venv = path.join(supervisor.runRoot, 'venv')
  // The environment stays per-run for isolation, but the download caches are shared: a cache inside
  // the run root made every run refetch the whole dependency set, and that is what exhausted the
  // internal deadline. QA runs one job at a time, so a shared cache has no concurrent writer.
  const caches = cacheRoot ?? path.join(supervisor.runRoot, 'cache')
  const pnpmStore = path.join(caches, 'pnpm-store')
  supervisor.registerOwnedPath(venv, 'python-venv')
  if (isWithin(supervisor.runRoot, caches)) {
    supervisor.registerOwnedPath(caches, 'dependency-cache')
  }
  await ensurePrivateDirectory(caches)
  await supervisor.runToDeadline('uv-sync', 'uv', ['sync', '--frozen', '--no-dev'], {
    cwd: candidate,
    env: { ...environment, UV_PROJECT_ENVIRONMENT: venv, UV_CACHE_DIR: path.join(caches, 'uv') },
  })
  await supervisor.runToDeadline('pnpm-install', 'pnpm', ['install', '--frozen-lockfile', '--store-dir', pnpmStore], {
    cwd: candidate,
    env: environment,
  })
  return { venv, pnpmStore }
}

async function startRuntime({
  candidate,
  evidence,
  deadline = monotonicDeadlineAfter(DEFAULT_RUNTIME_MS),
  skipInstall = false,
  cacheRoot,
  signal,
}) {
  const candidateRoot = assertAbsolutePath(candidate, 'candidate')
  validateCandidate(candidateRoot)
  const { evidenceDir, resultPath } = evidenceLocations(evidence)
  await ensurePrivateDirectory(evidenceDir)
  const runRoot = await fsPromises.mkdtemp(path.join(evidenceDir, 'runtime-'))
  await fsPromises.chmod(runRoot, 0o700)
  const supervisor = await new ProcessSupervisor({ runRoot, deadline }).initialize()
  const cancel = () => { void supervisor.stop('cancelled') }
  signal?.addEventListener('abort', cancel, { once: true })
  supervisor.registerOwnedPath(path.join(runRoot, 'assets'), 'fixture-asset-roots')
  supervisor.registerOwnedPath(path.join(runRoot, 'vite.runtime.config.mjs'), 'vite-wrapper')
  try {
    for (const directory of ['assets/datasets', 'assets/indexes', 'assets/huggingface']) {
      await ensurePrivateDirectory(path.join(runRoot, directory))
    }
    const baseEnvironment = sanitizedChildEnvironment(runRoot)
    const prepared = skipInstall
      ? { venv: path.join(runRoot, 'venv'), pnpmStore: path.join(cacheRoot ?? path.join(runRoot, 'cache'), 'pnpm-store') }
      : await prepareCandidate({ candidate: candidateRoot, supervisor, environment: baseEnvironment, cacheRoot })
    if (skipInstall) {
      const candidateVenv = path.join(candidateRoot, '.venv')
      prepared.venv = candidateVenv
    }
    let lastError
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (remainingMilliseconds(deadline) <= 0) throw new RuntimeError('DEADLINE_EXCEEDED', 'Deadline expired before fixture servers started')
      const ports = await allocateLoopbackPorts()
      const apiOrigin = `http://127.0.0.1:${ports.api}`
      const origin = `http://127.0.0.1:${ports.web}`
      const appEnvironment = sanitizedChildEnvironment(runRoot, {
        GODS_EYE_USE_FIXTURES: 'true',
        GODS_EYE_DATASET_ROOT: path.join(runRoot, 'assets', 'datasets'),
        GODS_EYE_INDEX_ROOT: path.join(runRoot, 'assets', 'indexes'),
        GODS_EYE_ACTIVE_INDEX: path.join(runRoot, 'assets', 'indexes', 'active'),
        GODS_EYE_HF_CACHE: path.join(runRoot, 'assets', 'huggingface'),
        GODS_EYE_DEVICE: 'cpu',
        GODS_EYE_OFFLINE: 'true',
        GODS_EYE_BIND_HOST: '127.0.0.1',
        GODS_EYE_BIND_PORT: String(ports.api),
      })
      try {
        const wrapper = await createViteWrapper(candidateRoot, runRoot, ports)
        const apiProcess = await supervisor.spawn('fixture-api', path.join(prepared.venv, 'bin', 'python'), [
          '-m', 'uvicorn', 'gods_eye.app:app', '--app-dir', path.join(candidateRoot, 'service'),
          '--host', '127.0.0.1', '--port', String(ports.api),
        ], { cwd: candidateRoot, env: appEnvironment })
        await fetchJsonUntil(`${apiOrigin}/api/readiness`, {
          deadline,
          label: 'fixture API',
          accept: payload => payload?.ready === true || false,
          processRecord: apiProcess,
          signal,
        })
        const webProcess = await supervisor.spawn('fixture-web', 'pnpm', [
          '--dir', path.join(candidateRoot, 'web'), 'exec', 'vite', '--config', wrapper,
        ], { cwd: candidateRoot, env: baseEnvironment })
        const readiness = await fetchJsonUntil(`${origin}/api/readiness`, {
          deadline,
          label: 'fixture readiness through web origin',
          accept: payload => {
            if (payload?.ready !== true) return false
            if (
              payload.model_id !== FIXTURE_MODEL_ID ||
              payload.active_index_version !== FIXTURE_INDEX_VERSION ||
              payload.gallery_count !== 1
            ) {
              return `Readiness did not identify the fixture runtime: ${JSON.stringify(payload)}`
            }
            return true
          },
          processRecord: webProcess,
          signal,
        })
        const result = {
          origin,
          apiOrigin,
          ports,
          readiness,
          imageProbe: null,
          paths: { runRoot, manifest: supervisor.manifestPath, cleanup: supervisor.receiptPath, viteConfig: wrapper, result: resultPath },
          supervisor,
          async stop(reason = 'normal') {
            signal?.removeEventListener('abort', cancel)
            return supervisor.stop(reason)
          },
        }
        return result
      } catch (error) {
        lastError = error
        if (signal?.aborted || error.code === 'CANCELLED') throw error
        await supervisor.stopProcess('fixture-web', `startup-attempt-${attempt}-failed`)
        await supervisor.stopProcess('fixture-api', `startup-attempt-${attempt}-failed`)
        if (error.code === 'WRONG_FIXTURE_IDENTITY' || error.code === 'DEADLINE_EXCEEDED') throw error
        if (attempt === 5) break
      }
    }
    throw lastError ?? new RuntimeError('START_FAILED', 'Fixture runtime failed to start')
  } catch (error) {
    signal?.removeEventListener('abort', cancel)
    await supervisor.stop(error.code ?? 'start_failed').catch(() => {})
    throw error
  }
}

async function probeRuntime(runtime) {
  const curl = await runtime.supervisor.runToDeadline('curl-readiness', 'curl', [
    '--fail', '--silent', '--show-error', '--max-time', '5', '--write-out', '\n%{http_code}',
    `${runtime.origin}/api/readiness`,
  ], {
    cwd: runtime.supervisor.runRoot,
    env: sanitizedChildEnvironment(runtime.supervisor.runRoot),
  })
  const curlOutput = await fsPromises.readFile(curl.stdoutPath, 'utf8')
  const newline = curlOutput.lastIndexOf('\n')
  const curlReadiness = JSON.parse(curlOutput.slice(0, newline))
  const curlStatus = Number(curlOutput.slice(newline + 1).trim())
  if (
    curlReadiness.ready !== true ||
    curlReadiness.model_id !== FIXTURE_MODEL_ID ||
    curlReadiness.active_index_version !== FIXTURE_INDEX_VERSION
  ) {
    throw new RuntimeError('WRONG_FIXTURE_IDENTITY', 'curl readiness probe did not identify the fixture runtime')
  }
  const searchResponse = await fetch(`${runtime.origin}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'A person wearing a blue coat',
      top_k: 12,
      datasets: ['CUHK-PEDES'],
      model_id: FIXTURE_MODEL_ID,
    }),
    signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(5000, remainingMilliseconds(runtime.supervisor.deadline))))),
  })
  if (!searchResponse.ok) throw new RuntimeError('FIXTURE_SEARCH', `Fixture search returned HTTP ${searchResponse.status}`)
  const search = await searchResponse.json()
  const first = search.results?.[0]
  if (first?.rank !== 1 || first?.dataset !== 'CUHK-PEDES' || typeof first.image_url !== 'string') {
    throw new RuntimeError('WRONG_FIXTURE_IDENTITY', 'Fixture search did not return the expected ranked CUHK-PEDES image')
  }
  const imageResponse = await fetch(new URL(first.image_url, runtime.origin), {
    signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(5000, remainingMilliseconds(runtime.supervisor.deadline))))),
  })
  const imageBytes = Buffer.from(await imageResponse.arrayBuffer())
  if (!imageResponse.ok || !imageResponse.headers.get('content-type')?.startsWith('image/') || imageBytes.length === 0) {
    throw new RuntimeError('FIXTURE_IMAGE', 'Fixture image response was not a non-empty image')
  }
  return {
    curl: { method: 'GET', url: `${runtime.origin}/api/readiness`, status: curlStatus, readiness: curlReadiness },
    searchStatus: searchResponse.status,
    rank: first.rank,
    dataset: first.dataset,
    stableId: first.id,
    imageUrl: first.image_url,
    imageStatus: imageResponse.status,
    imageContentType: imageResponse.headers.get('content-type'),
    imageBytes: imageBytes.length,
  }
}

async function probeCandidate({ candidate, evidence, deadline = monotonicDeadlineAfter(DEFAULT_RUNTIME_MS), signal }) {
  const locations = evidenceLocations(evidence)
  let runtime
  const startedAt = new Date().toISOString()
  try {
    runtime = await startRuntime({ candidate, evidence, deadline, signal })
    runtime.imageProbe = await probeRuntime(runtime)
    const publicResult = {
      version: 1,
      status: 'ready',
      startedAt,
      finishedAt: new Date().toISOString(),
      origin: runtime.origin,
      apiOrigin: runtime.apiOrigin,
      ports: runtime.ports,
      readiness: runtime.readiness,
      imageProbe: runtime.imageProbe,
      harness: { viteWrapper: 'run-generated', proxyTarget: runtime.apiOrigin },
      processManifest: runtime.paths.manifest,
      cleanupReceipt: runtime.paths.cleanup,
    }
    const cleanup = await runtime.stop('probe_complete')
    publicResult.cleanup = cleanup
    await writeJsonAtomic(locations.resultPath, publicResult)
    return publicResult
  } catch (error) {
    const cleanup = runtime ? await runtime.stop(error.code ?? 'probe_failed').catch(() => null) : null
    const failure = {
      version: 1,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: { code: error.code ?? 'UNEXPECTED', message: error.message },
      cleanup,
    }
    await ensurePrivateDirectory(locations.evidenceDir)
    await writeJsonAtomic(locations.resultPath, failure)
    throw error
  }
}

async function reclaimStaleManifest({ manifestPath, runRoot, graceMilliseconds = 500 }) {
  const absoluteManifest = assertAbsolutePath(manifestPath, 'manifestPath')
  const absoluteRoot = assertAbsolutePath(runRoot, 'runRoot')
  if (!isWithin(absoluteRoot, absoluteManifest)) throw new RuntimeError('PATH_OUTSIDE_RUN', 'Manifest is outside run root')
  const manifest = JSON.parse(await fsPromises.readFile(absoluteManifest, 'utf8'))
  if (manifest.version !== MANIFEST_VERSION || path.resolve(manifest.runRoot) !== absoluteRoot || !Array.isArray(manifest.processes)) {
    throw new RuntimeError('INVALID_MANIFEST', 'Stale process manifest does not match the requested run root')
  }
  const results = []
  for (const record of [...manifest.processes].reverse()) {
    results.push(await terminateMatchingGroup(record, graceMilliseconds))
  }
  return results
}

function parseCli(argv) {
  const [command, ...rest] = argv
  if (command !== 'probe') throw new RuntimeError('USAGE', 'Usage: runtime.cjs probe --candidate <absolute-path> --evidence <absolute-path>')
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!['--candidate', '--evidence', '--deadline-ms'].includes(flag) || value === undefined) {
      throw new RuntimeError('USAGE', 'Usage: runtime.cjs probe --candidate <absolute-path> --evidence <absolute-path> [--deadline-ms <duration>]')
    }
    options[flag.slice(2)] = value
  }
  if (!options.candidate || !options.evidence) throw new RuntimeError('USAGE', 'Both --candidate and --evidence are required')
  const duration = options['deadline-ms'] === undefined ? DEFAULT_RUNTIME_MS : Number(options['deadline-ms'])
  return { command, candidate: options.candidate, evidence: options.evidence, deadline: monotonicDeadlineAfter(duration) }
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  const cancellation = new AbortController()
  let interrupted = null
  const onInterrupt = () => { interrupted = 'SIGINT'; cancellation.abort() }
  const onTerminate = () => { interrupted = 'SIGTERM'; cancellation.abort() }
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onTerminate)
  let failure = null
  try {
    const result = await probeCandidate({ ...options, signal: cancellation.signal })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    failure = error
  } finally {
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
  }
  if (interrupted) {
    process.exitCode = interrupted === 'SIGINT' ? 130 : 143
    return
  }
  if (failure) throw failure
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.code ?? error.name}: ${error.message}\n`)
    process.exitCode = error.code === 'DEADLINE_EXCEEDED' ? 124 : 1
  })
}

module.exports = {
  DEFAULT_RUNTIME_MS,
  EXCLUDED_PORTS,
  FIXTURE_INDEX_VERSION,
  FIXTURE_MODEL_ID,
  ProcessSupervisor,
  RuntimeError,
  allocateLoopbackPort,
  allocateLoopbackPorts,
  fetchJsonUntil,
  identityMatches,
  installSignalHandlers,
  monotonicDeadlineAfter,
  probeCandidate,
  probeRuntime,
  readProcessIdentity,
  reclaimStaleManifest,
  remainingMilliseconds,
  runToDeadline,
  sanitizedChildEnvironment,
  startRuntime,
  terminateMatchingGroup,
}
