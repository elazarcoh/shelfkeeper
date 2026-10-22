import { expect, test, type Browser, type Page } from '@playwright/test'

// Runs after zz-layout (file name): its 60 books would push that spec's cards past the first 48.
// #49: the Inbox and the Library load more as they scroll, instead of stopping (Inbox) or asking for "Next" (Library).
// Signs in as the admin "parent" only to create its own person "scroller", so the 60 books it imports are in nobody
// else's library.
const BOOKS = 60
// not "Scroll Book N": "Book N" would be read as a volume (#66)
const title = (n: number) => `Scroll Title ${String(n).padStart(2, '0')}`
// a rating puts each book in the importer's library
const CSV = ['Title,Author,My Rating', ...Array.from({ length: BOOKS }, (_, i) => `${title(i + 1)},Scroll Author,3`)].join('\n')

async function signIn(page: Page, username: string, password: string, name: string) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Hi, ${name}` })).toBeVisible()
}

async function ensureScroller(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await signIn(page, 'parent', 'parent password', 'Parent')
  await page.goto('/admin')
  await expect(page.getByRole('link', { name: /Kid/ })).toBeVisible()
  if ((await page.getByRole('link', { name: /Scroller/ }).count()) === 0) {
    await page.getByRole('button', { name: 'New person' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Username').fill('scroller')
    await dialog.getByLabel('Display name').fill('Scroller')
    await dialog.getByLabel('Password').fill('scroller password')
    await dialog.getByRole('button', { name: 'Create person' }).click()
    await expect(page.getByRole('link', { name: /Scroller/ })).toBeVisible()
  }
  await context.close()
}

test('the Inbox and the Library load more books as they scroll to the end', async ({ browser }) => {
  await ensureScroller(browser)
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await signIn(page, 'scroller', 'scroller password', 'Scroller')

  await page.goto('/books/import')
  await page.getByLabel('CSV file').setInputFiles({ name: 'scroll.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) })
  await page.getByRole('button', { name: 'Send to my Inbox' }).click()
  await page.getByRole('link', { name: 'Go to my Inbox' }).click()

  // the Inbox shows the first 50, and the rest once scrolled to
  await expect(page.getByRole('region', { name: title(50) })).toBeAttached()
  await expect(page.getByRole('region', { name: title(51) })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show more' }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('region', { name: title(BOOKS) })).toBeAttached()
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0)

  await page.getByRole('button', { name: `Create books for all unmatched (${BOOKS})` }).click()
  await expect(page.getByText('Nothing to review')).toBeVisible()

  // the Library: no Previous/Next, 48 cards, then the rest as the list scrolls
  await page.goto('/library')
  const books = page.getByRole('list', { name: 'Books' }).getByRole('listitem')
  await expect(books).toHaveCount(48)
  await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0)
  const header = await page.getByText(/^\d+ books$/).first().textContent()
  const total = Number(header?.split(' ')[0])
  expect(total).toBeGreaterThanOrEqual(BOOKS)
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 5000)
      return books.count()
    })
    .toBe(total)
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0)

  // a book opened from far down, and Back: the list is all still there
  await page.getByRole('link', { name: title(BOOKS) }).first().click()
  await expect(page.getByRole('heading', { name: title(BOOKS) })).toBeVisible()
  await page.goBack()
  await expect(books).toHaveCount(total)
  await context.close()
})
