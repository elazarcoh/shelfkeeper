import { expect, test, type Page } from '@playwright/test'

// Runs after household-library (file order) as its admin "parent". Two books that look like volumes of one series are
// merged from Admin → Volumes; the merged book is deleted at the end so zz-layout, zz-scroll and zz-wishlist see the
// library they expect (#66).
const ONE = 'Lantern Sea, Volume 1'
const TWO = 'Lantern Sea, Volume 2'
const MERGED = 'Lantern Sea'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function addReadBook(page: Page, title: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Volume Tester')
  await page.getByLabel('Format').selectOption('physical')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()

  await page.getByRole('button', { name: 'Mark as read…' }).click()
  const sheet = page.getByRole('dialog', { name: 'When did you finish?' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'In a year…' }).click()
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByLabel('Status')).toHaveValue('read')
}

test('an admin merges two books into one with two volumes from Admin → Volumes', async ({ page }) => {
  await signIn(page)
  await addReadBook(page, ONE)
  await addReadBook(page, TWO)

  await page.goto('/admin/volumes')
  const group = page.getByRole('region', { name: MERGED, exact: true })
  await expect(group).toBeVisible()
  await expect(group.getByRole('link', { name: ONE })).toBeVisible()
  await expect(group.getByRole('link', { name: TWO })).toBeVisible()
  const volumes = group.getByRole('spinbutton', { name: 'Volume', exact: true })
  await expect(volumes).toHaveCount(2)
  await expect(volumes.nth(0)).toHaveValue('1')
  await expect(volumes.nth(1)).toHaveValue('2')

  await group.getByRole('spinbutton', { name: 'Number of volumes' }).fill('2')
  await group.getByRole('button', { name: 'Merge as volumes' }).click()
  await expect(page.getByText(`Merged into “${MERGED}”`)).toBeVisible()
  await expect(page.getByText(/2 reads joined into one/)).toBeVisible()

  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(MERGED)}`)
  await page.getByRole('link', { name: new RegExp(`^${MERGED}`) }).first().click()
  await expect(page.getByRole('heading', { name: MERGED, exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="badge"]', { hasText: 'Vol 1 of 2' })).toBeVisible()
  await expect(page.locator('[data-slot="badge"]', { hasText: 'Vol 2 of 2' })).toBeVisible()
  // one read in the history: the past-session rows are the list items with a Remove button
  const reads = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Remove session' }) })
  await expect(reads).toHaveCount(1)
  await expect(reads.first()).toContainText('Finished')

  // clean up
  await page.getByRole('button', { name: 'More actions for this book' }).click()
  await page.getByRole('menuitem', { name: 'Delete book…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete book' }).click()
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(MERGED)}`)
  await expect(page.getByRole('link', { name: new RegExp(MERGED) })).toHaveCount(0)
})
