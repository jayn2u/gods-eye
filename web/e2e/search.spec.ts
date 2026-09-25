import { expect, test, type Locator } from '@playwright/test'

const modelIds = {
  b32: 'openai/clip-vit-base-patch32',
  b16: 'openai/clip-vit-base-patch16',
  l14: 'openai/clip-vit-large-patch14',
  l14336: 'openai/clip-vit-large-patch14-336',
} as const

const modelCatalog = (lastReady = true) => ({
  default_model_id: modelIds.b16,
  models: [
    {model_id:modelIds.b32,label:'ViT-B/32',ready:true,active_index_version:'fixture-clip-vit-b-32-v1',gallery_count:1,guidance:null,group:'reference',paired_baseline_id:null,verified:true,registered_at:null,evaluation_ready:false},
    {model_id:modelIds.b16,label:'ViT-B/16',ready:true,active_index_version:'fixture-clip-vit-b-16-v1',gallery_count:1,guidance:null,group:'reference',paired_baseline_id:null,verified:true,registered_at:null,evaluation_ready:false},
    {model_id:modelIds.l14,label:'ViT-L/14',ready:true,active_index_version:'fixture-clip-vit-l-14-v1',gallery_count:1,guidance:null,group:'reference',paired_baseline_id:null,verified:true,registered_at:null,evaluation_ready:false},
    {model_id:modelIds.l14336,label:'ViT-L/14@336px',ready:lastReady,active_index_version:lastReady?'fixture-clip-vit-l-14-336-v1':null,gallery_count:lastReady?1:null,guidance:lastReady?null:`Model '${modelIds.l14336}' is not prepared. Run './gods-eye prepare --model-id ${modelIds.l14336}'.`,group:'reference',paired_baseline_id:null,verified:true,registered_at:null,evaluation_ready:false},
  ],
})

const expectImageLoaded = async (image: Locator) => {
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => {
    if (!(element instanceof HTMLImageElement)) return false
    return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0
  })).toBe(true)
  await image.evaluate(element => {
    if (!(element instanceof HTMLImageElement)) throw new TypeError('Expected image')
    return element.decode()
  })
}

