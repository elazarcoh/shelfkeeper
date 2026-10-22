import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, '..', 'fixtures')
const read = (f: string) => readFileSync(path.join(fixtures, f), 'utf8')
const LINK = 'https://simania.co.il/bookdetails.php?item_id=690482'

async function signInAsKid(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Username').fill('kid')
  await page.getByRole('textbox', { name: 'Password' }).fill('kid password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Username')).toHaveCount(0)
}

// Runs after z-shelf-import.spec.ts (file name): that test linked Simania book 690482, so a pasted link to it is
// answered from the app's own copy of the page (the e2e server has no internet).
test('a CSV row in the Inbox is looked up on Simania, linked, and unlinked back to the file', async ({ page }) => {
  await signInAsKid(page)
  await page.goto('/books/import')
  await page.getByLabel('CSV file').setInputFiles(path.join(fixtures, 'lost-colony.csv'))
  await page.getByRole('button', { name: 'Send to my Inbox' }).click()
  await page.getByRole('link', { name: 'Go to my Inbox' }).click()

  const card = page.getByRole('region', { name: 'Artemis Fowl: The Lost Colony' })
  // folded until asked: a file can hold hundreds of books
  await expect(card.getByLabel("Or paste the book's link")).toHaveCount(0)
  await card.getByRole('button', { name: 'Look it up' }).click()
  await card.getByText('Have a link instead?').click()
  await card.getByLabel("Or paste the book's link").fill(LINK)
  await card.getByRole('button', { name: 'Link' }).click()

  const linked = page.getByRole('region', { name: 'המושבה האבודה' })
  await expect(linked.getByText('עפרה אביגד')).toBeVisible()
  await expect(linked.getByText('In your file:')).toBeVisible()
  await linked.getByRole('button', { name: 'Unlink' }).click()
  await expect(page.getByRole('region', { name: 'Artemis Fowl: The Lost Colony' })).toBeVisible()
  await page.getByRole('region', { name: 'Artemis Fowl: The Lost Colony' }).getByRole('button', { name: 'Ignore' }).click()
  await expect(page.getByRole('region', { name: 'Artemis Fowl: The Lost Colony' })).toHaveCount(0)
})

test("a book's page fetches its metadata from Simania with the bookmarklet, keeping only the ticked fields", async ({ page, context }) => {
  await context.route('https://simania.co.il/**', (route) => {
    const url = route.request().url()
    if (url.includes('bookdetails.php?item_id=690482')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('simania-book.html') })
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('simania-search.html') })
  })
  await context.route('https://cdn.simania.co.il/**', (route) => route.fulfill({ status: 404 }))
  await signInAsKid(page)

  await page.goto('/books/shelf')
  await page.getByText('Optional: skip the copy-paste with the mylib bookmarklet').click()
  const code = decodeURIComponent((await page.getByLabel('Bookmarklet code').inputValue()).slice('javascript:'.length))

  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill('ארטמיס פאול 5')
  await page.getByLabel('Authors (one per line)').fill('אואן קולפר')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'ארטמיס פאול 5' })).toBeVisible()

  // the header's lookup (⋯ menu), not a copy's
  await page.getByRole('button', { name: 'More actions for this book' }).click()
  await page.getByRole('menuitem', { name: 'Fetch metadata…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Fetch metadata' })
  const popupPromise = page.waitForEvent('popup')
  await dialog.getByRole('button', { name: 'Open Simania' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  await popup.locator('#book').evaluate((a: HTMLElement) => a.click())
  await popup.waitForURL(/item_id=690482/)
  const closed = popup.waitForEvent('close')
  await popup.evaluate(code)
  await closed

  const review = page.getByRole('dialog', { name: 'What to keep' })
  // what the book already has starts unticked; what it lacks starts ticked
  await expect(review.getByRole('checkbox', { name: /^Title/ })).not.toBeChecked()
  await expect(review.getByRole('checkbox', { name: /^Translators/ })).toBeChecked()
  // the e2e server cannot reach Simania's image host
  await review.getByRole('checkbox', { name: /^Cover/ }).uncheck()
  await review.getByRole('button', { name: /^Keep \d+$/ }).click()
  await expect(review).toHaveCount(0)

  await expect(page.getByRole('heading', { name: 'ארטמיס פאול 5' })).toBeVisible()
  await expect(page.getByText('עפרה אביגד')).toBeVisible()
})

