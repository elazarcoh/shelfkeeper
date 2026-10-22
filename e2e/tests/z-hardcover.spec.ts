import { expect, test, type Page } from '@playwright/test'

// Runs after household-library (file order) as its admin "parent", against e2e/fake-hardcover (#72).
const TOKEN = 'fake-hardcover-token-e2e-0001'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function addBook(page: Page, title: string, isbn13: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Hard Cover')
  await page.getByLabel('Format').selectOption('physical')
  await page.getByLabel('ISBN-13').fill(isbn13)
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  return page.url()
}

test('an admin connects Hardcover; a book shows its rating and a similar book; Fetch metadata links another; Unlink unlinks (#72); Send my past reads sends a finished one (#140)', async ({ page }) => {
  // two worker waits: the refresh, then the past reads' send (#140)
  test.setTimeout(150_000)
  await signIn(page)
  const pride = await addBook(page, 'Hardcover Pride Z', '9780141439518')
  await addBook(page, 'Hardcover Cities Z', '9780141439600')
  const lonely = await addBook(page, 'Hardcover Lonely Z', '9780143105954')

  await page.goto('/admin/hardcover')
  const tokenField = page.getByLabel('Hardcover API token')
  await tokenField.fill(TOKEN)
  await page.getByRole('button', { name: 'Save token' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Connected as @fakehome' })).toBeVisible()
  await expect(tokenField).toHaveValue('')
  await page.getByRole('button', { name: 'Refresh now' }).click()

  // the worker polls every 10 s; the panel appears once the refresh has matched the book
  await expect(async () => {
    await page.goto(pride)
    await expect(page.getByText('★ 4.3 (1,234 ratings)')).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 60_000 })
  await expect(page.getByText('Classics · romantic')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Hardcover Cities Z' })).toBeVisible()

  // a book the nightly match couldn't place is linked by searching, in the Fetch metadata dialog (#146)
  await page.goto(lonely)
  await page.getByRole('button', { name: 'Find it…' }).click()
  const find = page.getByRole('dialog', { name: 'Fetch metadata' })
  await expect(find.getByRole('tab', { name: 'Hardcover' })).toHaveAttribute('aria-selected', 'true')
  await find.getByLabel('Search Hardcover for').fill('lonely')
  await find.getByRole('button', { name: 'Search Hardcover', exact: true }).click()
  await find.getByRole('button', { name: 'Use Hardcover Lonely Z' }).click()
  // the page adds nothing the book lacks, so the step only links
  const review = page.getByRole('dialog', { name: 'What to keep' })
  await review.getByRole('button', { name: 'Only link' }).click()
  await expect(review).toHaveCount(0)
  await expect(page.getByText('★ 4.8 (7 ratings)')).toBeVisible()

  // Unlink, from the same dialog's current match
  await page.getByRole('button', { name: 'Change…' }).click()
  const change = page.getByRole('dialog', { name: 'Fetch metadata' })
  await expect(change.getByText('Current match')).toBeVisible()
  await change.getByRole('button', { name: 'Unlink' }).click()
  await change.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Not on Hardcover')).toBeVisible()

  // Send my past reads (#140): a matched book finished before sending was turned on
  await page.goto(pride)
  await page.getByRole('button', { name: 'Mark as read…' }).click()
  const sheet = page.getByRole('dialog', { name: 'When did you finish?' })
  await sheet.getByRole('button', { name: 'Exact date' }).click()
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet).toBeHidden()
  await page.goto('/account')
  const myToken = page.getByLabel('Hardcover API token')
  await myToken.fill(TOKEN)
  await page.getByRole('button', { name: 'Save token' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Connected as @fakehome' })).toBeVisible()
  const sendPast = page.getByRole('button', { name: 'Send my past reads…' })
  await expect(sendPast).toHaveCount(0)
  const sending = page.getByLabel(/Send books I finish to Hardcover/)
  // the box follows the saved setting, so it flips once the save is back
  await sending.click()
  await expect(sending).toBeChecked()
  await sendPast.click()
  const confirm = page.getByRole('alertdialog', { name: 'Send your past reads to Hardcover?' })
  await expect(confirm).toContainText('will be marked Read on Hardcover')
  await confirm.getByRole('button', { name: /^Send \d+ books?$/ }).click()
  await expect(page.getByText(/queued for Hardcover/)).toBeVisible()
  await expect(sendPast).toHaveCount(0)
  // the manual send, through the fake's mutations; earlier specs' finished books aren't matched, so they wait
  await expect(async () => {
    await page.reload()
    await expect(page.getByText(/Sends: .*\b1 sent\b/)).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 60_000 })
  // later specs link this account again: leave sending off
  await sending.click()
  await expect(sending).not.toBeChecked()
})
