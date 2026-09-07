'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const [mode, receipt] = process.argv.slice(2)
if (mode === 'child') {
  fs.appendFileSync(receipt, `child=${process.pid}\n`)
  if (process.env.RUNTIME_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
} else {
  fs.appendFileSync(receipt, `parent=${process.pid}\n`)
  childProcess.spawn(process.execPath, [__filename, 'child', receipt], {
    cwd: path.dirname(receipt),
    env: process.env,
    stdio: 'ignore',
  })
  if (mode === 'orphan-parent') {
    setTimeout(() => process.exit(0), 50)
    return
  }
  if (process.env.RUNTIME_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