test("a copy's own Fetch metadata searches by its ISBN and offers only that copy's fields", async ({ page, context, browser }) => {
  await context.route('https://simania.co.il/**', (route) => {
    const url = route.request().url()
    if (url.includes('bookdetails.php?item_id=690482')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('simania-book.html') })
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('simania-search.html') })
  })
  await context.route('https://cdn.simania.co.il/**', (route) => route.fulfill({ status: 404 }))
  await signInAsKid(page)

  await page.goto('/books/shelf')
  await page.getByText('Optional: skip the copy-paste with the mylib bookmarklet').click()
  const code = decodeURIComponent((await page.getByLabel('Bookmarklet code').inputValue()).slice('javascript:'.length))

  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill('המושבה האבודה (עותק)')
  await page.getByLabel('Authors (one per line)').fill('אואן קולפר')
  await page.getByLabel('ISBN-13').fill('978-0-7653-1178-8')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'המושבה האבודה (עותק)' })).toBeVisible()

  await page.getByRole('button', { name: 'More actions for this copy' }).first().click()
  await page.getByRole('menuitem', { name: 'Fetch metadata…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Fetch metadata' })
  await expect(dialog.getByRole('tab', { name: 'Simania' })).toHaveAttribute('aria-selected', 'true')
  const popupPromise = page.waitForEvent('popup')
  await dialog.getByRole('button', { name: 'Open Simania' }).click()
  const popup = await popupPromise
  // the copy's ISBN is the first search
  await popup.waitForURL(/query=9780765311788/)
  await popup.locator('#book').evaluate((a: HTMLElement) => a.click())
  await popup.waitForURL(/item_id=690482/)
  const closed = popup.waitForEvent('close')
  await popup.evaluate(code)
  await closed

  // the page came back to the copy's dialog, not the header's: no book fields and no copy picker
  const review = page.getByRole('dialog', { name: 'What to keep' })
  await expect(review.getByRole('checkbox', { name: /^Translators/ })).toBeChecked()
  await expect(review.getByRole('checkbox', { name: /^Title/ })).toHaveCount(0)
  await expect(review.getByRole('checkbox', { name: /^Series/ })).toHaveCount(0)
  await expect(review.getByText('Copy details go to')).toHaveCount(0)
  // the e2e server cannot reach Simania's image host
  await review.getByRole('checkbox', { name: /^Cover/ }).uncheck()
  await review.getByRole('button', { name: /^Keep \d+$/ }).click()
  await expect(review).toHaveCount(0)

  await expect(page.getByRole('heading', { name: 'המושבה האבודה (עותק)' })).toBeVisible()
  await expect(page.getByText('עפרה אביגד')).toBeVisible()

  // clean up: the copy now carries book 690482's ISBN, so zz-wishlist's "Bought" would land on it; only an admin deletes
  const bookUrl = page.url()
  const adminContext = await browser.newContext()
  const admin = await adminContext.newPage()
  await admin.goto('/')
  await admin.waitForLoadState('networkidle')
  await admin.getByLabel('Username').fill('parent')
  await admin.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await admin.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(admin.getByLabel('Username')).toHaveCount(0)
  await admin.goto(bookUrl)
  await admin.getByRole('button', { name: 'More actions for this book' }).click()
  await admin.getByRole('menuitem', { name: 'Delete book…' }).click()
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Delete book' }).click()
  await expect(admin).toHaveURL(/\/library/)
  await adminContext.close()
})
