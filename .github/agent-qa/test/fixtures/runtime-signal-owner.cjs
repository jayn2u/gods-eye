'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  ProcessSupervisor,
  installSignalHandlers,
  monotonicDeadlineAfter,
  sanitizedChildEnvironment,
} = require('../../runtime.cjs')

async function main() {
  const [root, signalReceipt] = process.argv.slice(2)
  const supervisor = await new ProcessSupervisor({
    runRoot: path.join(root, 'run'),
    deadline: monotonicDeadlineAfter(10000),
  }).initialize()
  const pids = path.join(root, 'pids.txt')
  const uninstall = installSignalHandlers(supervisor, (error, result) => {
    uninstall()
    fs.writeFileSync(signalReceipt, JSON.stringify({ error: error?.message ?? null, ...result }))
    process.exit(error ? 1 : 0)
  })
  await supervisor.spawn('tree', process.execPath, [
    path.join(__dirname, 'runtime-grandchild.cjs'), 'parent', pids,
  ], { cwd: root, env: sanitizedChildEnvironment(root) })
  fs.writeFileSync(path.join(root, 'ready'), 'ready')
  setInterval(() => {}, 1000)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
