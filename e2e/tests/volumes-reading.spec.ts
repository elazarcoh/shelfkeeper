// e2e/tests/volumes-reading.spec.ts
import { expect, test, type Page } from '@playwright/test'

// Runs after household-library (file order) as its admin "parent".
const TWO_VOLUMES = 'קריאה בכרכים'
const MISSING_VOLUME = 'כרך חסר'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

/** A physical book whose only edition is volume 1 of 2, 400 pages, in Hebrew. */
async function createVolumeOne(page: Page, title: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Volume Reader')
  await page.getByLabel('Format').selectOption('physical')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).last().click()
  const edit = page.getByRole('dialog', { name: 'Edit edition' })
  await edit.getByLabel('Edition language').fill('he')
  await edit.getByLabel('Volume', { exact: true }).fill('1')
  await edit.getByLabel('Of', { exact: true }).fill('2')
  await edit.getByLabel('Pages').fill('400')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit).toBeHidden()
  await expect(page.getByText('Vol 1 of 2')).toBeVisible()
}

test('finishing volume 1 moves a book in two volumes on to volume 2', async ({ page }) => {
  await signIn(page)
  await createVolumeOne(page, TWO_VOLUMES)

  await page.getByRole('button', { name: 'Add edition' }).click()
  const add = page.getByRole('dialog', { name: 'Add an edition' })
  await add.getByLabel('Format').selectOption('physical')
  await add.getByLabel('Edition language').fill('he')
  await add.getByLabel('Volume', { exact: true }).fill('2')
  await add.getByLabel('Pages').fill('600')
  await add.getByRole('button', { name: 'Add edition' }).click()
  await expect(add).toBeHidden()
  await expect(page.getByText('Vol 2 of 2', { exact: true })).toBeVisible()

  // the picker offers both volumes and starts on volume 1
  await expect(page.getByLabel('Which edition?').locator('option:checked')).toHaveText(/Vol 1 of 2/)
  await page.getByRole('button', { name: 'Start reading' }).click()
  await expect(page.getByRole('button', { name: 'Update progress' })).toBeVisible()

  await page.getByRole('button', { name: 'Finished volume 1' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('On to volume 2')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finished volume 1' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Finished', exact: true })).toBeVisible()

  // 400 of 1,000 pages in all
  const updates = page.getByRole('list', { name: 'Progress updates' })
  await expect(updates.getByRole('listitem').filter({ hasText: /Vol 1/ }).filter({ hasText: /40%/ })).toHaveCount(1)
})

test('a book whose volume 2 is not in the library waits for it', async ({ page }) => {
  await signIn(page)
  await createVolumeOne(page, MISSING_VOLUME)

  await page.getByRole('button', { name: 'Start reading' }).click()
  await expect(page.getByRole('button', { name: 'Update progress' })).toBeVisible()

  await page.getByRole('button', { name: 'Finished volume 1' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const card = page.locator('[data-slot="card"]').filter({ has: page.getByText('In progress', { exact: true }) })
  await expect(card.getByText('Waiting for volume 2')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finish reading anyway' })).toBeVisible()
})
