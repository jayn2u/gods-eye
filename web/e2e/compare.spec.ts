import { expect, test, type Page } from '@playwright/test'

const fixtureBaseline = 'openclip/ViT-B-16@openai:384x128-reid'
const fixtureFineTuned = 'labclip:cuhk-pedes:0123456789ab'
const fixtureReference = 'openai/clip-vit-base-patch32'

async function runImprovedBenchmarkQuery(page: Page) {
  await page.getByRole('tab', { name: 'Compare' }).click()
  await page.getByRole('radio', { name: 'Benchmark Query' }).check()
  await expect(page.getByRole('button', { name: 'Improved 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Same 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Worse 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'All 3' })).toBeVisible()
  const queryPicker = page.getByLabel('Benchmark Query (CUHK-PEDES test caption)')
  await expect(queryPicker.locator('option')).toHaveCount(3)
  await queryPicker.selectOption('bq_improved')
  await page.getByRole('button', { name: 'Run comparison' }).click()
  await expect(page.getByText('Baseline #3 → Fine-tuned #1')).toBeVisible()
  await expect(page.getByText('Ground truth first appears at #3')).toBeVisible()
  await expect(page.getByText('Ground truth first appears at #1')).toBeVisible()
  await expect(page.getByText('Match', { exact: true })).toHaveCount(1)
}

async function chooseTheme(page: Page, theme: 'dark' | 'light') {
  const current = await page.locator('html').getAttribute('data-theme')
  if (current !== theme) {
    await page.getByRole('button', { name: `Switch to ${theme} mode` }).click()
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

async function expectNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true)
}

test('mode tabs are keyboard accessible and Compare defaults to the fixture pair', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')

  const searchTab = page.getByRole('tab', { name: 'Search' })
  await searchTab.focus()
  await searchTab.press('ArrowRight')
  const compareTab = page.getByRole('tab', { name: 'Compare' })
  await expect(compareTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('Left model')).toHaveValue(fixtureBaseline)
  await expect(page.getByLabel('Right model')).toHaveValue(fixtureFineTuned)

  await page.reload()
  await expect(page.getByRole('tab', { name: 'Compare' })).toHaveAttribute('aria-selected', 'true')
})

test('Benchmark Query comparison shows outcomes, ground-truth ranks, and matching cards', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await runImprovedBenchmarkQuery(page)
})

test('filtered Benchmark Query selection follows outcomes after changing the right model', async ({ page }) => {
  const searchBodies: Record<string, unknown>[] = []
  await page.route('**/api/benchmark', async route => {
    const response = await route.fetch()
    const benchmark = await response.json()
    const reference = benchmark.models.find((model: { model_id: string }) => model.model_id === fixtureReference)
    reference.benchmark_query_ranks = { bq_improved: 4, bq_same: 1, bq_worse: 1 }
    await route.fulfill({
      status: response.status(),
      contentType: 'application/json',
      body: JSON.stringify(benchmark),
    })
  })
  await page.route('**/api/benchmark/search', async route => {
    searchBodies.push(JSON.parse(route.request().postData() ?? '{}'))
    await route.continue()
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Compare' }).click()
  await page.getByRole('radio', { name: 'Benchmark Query' }).check()
  await expect(page.getByRole('button', { name: 'Improved 1' })).toBeVisible()
  await page.getByRole('button', { name: 'Improved 1' }).click()
  const queryPicker = page.getByLabel('Benchmark Query (CUHK-PEDES test caption)')
  await queryPicker.selectOption('bq_improved')
  await page.getByLabel('Right model').selectOption(fixtureReference)

  await expect(page.getByRole('button', { name: 'Worse 1' })).toBeVisible()
  await expect(queryPicker).toHaveValue('bq_same')
  await page.getByRole('button', { name: 'Run comparison' }).click()
  await expect(page.getByLabel('Side-by-side comparison results')).toBeVisible()
  expect(searchBodies).toHaveLength(2)
  expect(searchBodies).toEqual([
    expect.objectContaining({ query_id: 'bq_same' }),
    expect.objectContaining({ query_id: 'bq_same' }),
  ])
})

test('Compare uses stored ranks for outcomes and keeps live ranks in each result column', async ({ page }) => {
  await page.route('**/api/benchmark', async route => {
    const response = await route.fetch()
    const benchmark = await response.json()
    const baseline = benchmark.models.find((model: { model_id: string }) => model.model_id === fixtureBaseline)
    const fineTuned = benchmark.models.find((model: { model_id: string }) => model.model_id === fixtureFineTuned)
    delete baseline.benchmark_query_ranks.bq_improved
    fineTuned.benchmark_query_ranks.bq_improved = 4
    await route.fulfill({
      status: response.status(),
      contentType: 'application/json',
      body: JSON.stringify(benchmark),
    })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Compare' }).click()
  await page.getByRole('radio', { name: 'Benchmark Query' }).check()
  const queryPicker = page.getByLabel('Benchmark Query (CUHK-PEDES test caption)')
  await expect(queryPicker.locator('option')).toHaveCount(3)
  await queryPicker.selectOption('bq_improved')
  await page.getByRole('button', { name: 'Run comparison' }).click()

  await expect(page.getByText('Baseline #3 → Fine-tuned #4')).toBeVisible()
  await expect(page.getByText('Ground truth first appears at #3')).toBeVisible()
  await expect(page.getByText('Ground truth first appears at #1')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Worse 2' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Improved 0' })).toBeVisible()
})

test('Compare shows model catalog refresh errors in its own error area', async ({ page }) => {
  let comparisonStarted = false
  await page.route('**/api/models', async route => {
    if (comparisonStarted) {
      await route.fulfill({ status: 503, json: { detail: 'catalog refresh failed' } })
      return
    }
    await route.continue()
  })
  await page.route('**/api/benchmark/search', async route => {
    comparisonStarted = true
    await route.fulfill({ status: 409, json: { detail: 'model registration changed' } })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Compare' }).click()
  await page.getByRole('radio', { name: 'Benchmark Query' }).check()
  await expect(page.getByRole('button', { name: 'Improved 1' })).toBeVisible()
  await page.getByLabel('Benchmark Query (CUHK-PEDES test caption)').selectOption('bq_improved')
  await page.getByRole('button', { name: 'Run comparison' }).click()
  await expect(page.getByRole('alert')).toHaveText('The model catalog is unavailable.')
})

test('Free text comparison sends the same description to both selected models', async ({ page }) => {
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/search', async route => {
    bodies.push(JSON.parse(route.request().postData() ?? '{}'))
    await route.continue()
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Compare' }).click()
  await page.getByRole('radio', { name: 'Free text' }).check()
  await page.getByLabel('Person description').fill('A person wearing a blue coat')
  await page.getByRole('button', { name: 'Run comparison' }).click()
  await expect(page.getByLabel('Side-by-side comparison results')).toBeVisible()
  expect(bodies).toHaveLength(2)
  expect(bodies).toEqual(expect.arrayContaining([
    expect.objectContaining({
      query: 'A person wearing a blue coat',
      model_id: fixtureBaseline,
      top_k: 12,
    }),
    expect.objectContaining({
      query: 'A person wearing a blue coat',
      model_id: fixtureFineTuned,
      top_k: 12,
    }),
  ]))
})

test('Compare and Benchmark screens render in both themes without page overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')

  for (const theme of ['dark', 'light'] as const) {
    await chooseTheme(page, theme)
    await runImprovedBenchmarkQuery(page)
    await expectNoPageOverflow(page)
    if (process.env.GODS_EYE_CAPTURE_COMPARE === '1') {
      await page.screenshot({ path: testInfo.outputPath(`compare-${theme}.png`), fullPage: true })
    }

    await page.getByRole('tab', { name: 'Benchmark' }).click()
    await expect(page.getByRole('heading', { name: 'Benchmark results' })).toBeVisible()
    await expect(page.locator('.benchmark-table')).toContainText('+39.0 pp')
    const chart = page.getByRole('group', { name: /Benchmark metrics:/ })
    await expect(chart).toBeVisible()
    await expect(chart).toHaveAttribute('aria-describedby', 'benchmark-chart-description')
    const bars = page.locator('.benchmark-bar')
    await expect(bars).toHaveCount(8)
    await expect(bars.first()).toHaveAttribute('role', 'img')
    await expect(bars.first()).toHaveAttribute('tabindex', '0')
    await expect(bars.first()).toHaveAttribute('aria-label', /R@1/)
    await expect(bars.first().locator('title')).toHaveCount(0)
    const rows = page.locator('.benchmark-table tbody tr')
    await expect(rows.filter({ hasText: 'Reference (HF 224 center-crop)' }).first().getByText('Verified', { exact: true })).toHaveCount(0)
    await expect(rows.filter({ hasText: 'Paired baseline' }).getByText('Verified', { exact: true })).toHaveCount(0)
    await expect(rows.filter({ hasText: 'Fine-tuned' }).getByText('Verified', { exact: true })).toHaveCount(1)
    await expectNoPageOverflow(page)
    if (process.env.GODS_EYE_CAPTURE_COMPARE === '1') {
      await page.screenshot({ path: testInfo.outputPath(`benchmark-${theme}.png`), fullPage: true })
    }
  }
})