const waitForPaint = async (page: import('@playwright/test').Page) => {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

test('submits through the real service and renders ranked fixture cards', async ({page}) => {
  await page.goto('/')
  await page.getByLabel('Person description').fill('A person wearing a blue coat')
  await page.getByRole('button', {name:'Search gallery'}).click()
  await expect(page.getByRole('article')).toHaveCount(1)
  await expect(page.getByRole('article').first()).toContainText('#1')
  await expect(page.getByRole('article').first()).toContainText('CUHK-PEDES')
  await expect(page.getByText('not an identity probability')).toBeVisible()
  await page.getByRole('button', {name:'Open result 1 from CUHK-PEDES'}).click()
  await expect(page.getByRole('heading', {name:'Result #1'})).toBeVisible()
  await page.getByRole('button', {name:'Back to results'}).click()
  await expect(page.getByRole('heading', {name:'Closest visual matches'})).toBeVisible()
})

test('model selector sends L/14 and preserves response provenance through detail', async ({page}) => {
  let releaseSearch = () => undefined
  const searchHeld = new Promise<void>(resolve => { releaseSearch = resolve })
  let submittedBody = ''
  await page.route('**/api/search', async route => {
    submittedBody = route.request().postData() ?? ''
    await searchHeld
    await route.continue()
  })
  await page.goto('/')

  const selector = page.getByLabel('CLIP model')
  await expect(selector.locator('option')).toHaveText([
    'ViT-B/32', 'ViT-B/16', 'ViT-L/14', 'ViT-L/14@336px',
  ])
  await expect(selector).toHaveValue(modelIds.b16)
  await selector.focus()
  await selector.press('ArrowDown')
  await selector.press('Enter')
  await expect(selector).toHaveValue(modelIds.l14)

  await page.getByLabel('Person description').fill('A person wearing a blue coat')
  await page.getByRole('button', {name:'Search gallery'}).click()
  await expect(page.getByRole('heading', {name:'Search request in progress'})).toBeVisible()
  const submitted = page.locator('.provenance').filter({hasText:'Submitted model'})
  await expect(submitted).toContainText('ViT-L/14')
  await expect(submitted).not.toContainText('fixture-clip')
  expect(JSON.parse(submittedBody).model_id).toBe(modelIds.l14)
  releaseSearch()

  const provenance = page.getByLabel('Search provenance')
  await expect(provenance).toContainText('ViT-L/14')
  await expect(provenance).toContainText(modelIds.l14)
  await expect(provenance).toContainText('fixture-clip-vit-l-14-v1')
  await page.getByRole('button', {name:'Open result 1 from CUHK-PEDES'}).click()
  await expect(page.getByLabel('Search provenance')).toContainText('fixture-clip-vit-l-14-v1')
  await page.getByRole('button', {name:'Back to results'}).click()
  await page.getByRole('button', {name:'Refine search'}).click()
  await selector.selectOption(modelIds.b16)
  await expect(selector).toHaveValue(modelIds.b16)
})

test('unprepared model remains visible, disabled, and explains preparation', async ({page}) => {
  let searchRequests = 0
  await page.route('**/api/models', route => route.fulfill({json:modelCatalog(false)}))
  page.on('request', request => { if (request.url().endsWith('/api/search')) searchRequests += 1 })
  await page.goto('/')

  const selector = page.getByLabel('CLIP model')
  const option = selector.locator(`option[value="${modelIds.l14336}"]`)
  await expect(option).toHaveText('ViT-L/14@336px — not prepared')
  await expect(option).toHaveAttribute('disabled', '')
  await expect(page.getByLabel('Models needing preparation')).toContainText(`./gods-eye prepare --model-id ${modelIds.l14336}`)
  await selector.evaluate((element, modelId) => {
    if (!(element instanceof HTMLSelectElement)) throw new TypeError('Expected model select')
    element.value = modelId
    element.dispatchEvent(new Event('change', {bubbles:true}))
  }, modelIds.l14336)
  await expect(page.getByRole('button', {name:'Search gallery'})).toBeDisabled()
  expect(searchRequests).toBe(0)
})

test('falls back to the first ready model when the default is unavailable', async ({page}) => {
  const unavailableDefault = modelCatalog(true)
  unavailableDefault.models[1] = {
    ...unavailableDefault.models[1],
    ready:false,
    active_index_version:null,
    gallery_count:null,
    guidance:`Model '${modelIds.b16}' is not prepared. Run './gods-eye prepare --model-id ${modelIds.b16}'.`,
  }
  await page.route('**/api/models', route => route.fulfill({json:unavailableDefault}))
  await page.goto('/')

  await expect(page.getByLabel('CLIP model')).toHaveValue(modelIds.b32)
  await expect(page.getByRole('button', {name:'Search gallery'})).toBeEnabled()
})

test('a 409 refreshes the catalog and preserves exact recovery guidance', async ({page}) => {
  let catalogRequests = 0
  let searched = false
  await page.route('**/api/models', route => {
    catalogRequests += 1
    return route.fulfill({json:modelCatalog(!searched)})
  })
  await page.route('**/api/search', route => {
    searched = true
    return route.fulfill({
      status:409,
      json:{detail:`Model '${modelIds.l14336}' is not prepared. Run './gods-eye prepare --model-id ${modelIds.l14336}'.`},
    })
  })
  await page.goto('/')
  await page.getByLabel('CLIP model').selectOption(modelIds.l14336)
  await page.getByLabel('Person description').fill('blue coat')
  await page.getByRole('button', {name:'Search gallery'}).click()

  await expect(page.getByRole('alert')).toHaveText(`Model '${modelIds.l14336}' is not prepared. Run './gods-eye prepare --model-id ${modelIds.l14336}'.`)
  await expect(page.getByLabel('CLIP model').locator(`option[value="${modelIds.l14336}"]`)).toHaveAttribute('disabled', '')
  expect(catalogRequests).toBeGreaterThanOrEqual(2)
})

test('cancelled stale replies cannot replace a newer model response', async ({page}) => {
  let releaseFirst = () => undefined
  let finishFirst = () => undefined
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve })
  const firstFinished = new Promise<void>(resolve => { finishFirst = resolve })
  await page.route('**/api/search', async route => {
    const body = route.request().postData() ?? ''
    if (body.includes(modelIds.l14)) {
      await firstHeld
      await route.fulfill({json:{query:'first query',model_id:modelIds.l14,active_index_version:'stale-l14-v1',results:[]}}).then(finishFirst, finishFirst)
      return
    }
    await route.fulfill({json:{query:'second query',model_id:modelIds.b16,active_index_version:'new-b16-v1',results:[]}})
  })
  await page.goto('/')
  await page.getByLabel('CLIP model').selectOption(modelIds.l14)
  await page.getByLabel('Person description').fill('first query')
  await page.getByRole('button', {name:'Search gallery'}).click()
  await page.getByRole('button', {name:'Cancel search'}).click()
  await page.getByLabel('CLIP model').selectOption(modelIds.b16)
  await page.getByLabel('Person description').fill('second query')
  await page.getByRole('button', {name:'Search gallery'}).click()
  await expect(page.getByLabel('Search provenance')).toContainText('new-b16-v1')

  releaseFirst()
  await firstFinished
  await expect(page.getByLabel('Search provenance')).toContainText('new-b16-v1')
  await expect(page.getByLabel('Search provenance')).not.toContainText('stale-l14-v1')
})

