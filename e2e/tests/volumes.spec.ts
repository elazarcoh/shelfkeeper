// e2e/tests/volumes.spec.ts
import { expect, test, type Page } from '@playwright/test'

const TITLE = 'דרך המלכים בדיקה'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

test('an edition becomes volume 1 of 2, and adding volume 2 clears the missing line', async ({ page }) => {
  await signIn(page)
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(TITLE)
  await page.getByLabel('Authors (one per line)').fill('Volume Tester')
  await page.getByLabel('Format').selectOption('physical')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).last().click()
  const edit = page.getByRole('dialog', { name: 'Edit edition' })
  await edit.getByLabel('Edition language').fill('he')
  await edit.getByLabel('Volume', { exact: true }).fill('1')
  await edit.getByLabel('Of', { exact: true }).fill('2')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit).toBeHidden()
  await expect(page.getByText('Vol 1 of 2', { exact: true })).toBeVisible()
  await expect(page.getByText(/Missing: vol 2/)).toBeVisible()

  await page.getByRole('button', { name: 'Add edition' }).click()
  const add = page.getByRole('dialog', { name: 'Add an edition' })
  await add.getByLabel('Format').selectOption('physical')
  await add.getByLabel('Edition language').fill('he')
  await add.getByLabel('Volume', { exact: true }).fill('2')
  await add.getByRole('button', { name: 'Add edition' }).click()
  await expect(add).toBeHidden()
  // the new volume took the set's count from volume 1
  await expect(page.getByText('Vol 2 of 2', { exact: true })).toBeVisible()
  await expect(page.getByText('Hebrew · Physical · 2 volumes')).toBeVisible()
  await expect(page.getByText(/Missing: vol/)).toHaveCount(0)
})
