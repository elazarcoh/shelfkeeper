import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, '..', 'fixtures')
const read = (f: string) => readFileSync(path.join(fixtures, f), 'utf8')
const capturePath = path.join(here, '..', '..', 'packages', 'domain', 'src', 'providers', 'fixtures', 'simania-translator-prefix.json')

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

async function signInAsKid(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Username').fill('kid')
  await page.getByRole('textbox', { name: 'Password' }).fill('kid password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Username')).toHaveCount(0)
}

// Runs after z-csv-import.spec.ts (file name): the member "kid" owns הנסיך הקטן there.
test('a member adds books from a shelf photo and links one to Simania with the bookmarklet', async ({ page, context }) => {
  // Simania is played by the test, on its real origin (the app only accepts captures from https provider origins)
  await context.route('https://simania.co.il/**', (route) => {
    const url = route.request().url()
    if (url.includes('bookdetails.php?item_id=690482')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('simania-book.html') })
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: read('simania-search.html') })
  })
  await context.route('https://cdn.simania.co.il/**', (route) => route.fulfill({ status: 404 }))

  await signInAsKid(page)
  await page.goto('/books/shelf')

  // the bookmarklet code from the setup section, as a person would copy it
  await page.getByText('Optional: skip the copy-paste with the mylib bookmarklet').click()
  const code = decodeURIComponent((await page.getByLabel('Bookmarklet code').inputValue()).slice('javascript:'.length))

  await page.getByLabel("The AI's answer").fill(read('shelf-answer.txt'))
  await page.getByRole('button', { name: 'Read the list' }).click()
  await expect(page.getByText('You already have this')).toBeVisible()
  await expect(page.getByText('Repeat of row 2')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Add הנסיך הקטן' })).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Add 1 book' })).toBeVisible()
  await page.getByRole('button', { name: 'Add 1 book' }).click()
  // the Inbox opens on just this batch, with how many of it are linked
  await expect(page).toHaveURL(/\/inbox\?batch=[0-9a-f-]+$/)
  await expect(page.getByText('0 of 1 linked')).toBeVisible()

  const card = page.getByRole('region', { name: 'המושבה האבודה' })
  await expect(card.getByText('Not linked')).toBeVisible()
  const popupPromise = page.waitForEvent('popup')
  await card.getByRole('button', { name: 'Open Simania' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  // on the search page the bookmarklet refuses: no book there
  await popup.evaluate(code)
  await expect(popup.getByText('Not a book page')).toBeVisible()
  // the banner floats over the page's links: follow the link the way a tap on the page's own link would
  await popup.locator('#book').evaluate((a: HTMLElement) => a.click())
  await popup.waitForURL(/item_id=690482/)
  const closed = popup.waitForEvent('close')
  await popup.evaluate(code)
  await closed

  await expect(card.getByText('עפרה אביגד')).toBeVisible()
  await expect(card.getByText('Not linked')).toHaveCount(0)
  await expect(page.getByText('1 of 1 linked')).toBeVisible()
  await card.getByRole('button', { name: 'Create new book' }).click()
  await expect(card).toHaveCount(0)

  // the headline: the book exists, with its translator
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  // a copy filed from the Inbox joins My books, so it is in My library (the default view)
  await expect(page.getByRole('radio', { name: 'My library' })).toBeChecked()
  await page.getByLabel('Search books').fill('המושבה האבודה')
  await page.getByRole('link', { name: /המושבה האבודה/ }).first().click()
  await expect(page.getByText('עפרה אביגד')).toBeVisible()
})

test('a single book from Simania goes straight to the library', async ({ page }) => {
  // the bookmarklet's fallback when no app tab is open: the capture rides in the hash
  const capture: unknown = JSON.parse(readFileSync(capturePath, 'utf8'))
  await signInAsKid(page)
  await page.goto(`/books/shelf#capture=${encodeURIComponent(JSON.stringify(capture))}`)

  // the previous test created this book, so the review offers a second copy
  await page.getByRole('button', { name: 'Add a second copy of המושבה האבודה' }).click()
  await expect(page).toHaveURL(/\/books\/[0-9a-f-]+$/)
  await expect(page.getByText('Physical', { exact: true })).toHaveCount(2)
})

test('without the bookmarklet, pasting a Simania link opens the book for review', async ({ page }) => {
  await signInAsKid(page)
  await page.goto('/books/shelf')
  const card = page.getByRole('region', { name: 'Add one book' })
  // the paste field is folded under "Have a link instead?"
  await card.getByText('Have a link instead?').click()
  await expect(card.getByText("On the book's page, tap Share → Copy link")).toBeVisible()
  // the first test linked this page, so the app reuses it instead of asking Simania again
  await card.getByLabel("Or paste the book's link").fill('הנה הקישור: https://simania.co.il/bookdetails.php?item_id=690482')
  await card.getByRole('button', { name: 'Link' }).click()
  await expect(page.getByRole('button', { name: 'Add a second copy of המושבה האבודה' })).toBeVisible()

  // an English book is looked up on Open Library instead, inside the app
  await card.getByRole('tab', { name: 'Open Library' }).click()
  await expect(card.getByRole('button', { name: 'Search Open Library', exact: true })).toBeVisible()
  await expect(card.getByText('A link to a book on Simania or Open Library.')).toBeVisible()
})

test('the one-time AI setup prompt is there to copy, and an answer from an older setup says so but still reads', async ({ page }) => {
  await signInAsKid(page)
  await page.goto('/books/shelf')
  await page.getByText('Show the setup prompt').click()
  await expect(page.getByLabel('The setup prompt')).toHaveValue(/My Library — shelf photo[\s\S]*----- BEGIN SKILL -----/)

  // format 0 is older than any the app has asked for
  await page.getByLabel("The AI's answer").fill('My Library shelf answer, format 0\n```json\n[{"title": "ספר ישן מאוד"}]\n```')
  await page.getByRole('button', { name: 'Read the list' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Your saved AI setup is out of date' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Add ספר ישן מאוד' })).toBeVisible()
})

test("sharing to the app reads the AI's answer, or opens a shared book page for review", async ({ page }) => {
  await signInAsKid(page)
  // the manifest's share_target opens /books/shelf with the shared title, text and url
  const answer = 'My Library shelf answer, format 1\n```json\n[{"title": "ספר משותף"}]\n```'
  await page.goto(`/books/shelf?title=Claude&text=${encodeURIComponent(answer)}`)
  await expect(page.getByRole('checkbox', { name: 'Add ספר משותף' })).toBeVisible()
  await expect(page.getByLabel("The AI's answer")).toHaveValue(answer)
  // read once: the share leaves the address, so a reload doesn't repeat it
  await expect(page).toHaveURL(/\/books\/shelf$/)

  // the first test linked this Simania page, so the app reuses it instead of asking Simania again
  await page.goto(`/books/shelf?title=${encodeURIComponent('המושבה האבודה')}&text=${encodeURIComponent('https://simania.co.il/bookdetails.php?item_id=690482')}`)
  await expect(page.getByRole('button', { name: 'Add a second copy of המושבה האבודה' })).toBeInViewport()
})
