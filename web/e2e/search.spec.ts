import { expect, test } from '@playwright/test'

test('submits through the real service and renders ranked fixture cards', async ({page}) => {
  await page.goto('/')
  await page.getByLabel('Person description').fill('A person wearing a blue coat')
  await page.getByRole('button', {name:'Search gallery'}).click()
  await expect(page.getByRole('article')).toHaveCount(3)
  await expect(page.getByRole('article').first()).toContainText('#1')
  await expect(page.getByRole('article').first()).toContainText('CUHK-PEDES')
})

test('preserves a blank input and explains validation', async ({page}) => {
  await page.goto('/')
  await page.getByRole('button', {name:'Search gallery'}).click()
  await expect(page.getByRole('alert')).toHaveText('Enter a description to search')
  await expect(page.getByLabel('Person description')).toHaveValue('')
})

