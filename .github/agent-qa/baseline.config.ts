declare const require: (id: 'node:path') => {
  readonly isAbsolute: (path: string) => boolean
  readonly resolve: (...paths: readonly string[]) => string
}
declare const process: { readonly env: Record<string, string | undefined> }

const { isAbsolute, resolve } = require('node:path')

class BrowserConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserConfigError'
  }
}

function absoluteEnvironmentPath(name: 'QA_CANDIDATE' | 'QA_EVIDENCE'): string {
  const value = process.env[name]
  if (value === undefined || !isAbsolute(value)) throw new BrowserConfigError(`${name} must be an absolute path`)
  return value
}

function loopbackOrigin(): string {
  const value = process.env.QA_WEB_ORIGIN
  if (value === undefined) throw new BrowserConfigError('QA_WEB_ORIGIN is required')
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '' || url.pathname !== '/') {
    throw new BrowserConfigError('QA_WEB_ORIGIN must be an http://127.0.0.1:<port> origin')
  }
  return url.origin
}

const candidate = absoluteEnvironmentPath('QA_CANDIDATE')
const evidence = absoluteEnvironmentPath('QA_EVIDENCE')

process.env.GODS_EYE_CAPTURE_DOCS = '0'
process.env.GODS_EYE_CAPTURE_VISUAL = '0'
process.env.GODS_EYE_REAL_INDEX = '0'
process.env.GODS_EYE_EXTERNAL_SERVERS = '1'

export default {
  testDir: resolve(candidate, 'web/e2e'),
  testMatch: ['search.spec.ts', 'theme.spec.ts'],
  outputDir: resolve(evidence, 'baseline-results'),
  workers: 1,
  retries: 0,
  reporter: [['json', { outputFile: resolve(evidence, 'baseline-results.json') }]],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: {
    baseURL: loopbackOrigin(),
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
}
