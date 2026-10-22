import { expect, test, type Page } from '@playwright/test'

// Runs after household-library (file order) as its admin "parent". Adds one book with no ISBN, ignores and unignores it
// on Admin → Health, then deletes it so the later zz- specs see the library they expect (#61).
const TITLE = 'Aardvark Health Check'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function noIsbnCount(page: Page): Promise<number> {
  const tab = page.getByRole('tab', { name: /^No ISBN \d+$/ })
  await expect(tab).toBeVisible()
  return Number((await tab.textContent())?.match(/\d+$/)?.[0])
}

test('an admin sees a book with no ISBN on Admin → Health, ignores it and brings it back', async ({ page }) => {
  await signIn(page)
  await page.goto('/admin/health?check=no_isbn')
  const before = await noIsbnCount(page)

  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(TITLE)
  await page.getByLabel('Authors (one per line)').fill('Health Tester')
  await page.getByLabel('Format').selectOption('physical')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()

  await page.goto('/admin/health?check=no_isbn')
  await expect(page.getByRole('tab', { name: `No ISBN ${String(before + 1)}` })).toBeVisible()
  // "Aardvark" sorts first, so the row is on the first page
  const row = page.getByRole('list', { name: 'No ISBN' }).getByRole('listitem').filter({ hasText: TITLE })
  await row.getByRole('button', { name: 'Ignore' }).click()
  await expect(row).toHaveCount(0)
  await expect(page.getByRole('tab', { name: `No ISBN ${String(before)}` })).toBeVisible()

  await page.getByLabel('Show ignored').click()
  const ignored = page.getByRole('list', { name: 'No ISBN' }).getByRole('listitem').filter({ hasText: TITLE })
  await ignored.getByRole('button', { name: 'Unignore' }).click()
  await expect(ignored).toHaveCount(0)
  await expect(page.getByRole('tab', { name: `No ISBN ${String(before + 1)}` })).toBeVisible()

  // clean up
  await page.getByLabel('Show ignored').click()
  await page.getByRole('list', { name: 'No ISBN' }).getByRole('link', { name: TITLE }).click()
  await page.getByRole('button', { name: 'More actions for this book' }).click()
  await page.getByRole('menuitem', { name: 'Delete book…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete book' }).click()
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(TITLE)}`)
  await expect(page.getByRole('link', { name: new RegExp(TITLE) })).toHaveCount(0)
})
