import { expect, test, type Page } from '@playwright/test'

// Runs after household-library (file order) as its admin "parent", and before progress-checkin: it adds no reading to
// any day of this year, so progress-checkin's "today shows no reading" still holds. "Long Ago Book" is marked read on
// an unknown date; "Last Year Book" is marked read in last year (the year picker's default).
const LONG_AGO = 'Long Ago Book'
const LAST_YEAR = 'Last Year Book'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

/** A 300-page book: were it counted on a day, it would add 82,500 words (300 × WORDS_PER_PAGE). */
async function addBook(page: Page, title: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Past Reader')
  await page.getByLabel('Pages').fill('300')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

/** The Stats headline card (books finished, hours, words, and the comparison with last year), as text. */
async function statsHeadline(page: Page): Promise<string> {
  await page.goto('/stats')
  await expect(page.getByText('Books finished')).toBeVisible()
  await page.waitForLoadState('networkidle')
  return page.locator('[data-slot="card"]').filter({ hasText: 'Books finished' }).first().innerText()
}

/** This year's own figures from the headline: the line after each label (the comparison lines are left out). */
function figures(headline: string): { books: string; words: string } {
  const lines = headline.split('\n').map((l) => l.trim())
  const after = (label: string) => lines[lines.indexOf(label) + 1] ?? ''
  return { books: after('Books finished'), words: after('Words read') }
}

test('a book marked read long ago shows as read on an unknown date and leaves this year’s stats alone', async ({ page }) => {
  await signIn(page)
  const before = await statsHeadline(page)

  await addBook(page, LONG_AGO)
  await page.getByRole('button', { name: 'Mark as read…' }).click()
  const sheet = page.getByRole('dialog', { name: 'When did you finish?' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: /^Long ago/ }).click()
  await expect(sheet.getByRole('button', { name: /^Long ago/ })).toHaveAttribute('aria-pressed', 'true')
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet).toBeHidden()

  await expect(page.getByLabel('Status')).toHaveValue('read')
  await expect(page.getByText('Finished, date unknown')).toBeVisible()
  // nothing is in progress, so it can still be started again (a reread) or marked again
  await expect(page.getByRole('button', { name: 'Start reading' })).toBeVisible()

  expect(await statsHeadline(page)).toBe(before)
  await expect(page.getByRole('link', { name: new RegExp(LONG_AGO) })).toHaveCount(0)
})

test('a book marked read in a year shows in that year’s Stats, not this one’s', async ({ page }) => {
  const lastYear = new Date().getFullYear() - 1
  await signIn(page)
  const before = figures(await statsHeadline(page))
  expect(before.books).toMatch(/^\d+$/)
  expect(before.words).not.toBe('')

  await addBook(page, LAST_YEAR)
  await page.getByRole('button', { name: 'Mark as read…' }).click()
  const sheet = page.getByRole('dialog', { name: 'When did you finish?' })
  await sheet.getByRole('button', { name: 'In a year…' }).click()
  await expect(sheet.getByLabel('Year')).toHaveValue(String(lastYear))
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByLabel('Status')).toHaveValue('read')
  await expect(page.getByRole('listitem').filter({ hasText: String(lastYear) }).filter({ hasText: 'Finished' })).toBeVisible()

  // this year's books finished and words read are unchanged, and it is not on this year's shelf or timeline. (Its
  // words do spread over all of last year, estimated, so only the "vs this time last year" lines change.)
  expect(figures(await statsHeadline(page))).toEqual(before)
  await expect(page.getByRole('link', { name: new RegExp(LAST_YEAR) })).toHaveCount(0)
  await page.getByRole('button', { name: `Previous year, ${lastYear}` }).click()
  await expect(page.getByRole('link', { name: new RegExp(LAST_YEAR) }).first()).toBeVisible()
})
