import type { Page, Route } from 'playwright'

const PROFILES = ['normal', 'cancel-replace', 'unprepared-model', 'recover-409'] as const
type Profile = typeof PROFILES[number]

type HarnessState = {
  profile: Profile
  selections: number
  catalogRequests: number
  searchRequests: number
  search409Count: number
  lateFirstReplyAttempted: boolean
  unexpectedFailures: number
}

type InitOptions = {
  readonly page: Page
  readonly unexpectedSearchStatus?: number
}

type ObservedTarget = {
  readonly tag: string
  readonly id: string
  readonly type: string
  readonly ariaLabel: string
  readonly text: string
}

type PageEvent = {
  readonly kind: 'input' | 'change' | 'click' | 'key'
  readonly target: ObservedTarget
  readonly value: string
}

class BrowserHarnessInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserHarnessInputError'
  }
}

const modelIds = {
  b32: 'openai/clip-vit-base-patch32',
  b16: 'openai/clip-vit-base-patch16',
  l14: 'openai/clip-vit-large-patch14',
  l14336: 'openai/clip-vit-large-patch14-336',
} as const

const modelCatalog = (lastReady = true) => ({
  default_model_id: modelIds.b16,
  models: [
    { model_id: modelIds.b32, label: 'ViT-B/32', ready: true, active_index_version: 'fixture-clip-vit-b-32-v1', gallery_count: 1, guidance: null },
    { model_id: modelIds.b16, label: 'ViT-B/16', ready: true, active_index_version: 'fixture-clip-vit-b-16-v1', gallery_count: 1, guidance: null },
    { model_id: modelIds.l14, label: 'ViT-L/14', ready: true, active_index_version: 'fixture-clip-vit-l-14-v1', gallery_count: 1, guidance: null },
    {
      model_id: modelIds.l14336,
      label: 'ViT-L/14@336px',
      ready: lastReady,
      active_index_version: lastReady ? 'fixture-clip-vit-l-14-336-v1' : null,
      gallery_count: lastReady ? 1 : null,
      guidance: lastReady ? null : `Model '${modelIds.l14336}' is not prepared. Run './gods-eye prepare --model-id ${modelIds.l14336}'.`,
    },
  ],
})

const searchResponse = (query: string, modelId: string, indexVersion: string) => ({
  query,
  model_id: modelId,
  active_index_version: indexVersion,
  results: [{ rank: 1, similarity: 0.923, dataset: 'CUHK-PEDES', id: 'cuhk:fixture:001', split: 'test', image_url: '/api/images/sky.svg' }],
})

function parseProfile(value: unknown): Profile {
  if (typeof value !== 'string') {
    throw new BrowserHarnessInputError('Unknown browser fault profile')
  }
  const profile = PROFILES.find((candidate) => candidate === value)
  if (profile === undefined) throw new BrowserHarnessInputError('Unknown browser fault profile')
  return profile
}

function queryAndModel(route: Route): { readonly query: string; readonly modelId: string } {
  const raw = route.request().postDataJSON()
  if (typeof raw !== 'object' || raw === null) return { query: '', modelId: modelIds.b16 }
  const query = Reflect.get(raw, 'query')
  const modelId = Reflect.get(raw, 'model_id')
  return {
    query: typeof query === 'string' ? query : '',
    modelId: typeof modelId === 'string' ? modelId : modelIds.b16,
  }
}

/**
 * The journal is the only evidence channel the report pipeline trusts. It is written here — inside
 * the MCP server process, by harness code the browser agent cannot reach — so an entry is proof that
 * the page observed the event, not a claim that the agent made a tool call.
 */