test('renders an adversarial query as text without executing markup', async ({page}) => {
  const query = '<img src=x onerror="window.__injected=true"> blue coat'
  await page.route('**/api/search', route => route.fulfill({json:{
    query,
    model_id:modelIds.b16,
    active_index_version:'safe-b16-v1',
    results:[],
  }}))
  await page.goto('/')
  await page.getByLabel('Person description').fill(query)
  await page.getByRole('button', {name:'Search gallery'}).click()

  await expect(page.locator('.results-heading')).toContainText(query)
  await expect(page.locator('img[src="x"]')).toHaveCount(0)
  expect(await page.evaluate(() => Reflect.get(window, '__injected'))).toBeUndefined()
})

test('captures deterministic synthetic documentation screens', async ({page}) => {
  test.skip(process.env.GODS_EYE_CAPTURE_DOCS !== '1', 'documentation capture is opt-in')
  await page.setViewportSize({width:1440,height:1000})
  await page.emulateMedia({colorScheme:'light'})
  await page.goto('/')
  await page.getByLabel('Person description').fill('A person wearing a blue coat')
  await page.getByLabel('CLIP model').selectOption(modelIds.l14)
  await page.screenshot({path:'../docs/images/search-compose.png',fullPage:true})
  await page.getByRole('button', {name:'Search gallery'}).click()
  await expect(page.getByLabel('Search provenance')).toContainText('fixture-clip-vit-l-14-v1')
  await page.screenshot({path:'../docs/images/search-results.png',fullPage:true})
  await page.getByRole('button', {name:'Open result 1 from CUHK-PEDES'}).click()
  await page.screenshot({path:'../docs/images/search-detail.png',fullPage:true})
})

