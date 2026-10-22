// e2e/tests/merge-works.spec.ts
import { expect, test, type Page } from '@playwright/test'

const TARGET = 'Merge Target'
const SOURCE = 'Merge Source'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function addBook(page: Page, title: string, format: 'physical' | 'ebook') {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Merge Tester')
  await page.getByLabel('Format').selectOption(format)
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

test('an admin merges a book into another from its page', async ({ page }) => {
  await signIn(page)
  await addBook(page, TARGET, 'physical')
  await addBook(page, SOURCE, 'ebook')

  await page.getByRole('button', { name: 'More actions for this book' }).click()
  await page.getByRole('menuitem', { name: 'Merge into…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Merge into another book' })
  // #98: Esc clears a non-empty search without closing the dialog around it
  await dialog.getByLabel('Find the book to merge into').fill('nothing')
  await dialog.getByLabel('Find the book to merge into').press('Escape')
  await expect(dialog.getByLabel('Find the book to merge into')).toHaveValue('')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Find the book to merge into').fill('Merge')
  // the book itself is never offered
  await expect(dialog.getByRole('button', { name: `Pick ${TARGET}` })).toBeVisible()
  await expect(dialog.getByRole('button', { name: `Pick ${SOURCE}` })).toHaveCount(0)
  await dialog.getByRole('button', { name: `Pick ${TARGET}` }).click()

  await expect(page.getByText(`Merge “${SOURCE}” into “${TARGET}”?`)).toBeVisible()
  await page.getByRole('button', { name: 'Merge', exact: true }).click()

  await expect(page.getByRole('heading', { name: TARGET })).toBeVisible()
  await expect(page.getByText(`Merged into “${TARGET}”`)).toBeVisible()
  await expect(page.locator('[data-slot="card-title"]', { hasText: 'Physical' })).toBeVisible()
  await expect(page.locator('[data-slot="card-title"]', { hasText: 'Ebook' })).toBeVisible()

  // two copies now: Cancel on a copy's "Delete (mistake)…" gives focus back to that copy's ⋯ button
  const copyMenu = page.getByRole('button', { name: 'More actions for this copy' }).first()
  await copyMenu.click()
  await page.getByRole('menuitem', { name: 'Delete (mistake)…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(copyMenu).toBeFocused()

  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(SOURCE)}`)
  await expect(page.getByRole('link', { name: new RegExp(SOURCE) })).toHaveCount(0)
})

test('an admin opens Merge from a Library card’s quick actions', async ({ page }) => {
  await signIn(page)
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(TARGET)}`)
  const card = page.getByRole('link', { name: new RegExp(TARGET) })
  await expect(card).toHaveCount(1)
  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Merge into another book…' }).click()
  // the dialog outlives the menu that opened it, and is about this card's book
  const dialog = page.getByRole('dialog', { name: 'Merge into another book' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(`“${TARGET}”`)).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})
