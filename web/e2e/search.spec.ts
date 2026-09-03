import { expect, test } from '@playwright/test'

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