test('captures light and dark visual QA states without browser errors', async ({page}) => {
  test.skip(process.env.GODS_EYE_CAPTURE_VISUAL !== '1', 'visual QA capture is opt-in')
  const consoleErrors: string[] = []
  const failedLocalRequests: string[] = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('requestfailed', request => { if (request.url().startsWith('http://127.0.0.1')) failedLocalRequests.push(request.url()) })
  await page.setViewportSize({width:1440,height:1000})
  await page.emulateMedia({colorScheme:'light'})
  await page.goto('/')
  await page.getByLabel('CLIP model').focus()
  await page.screenshot({path:'../.omo/evidence/task-6/visual/compose-light-focus.png',fullPage:true})
  await page.getByRole('button', {name:'Switch to dark mode'}).click()
  await page.screenshot({path:'../.omo/evidence/task-6/visual/compose-dark.png',fullPage:true})
  let releaseSearch = () => undefined
  const searchHeld = new Promise<void>(resolve => { releaseSearch = resolve })
  await page.route('**/api/search', async route => { await searchHeld; await route.continue() })
  await page.getByLabel('Person description').fill('A person wearing a blue coat')
  await page.getByLabel('CLIP model').selectOption(modelIds.l14)
  await page.getByRole('button', {name:'Search gallery'}).click()
  await expect(page.getByRole('heading', {name:'Search request in progress'})).toBeVisible()
  await page.screenshot({path:'../.omo/evidence/task-6/visual/progress-dark.png',fullPage:true})
  await page.getByRole('button', {name:'Switch to light mode'}).click()
  await page.screenshot({path:'../.omo/evidence/task-6/visual/progress-light.png',fullPage:true})
  releaseSearch()
  await expect(page.getByLabel('Search provenance')).toContainText('fixture-clip-vit-l-14-v1')
  await expectImageLoaded(page.getByRole('img', {name:'Gallery result ranked 1'}))
  await page.screenshot({path:'../.omo/evidence/task-6/visual/results-light.png',fullPage:true})
  await page.getByRole('button', {name:'Switch to dark mode'}).click()
  await expectImageLoaded(page.getByRole('img', {name:'Gallery result ranked 1'}))
  await waitForPaint(page)
  await page.screenshot({path:'../.omo/evidence/task-6/visual/results-dark.png',fullPage:true})
  await page.screenshot({path:'../.omo/evidence/task-6/visual/results-dark-pass4.png',fullPage:true})
  await page.getByRole('button', {name:'Switch to light mode'}).click()
  await page.getByRole('button', {name:'Open result 1 from CUHK-PEDES'}).click()
  await expectImageLoaded(page.getByRole('img', {name:'Expanded gallery result ranked 1'}))
  await page.screenshot({path:'../.omo/evidence/task-6/visual/detail-light.png',fullPage:true})
  await page.getByRole('button', {name:'Switch to dark mode'}).click()
  await expectImageLoaded(page.getByRole('img', {name:'Expanded gallery result ranked 1'}))
  await waitForPaint(page)
  await page.screenshot({path:'../.omo/evidence/task-6/visual/detail-dark.png',fullPage:true})
  await page.screenshot({path:'../.omo/evidence/task-6/visual/detail-dark-pass4.png',fullPage:true})
  await page.route('**/api/models', route => route.fulfill({json:modelCatalog(false)}))
  await page.reload()
  const selector = page.getByLabel('CLIP model')
  await selector.evaluate((element, modelId) => {
    if (!(element instanceof HTMLSelectElement)) throw new TypeError('Expected model select')
    element.value = modelId
    element.dispatchEvent(new Event('change', {bubbles:true}))
  }, modelIds.l14336)
  await selector.focus()
  await expect(page.getByRole('button', {name:'Search gallery'})).toBeDisabled()
  await page.screenshot({path:'../.omo/evidence/task-6/visual/compose-dark-disabled.png',fullPage:true})
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
  expect(consoleErrors).toEqual([])
  expect(failedLocalRequests).toEqual([])
})

test('explains the desktop-only requirement on narrow viewports', async ({page}) => {
  await page.setViewportSize({width: 900, height: 800})
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('Desktop display required')
})

test('preserves a blank input and explains validation', async ({page}) => {
  await page.goto('/')
  await page.getByRole('button', {name:'Search gallery'}).click()
  await expect(page.getByRole('alert')).toHaveText('Enter a description to search')
  await expect(page.getByLabel('Person description')).toHaveValue('')
})

test('renders a rank-one result from the active CUHK-PEDES CLIP index', async ({page}) => {
  test.skip(process.env.GODS_EYE_REAL_INDEX !== '1', 'requires the validated full CLIP artifact')
  await page.goto('/')
  await page.getByLabel('Person description').fill('a person wearing a red shirt and dark trousers')
  await page.getByRole('button', {name:'Search gallery'}).click()
  const first = page.getByRole('article').first()
  await expect(first).toContainText('#1')
  await expect(first).toContainText('CUHK-PEDES')
})