function createJournal(): {
  readonly append: (kind: string, payload: Record<string, unknown>) => void
  readonly enabled: boolean
} {
  const target = process.env.QA_BROWSER_JOURNAL
  if (target === undefined || target.length === 0) {
    return { append: () => {}, enabled: false }
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { appendFileSync } = require('node:fs') as typeof import('node:fs')
  let seq = 0
  return {
    enabled: true,
    append: (kind, payload) => {
      seq += 1
      appendFileSync(target, `${JSON.stringify({ seq, at: new Date().toISOString(), kind, ...payload })}\n`, { mode: 0o600 })
    },
  }
}

const scenarioReceipts = (): ReadonlyMap<string, string> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const contract = require('./scenarios.json') as { scenarios: { id: string; profile: string; receipt: string }[] }
  return new Map(contract.scenarios.map((scenario) => [scenario.id, scenario.receipt]))
}

function collectPageEvents(): void {
  const describe = (node: unknown): ObservedTarget => {
    const element = node instanceof Element ? node : null
    const actionable = element?.closest('button, a, select, textarea, input') ?? element
    return {
      tag: actionable?.tagName ?? '',
      id: actionable?.id ?? '',
      type: actionable?.getAttribute('type') ?? '',
      ariaLabel: actionable?.getAttribute('aria-label') ?? '',
      text: (actionable?.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200),
    }
  }
  const valueOf = (node: unknown): string => {
    const element = node as { value?: unknown } | null
    return typeof element?.value === 'string' ? element.value.slice(0, 4000) : ''
  }
  const record = (kind: PageEvent['kind'], event: Event): void => {
    const binding = Reflect.get(window, '__godsEyeQaRecord')
    if (typeof binding !== 'function') return
    const node = event.target
    void binding({ kind, target: describe(node), value: valueOf(node) })
  }
  for (const [kind, name] of [['input', 'input'], ['change', 'change'], ['click', 'click'], ['key', 'keydown']] as const) {
    window.addEventListener(name, (event) => record(kind, event), true)
  }
}

