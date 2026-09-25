import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const fixtureBaseline = 'openclip/ViT-B-16@openai:384x128-reid'
const fixtureFineTuned = 'labclip:cuhk-pedes:0123456789ab'
const screenshotDirectory = '/mnt/data/gods-eye/.superpowers/sdd/2026-09-25-fine-tuned-checkpoint-comparison/screens'

async function runImprovedBenchmarkQuery(page: Page) {
  await page.getByRole('tab', { name: 'Compare' }).click()
  await page.getByRole('radio', { name: 'Benchmark Query' }).check()
  await expect(page.getByRole('button', { name: 'Improved 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Same 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Worse 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'All 3' })).toBeVisible()
  await page.getByLabel('Benchmark Query (CUHK-PEDES test caption)').selectOption('bq_improved')
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

test('Compare and Benchmark screens render in both themes without page overflow', async ({ page }) => {
  await mkdir(screenshotDirectory, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')

  for (const theme of ['dark', 'light'] as const) {
    await chooseTheme(page, theme)
    await runImprovedBenchmarkQuery(page)
    await expectNoPageOverflow(page)
    await page.screenshot({ path: `${screenshotDirectory}/compare-${theme}.png`, fullPage: true })

    await page.getByRole('tab', { name: 'Benchmark' }).click()
    await expect(page.getByRole('heading', { name: 'Benchmark results' })).toBeVisible()
    await expect(page.locator('.benchmark-table')).toContainText('+39.0 pp')
    await expect(page.getByRole('img', { name: /Benchmark metrics:/ })).toBeVisible()
    await expectNoPageOverflow(page)
    await page.screenshot({ path: `${screenshotDirectory}/benchmark-${theme}.png`, fullPage: true })
  }
})
