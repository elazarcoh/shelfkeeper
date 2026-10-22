import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
// a Simania page that matches nothing the earlier specs created: wishing for it makes a wanted book
const fixture = path.join(here, '..', '..', 'packages', 'domain', 'src', 'providers', 'fixtures', 'simania-original-hebrew.json')
const wantedCapture: unknown = JSON.parse(readFileSync(fixture, 'utf8'))
const WANTED_TITLE = 'מסע אל תום האלף'
const wantedUrl = `/books/shelf#capture=${encodeURIComponent(JSON.stringify(wantedCapture))}`

const LINK = 'https://simania.co.il/bookdetails.php?item_id=690482'
const TITLE = 'המושבה האבודה'

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Username').fill(username)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Username')).toHaveCount(0)
}
const signInAsKid = (page: Page) => signIn(page, 'kid', 'kid password')

// Runs after zz-scroll and before zzz-backups (file name). Book 690482 is kid's own book from z-shelf-import;
// the test ends with the wish gone (Bought) so later specs see no wish rows. It leaves one more physical copy.
test('a wish from a Simania page is marked, seen read-only by another member, and bought into an owned copy', async ({ page, browser }) => {
  await signInAsKid(page)

  // 1. wish from a pasted link (the server answers from its cached copy of the page)
  await page.goto('/books/shelf')
  const card = page.getByRole('region', { name: 'Add one book' })
  await card.getByText('Have a link instead?').click()
  await card.getByLabel("Or paste the book's link").fill(LINK)
  await card.getByRole('button', { name: 'Link' }).click()
  const owning = page.getByRole('group', { name: 'This book is' })
  await owning.getByRole('button', { name: 'Wishlist' }).click()
  await page.getByRole('group', { name: 'Formats' }).getByRole('button', { name: 'Physical' }).click()
  await page.getByLabel('Note (optional)').fill('hardcover')
  await page.getByRole('button', { name: 'Add to my wishlist' }).click()
  await expect(page).toHaveURL(/\/wishlist$/)
  const row = page.getByRole('listitem').filter({ hasText: TITLE })
  await expect(row).toBeVisible()
  await expect(row.getByText('hardcover')).toBeVisible()

  // 2. marks on the Library card and the book page
  await page.getByRole('link', { name: 'Library', exact: true }).first().click()
  await page.getByLabel('Search books').fill(TITLE)
  await expect(page.getByRole('img', { name: 'On your wishlist' }).first()).toBeVisible()
  await page.getByRole('link', { name: new RegExp(TITLE) }).first().click()
  await expect(page.getByRole('button', { name: 'On your wishlist' })).toBeVisible()

  // 3. another member sees it, read-only
  const adminContext = await browser.newContext()
  const admin = await adminContext.newPage()
  await signIn(admin, 'parent', 'parent password')
  await admin.goto('/wishlist')
  await admin.getByRole('tab', { name: 'kid' }).click()
  const seen = admin.getByRole('listitem').filter({ hasText: TITLE })
  await expect(seen).toBeVisible()
  await expect(seen.getByText('hardcover')).toBeVisible()
  await expect(admin.getByRole('button', { name: 'Bought' })).toHaveCount(0)
  await adminContext.close()

  // 5. phone width (checked while the wish still exists)
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/wishlist')
  await expect(page.getByRole('listitem').filter({ hasText: TITLE })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  await page.setViewportSize({ width: 1280, height: 720 })

  // 4. Bought: an owned copy, and the wish is gone
  await page.getByRole('button', { name: 'Bought' }).click()
  const dialog = page.getByRole('dialog', { name: 'Bought it' })
  await dialog.getByRole('radio', { name: 'Physical' }).click()
  await dialog.getByRole('button', { name: 'Bought' }).click()
  await expect(page).toHaveURL(/\/books\/[0-9a-f-]+$/)
  // z-shelf-import left two physical copies
  await expect(page.getByText('Physical', { exact: true })).toHaveCount(3)

  // 6. Want it from an existing book's page: the page then says "On your wishlist"
  await page.getByRole('button', { name: 'Want it' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'On your wishlist' })).toBeVisible()
  await page.goto('/wishlist')
  const again = page.getByRole('listitem').filter({ hasText: TITLE })
  await expect(again).toBeVisible()
  await again.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('Nothing here yet')).toBeVisible()
})

test('a wish for a book nobody has is a wanted book: on the Wishlist, not in the Library, gone when removed', async ({ page }) => {
  await signInAsKid(page)
  await page.goto(wantedUrl)
  await page.getByRole('group', { name: 'This book is' }).getByRole('button', { name: 'Wishlist' }).click()
  await page.getByRole('button', { name: 'Add to my wishlist' }).click()
  await expect(page).toHaveURL(/\/wishlist$/)
  const row = page.getByRole('listitem').filter({ hasText: WANTED_TITLE })
  await expect(row).toBeVisible()

  // not in the Library, in either view
  for (const view of ['My library', 'Whole catalog']) {
    await page.getByRole('link', { name: 'Library', exact: true }).first().click()
    await page.getByRole('radio', { name: view }).click()
    await page.getByLabel('Search books').fill(WANTED_TITLE)
    // the search box is described by its count, which settles at "0 books" only after the searched list has loaded
    await expect(page.getByLabel('Search books')).toHaveAccessibleDescription('0 books')
    await expect(page.getByRole('link', { name: new RegExp(WANTED_TITLE) })).toHaveCount(0)
    await page.goto('/wishlist')
  }

  // removing the only wish removes the book that existed for it
  await page.getByRole('listitem').filter({ hasText: WANTED_TITLE }).getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('Nothing here yet')).toBeVisible()
})

test('the single-book card with the Wishlist form open fits a 360px phone', async ({ page }) => {
  await signInAsKid(page)
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto(wantedUrl)
  await page.getByRole('group', { name: 'This book is' }).getByRole('button', { name: 'Wishlist' }).click()
  await expect(page.getByRole('group', { name: 'Formats' })).toBeVisible()
  await expect(page.getByLabel('Note (optional)')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
