// e2e/tests/z-edition-language.spec.ts
import { expect, test, type Page } from '@playwright/test'

const TITLE = 'Language Lives On Editions Z'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

test('a book has no Language field; its header lists its editions’ languages (#124)', async ({ page }) => {
  await signIn(page)
  const meta = page.locator('p.text-sm.text-muted-foreground')
  await page.goto('/books/new')
  await expect(page.getByLabel('Language', { exact: true })).toHaveCount(0)
  await page.getByLabel('Title', { exact: true }).fill(TITLE)
  await page.getByLabel('Authors (one per line)').fill('Edition Linguist')
  await page.getByLabel('Format').selectOption('physical')
  await page.getByLabel('Edition language').fill('he')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
  await expect(meta.filter({ hasText: /^Hebrew$/ })).toBeVisible()

  await page.getByRole('button', { name: 'Add edition' }).click()
  const add = page.getByRole('dialog', { name: 'Add an edition' })
  await add.getByLabel('Format').selectOption('ebook')
  await add.getByLabel('Edition language').fill('en')
  // the language suggestions open over the button below; leaving the field closes them
  await add.getByLabel('Edition language').press('Tab')
  await add.getByRole('button', { name: 'Add edition' }).click()
  await expect(add).toBeHidden()
  await expect(meta.filter({ hasText: /^Hebrew, English$/ })).toBeVisible()

  await page.getByRole('button', { name: 'Edit details' }).click()
  const editBook = page.getByRole('dialog', { name: 'Edit book' })
  await expect(editBook.getByLabel('Title', { exact: true })).toBeVisible()
  await expect(editBook.getByLabel('Language', { exact: true })).toHaveCount(0)
})
