import { expect, test, type Page } from '@playwright/test'

// after household-library (file order): admin "parent". Merges two series this spec creates, so nothing shared changes.

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function addBook(page: Page, title: string, series: string, position: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Brandon Sanderson')
  await page.getByRole('button', { name: 'Add series' }).click()
  await page.getByLabel('Series name 1').fill(series)
  await page.getByLabel('Series position 1').fill(position)
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

test('two spellings of a series merge into one, keeping the English name (#145)', async ({ page }) => {
  test.setTimeout(150_000)
  // a CI retry finds the first attempt's series, so each attempt makes its own
  const n = test.info().retry
  const english = ['Stormlight Archive', 'Stormlight Chronicle', 'Stormlight Annals'][n] ?? `Stormlight ${n}`
  const hebrew = ['גנזך אורות הסער', 'ספר אורות הסער', 'כרוניקת אורות הסער'][n] ?? `אורות הסער ${n}`
  const books = [`${english} One`, `${english} Two`, `${english} Three`]

  await signIn(page)
  await addBook(page, books[0] ?? '', english, '1')
  await addBook(page, books[1] ?? '', english, '2')
  await addBook(page, books[2] ?? '', hebrew, '3')

  await page.goto('/admin/series')
  await page.getByLabel('Find a series').fill(english)
  await expect(page.getByRole('region', { name: english })).toBeVisible()
  await page.getByRole('region', { name: english }).getByRole('button', { name: 'Same series as…' }).click()
  const pick = page.getByRole('dialog', { name: 'Same series as…' })
  await pick.getByLabel('Find the other series').fill(hebrew)
  await pick.getByRole('button', { name: `Pick ${hebrew}` }).click()
  const review = page.getByRole('dialog', { name: 'Merge series' })
  await expect(review.getByText(/You can split a name off again later/)).toBeVisible()
  await review.getByRole('radio', { name: english }).check()
  await review.getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(page.getByText(`Merged into ${english}`)).toBeVisible()

  // one card, three books, both names; found by the Hebrew name too
  await page.getByLabel('Find a series').fill(hebrew)
  const card = page.getByRole('region', { name: english })
  await expect(card).toContainText('3 books')
  await expect(card).toContainText(hebrew)

  // the Library shows one series card with 3 books, and its page lists all three
  await page.goto('/library?scope=catalog')
  await page.getByLabel('Search books').fill(english)
  const libraryCard = page.getByRole('link', { name: new RegExp(`^Series: ${english}`) })
  await expect(libraryCard).toContainText('3 books')
  await libraryCard.click()
  for (const b of books) await expect(page.getByRole('link', { name: new RegExp(b) })).toBeVisible()
})
