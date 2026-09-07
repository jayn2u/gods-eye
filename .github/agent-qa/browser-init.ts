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

async function installBrowserHarness(options: InitOptions): Promise<void> {
  const { page, unexpectedSearchStatus } = options
  const state: HarnessState = {
    profile: 'normal', selections: 0, catalogRequests: 0, searchRequests: 0,
    search409Count: 0, lateFirstReplyAttempted: false, unexpectedFailures: 0,
  }
  let firstSearch: Route | null = null

  const reset = (profile: Profile): void => {
    state.profile = profile
    state.selections += 1
    state.catalogRequests = 0
    state.searchRequests = 0
    state.search409Count = 0
    state.lateFirstReplyAttempted = false
    state.unexpectedFailures = 0
    firstSearch = null
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

  await page.exposeBinding('__godsEyeQaControl', (_source, command: unknown, value: unknown) => {
    if (command === 'selectProfile') {
      reset(parseProfile(value))
      return { ...state }
    }
    if (command === 'state') return { ...state }
    throw new BrowserHarnessInputError('Unknown browser harness command')
  })

  const exposeControl = (): void => {
    const binding = Reflect.get(window, '__godsEyeQaControl')
    if (typeof binding !== 'function') throw new TypeError('Browser QA binding is unavailable')
    Reflect.set(window, '__GODS_EYE_QA__', Object.freeze({
      selectProfile: (profile: unknown) => binding('selectProfile', profile),
      state: () => binding('state', null),
    }))
  }
  await page.addInitScript(exposeControl)
  await page.evaluate(exposeControl)
}

declare const module: {
  exports: {
    default?: typeof installBrowserHarness
    installBrowserHarness?: typeof installBrowserHarness
  }
}

module.exports.default = installBrowserHarness
module.exports.installBrowserHarness = installBrowserHarness