async function installBrowserHarness(options: InitOptions): Promise<void> {
  const { page, unexpectedSearchStatus } = options
  const state: HarnessState = {
    profile: 'normal', selections: 0, catalogRequests: 0, searchRequests: 0,
    search409Count: 0, lateFirstReplyAttempted: false, unexpectedFailures: 0,
  }
  let firstSearch: Route | null = null
  const journal = createJournal()
  const receipts = scenarioReceipts()
  let currentScenario: string | null = null
  let pendingType: { target: ObservedTarget; value: string } | null = null

  const targetKey = (target: ObservedTarget): string => `${target.tag}#${target.id}`

  const flushPendingType = (): void => {
    if (pendingType === null) return
    const flushed = pendingType
    pendingType = null
    journal.append('action', { action: 'type', target: flushed.target, value: flushed.value })
  }

  const reset = (profile: Profile): void => {
    state.profile = profile
    state.selections += 1
    state.catalogRequests = 0
    state.searchRequests = 0
    state.search409Count = 0
    state.lateFirstReplyAttempted = false
    state.unexpectedFailures = 0
    firstSearch = null
    pendingType = null
  }

  await page.route('**/api/models', async (route) => {
    state.catalogRequests += 1
    if (state.profile === 'unprepared-model' || (state.profile === 'recover-409' && state.search409Count === 1)) {
      await route.fulfill({ json: modelCatalog(false) })
      return
    }
    await route.continue()
  })

  await page.route('**/api/search', async (route) => {
    state.searchRequests += 1
    if (unexpectedSearchStatus !== undefined) {
      state.unexpectedFailures += 1
      await route.fulfill({ status: unexpectedSearchStatus, json: { detail: 'Synthetic unexpected local failure' } })
      return
    }
    if (state.profile === 'cancel-replace') {
      const request = queryAndModel(route)
      if (firstSearch === null) {
        firstSearch = route
        return
      }
      await route.fulfill({ json: searchResponse(request.query, request.modelId, 'qa-new-b16-v1') })
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 400))
      state.lateFirstReplyAttempted = true
      const held = firstSearch
      firstSearch = null
      if (held !== null) {
        await held.fulfill({ json: searchResponse('A person in a red jacket carrying a backpack', modelIds.l14, 'qa-stale-l14-v1') }).catch((caught: unknown) => {
          if (!(caught instanceof Error)) throw caught
        })
      }
      return
    }
    if (state.profile === 'recover-409' && state.search409Count === 0) {
      state.search409Count = 1
      await route.fulfill({
        status: 409,
        json: { detail: `Model '${modelIds.l14336}' is not prepared. Run './gods-eye prepare --model-id ${modelIds.l14336}'.` },
      })
      return
    }
    if (state.profile === 'recover-409') {
      const request = queryAndModel(route)
      await route.fulfill({ json: searchResponse(request.query, request.modelId, 'qa-recovered-b16-v1') })
      return
    }
    await route.continue()
  })

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    flushPendingType()
    journal.append('navigate', { url: frame.url() })
  })

  await page.exposeBinding('__godsEyeQaRecord', (_source, observed: unknown) => {
    const event = observed as PageEvent | null
    if (event === null || typeof event !== 'object' || typeof event.kind !== 'string') return
    if (event.kind === 'input') {
      // Playwright types one character at a time; keep only the committed value per element.
      if (pendingType !== null && targetKey(pendingType.target) !== targetKey(event.target)) flushPendingType()
      pendingType = { target: event.target, value: event.value }
      return
    }
    if (event.kind === 'change' && event.target.tag === 'SELECT') {
      flushPendingType()
      journal.append('action', { action: 'select', target: event.target, value: event.value })
      return
    }
    if (event.kind === 'change') return
    flushPendingType()
    if (event.kind === 'click') {
      journal.append('action', { action: 'click', target: event.target, value: '' })
      return
    }
    journal.append('action', { action: 'key', target: event.target, value: event.value })
  })

  await page.exposeBinding('__godsEyeQaControl', async (source, command: unknown, value: unknown) => {
    if (command === 'selectProfile') {
      const profile = parseProfile(value)
      reset(profile)
      currentScenario = null
      journal.append('profile', { profile })
      return { profile, selections: state.selections }
    }
    if (command === 'receipt') {
      if (typeof value !== 'string' || !receipts.has(value)) {
        journal.append('harness_error', { message: 'receipt requested for an unknown scenario' })
        throw new BrowserHarnessInputError('Unknown scenario receipt')
      }
      flushPendingType()
      // The predicate is harness text evaluated here, never supplied or relayed by the agent.
      const predicate = receipts.get(value) as string
      const satisfied = await source.page.evaluate(`(${predicate})(${JSON.stringify(state)})`) === true
      currentScenario = value
      journal.append('receipt', { scenario: value, token: `qa-receipt:${value}`, satisfied, state: { ...state } })
      if (!satisfied) throw new BrowserHarnessInputError(`QA receipt failed: ${value}`)
      return `qa-receipt:${value}`
    }
    throw new BrowserHarnessInputError('Unknown browser harness command')
  })

  const exposeControl = (): void => {
    const binding = Reflect.get(window, '__godsEyeQaControl')
    if (typeof binding !== 'function') throw new TypeError('Browser QA binding is unavailable')
    Reflect.set(window, '__GODS_EYE_QA__', Object.freeze({
      selectProfile: (profile: unknown) => binding('selectProfile', profile),
      receipt: (scenario: unknown) => binding('receipt', scenario),
    }))
  }
  await page.addInitScript(exposeControl)
  await page.addInitScript(collectPageEvents)
  await page.evaluate(exposeControl)
  await page.evaluate(collectPageEvents)
  void currentScenario
}

declare const module: {
  exports: {
    default?: typeof installBrowserHarness
    installBrowserHarness?: typeof installBrowserHarness
  }
}
declare const process: { readonly env: Record<string, string | undefined> }
declare const require: (id: string) => unknown

module.exports.default = installBrowserHarness
module.exports.installBrowserHarness = installBrowserHarness
