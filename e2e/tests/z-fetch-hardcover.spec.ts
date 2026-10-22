import { expect, test, type Page } from '@playwright/test'

// Fetch metadata from Hardcover (#146), as the admin "parent", against e2e/fake-hardcover. Runs before z-hardcover (file
// order), so the first test starts without a household token; the later ones share the book pages the earlier ones made.
const TOKEN = 'fake-hardcover-token-e2e-0001'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function addBook(page: Page, title: string, isbn13?: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  // a book needs an author: Hardcover's page brings another, which Would replace
  await page.getByLabel('Authors (one per line)').fill('Placeholder Author')
  if (isbn13 !== undefined) {
    await page.getByLabel('Format').selectOption('physical')
    await page.getByLabel('ISBN-13').fill(isbn13)
  }
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  return page.url()
}

/** The links of the Library's "wyrm serial z" results, once the list has settled (its count matches the box's description). */
async function wyrmBooks(page: Page): Promise<string[]> {
  await page.goto('/library')
  const search = page.getByLabel('Search books')
  await search.fill('wyrm serial z')
  let links: string[] = []
  await expect(async () => {
    links = await page.getByRole('link', { name: /^Wyrm Serial Z/ }).evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))
    await expect(search).toHaveAccessibleDescription(`${links.length} ${links.length === 1 ? 'book' : 'books'}`)
  }).toPass()
  return links
}

async function openFetch(page: Page) {
  await page.getByRole('button', { name: 'More actions for this book' }).click()
  await page.getByRole('menuitem', { name: 'Fetch metadata…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Fetch metadata' })
  await expect(dialog).toBeVisible()
  return dialog
}

test('Hardcover is not offered until the household has a token', async ({ page }) => {
  await signIn(page)
  await addBook(page, 'Wyrm Serial Z')
  const dialog = await openFetch(page)
  const tabs = dialog.getByRole('tablist', { name: 'Look it up on' })
  await expect(tabs.getByRole('tab', { name: 'Open Library' })).toBeVisible()
  await expect(tabs.getByRole('tab', { name: 'Simania' })).toBeVisible()
  await expect(tabs.getByRole('tab', { name: 'Hardcover' })).toHaveCount(0)
})

test('a Hardcover search, a picked version and Keep: the book is linked and only the ticked fields change', async ({ page }) => {
  await signIn(page)
  await page.goto('/admin/hardcover')
  await page.getByLabel('Hardcover API token').fill(TOKEN)
  await page.getByRole('button', { name: 'Save token' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Connected as @fakehome' })).toBeVisible()

  await addBook(page, 'Wyrm Serial Z')
  const dialog = await openFetch(page)
  await expect(dialog.getByRole('tab', { name: 'Hardcover' })).toHaveAttribute('aria-selected', 'true')
  const box = dialog.getByLabel('Search Hardcover for')
  await expect(box).toHaveValue(/^Wyrm Serial Z/)
  await dialog.getByRole('button', { name: 'Search Hardcover', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Use Wyrm Serial Z' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Versions ▾' }).click()
  await dialog.getByRole('button', { name: 'Use version 2' }).click()

  const review = page.getByRole('dialog', { name: 'What to keep' })
  await expect(review.getByText('Will link this book to Hardcover')).toBeVisible()
  await expect(review.getByRole('region', { name: 'Would replace' }).getByText('Wildbough Z')).toBeVisible()
  const fresh = review.getByRole('region', { name: 'New' })
  await expect(fresh.getByText('Parahumanz #1')).toBeVisible()
  await expect(fresh.getByText('4192')).toBeVisible()
  await expect(fresh.getByText('2013-11-19')).toBeVisible()
  await expect(fresh.getByText('Parahumanz.example')).toBeVisible()
  await review.getByRole('checkbox', { name: /^Authors/ }).check()
  await review.getByRole('checkbox', { name: /^Publisher/ }).uncheck()
  await review.getByRole('button', { name: /^Keep \d+$/ }).click()
  await expect(review).toHaveCount(0)

  await expect(page.getByRole('link', { name: 'Wildbough Z' })).toBeVisible()
  await expect(page.getByText('Parahumanz', { exact: false }).first()).toBeVisible()
  await expect(page.getByText(/4,192/)).toBeVisible()
  await expect(page.getByText('Parahumanz.example')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Hardcover', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change…' })).toBeVisible()

  await page.getByRole('button', { name: 'Edit details' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit book' })
  await expect(edit.getByText('Series', { exact: true }).locator('svg[aria-label="locked"]')).toBeVisible()
})

test('Only link: nothing ticked links the book and changes nothing; Unlink from the tab undoes the link', async ({ page }) => {
  await signIn(page)
  await addBook(page, 'Wyrm Serial Z Two')
  const dialog = await openFetch(page)
  await expect(dialog.getByRole('tab', { name: 'Hardcover' })).toHaveAttribute('aria-selected', 'true')
  await dialog.getByRole('button', { name: 'Search Hardcover', exact: true }).click()
  await dialog.getByRole('button', { name: 'Use Wyrm Serial Z', exact: true }).click()

  const review = page.getByRole('dialog', { name: 'What to keep' })
  await review.getByRole('button', { name: 'Select none in New' }).click()
  await review.getByRole('button', { name: 'Only link' }).click()
  await expect(review).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Wyrm Serial Z Two', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open ↗' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change…' })).toBeVisible()

  // the dialog now opens on the match
  const again = await openFetch(page)
  await expect(again.getByText('Current match')).toBeVisible()
  // the current match is itself tappable
  await again.getByRole('button', { name: /^Use / }).first().click()
  const second = page.getByRole('dialog', { name: 'What to keep' })
  await expect(second).toBeVisible()
  await second.getByRole('button', { name: 'Back' }).click()
  await expect(again.getByText('Current match')).toBeVisible()
  await again.getByRole('button', { name: 'Unlink' }).click()
  await expect(again.getByLabel('Search Hardcover for')).toBeVisible()
  await again.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Not on Hardcover')).toBeVisible()
})

test("a copy's ISBN is looked up on Hardcover and goes straight to What to keep", async ({ page }) => {
  await signIn(page)
  await addBook(page, 'Isbn Lookup Z', '9789003000019')
  await page.getByRole('button', { name: 'More actions for this copy' }).first().click()
  await page.getByRole('menuitem', { name: 'Fetch metadata…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Fetch metadata' })
  await expect(dialog.getByRole('tab', { name: 'Hardcover' })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByLabel('Search Hardcover for')).toHaveValue('9789003000019')
  await dialog.getByRole('button', { name: 'Search Hardcover', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'What to keep' })
  await expect(review.getByRole('region', { name: 'New' }).getByText('321')).toBeVisible()
})

test('an Inbox row is looked up on Hardcover, linked, and created from the page', async ({ page }) => {
  await signIn(page)
  const before = await wyrmBooks(page)
  await page.goto('/books/import')
  await page.getByLabel('CSV file').setInputFiles({ name: 'wyrm.csv', mimeType: 'text/csv', buffer: Buffer.from('Title,Author\nWyrm Inbox Z,Some Author\n') })
  await page.getByRole('button', { name: 'Send to my Inbox' }).click()
  await page.getByRole('link', { name: 'Go to my Inbox' }).click()

  const card = page.getByRole('region', { name: 'Wyrm Inbox Z' })
  await card.getByRole('button', { name: 'Look it up' }).click()
  await expect(card.getByRole('tab', { name: 'Hardcover' })).toHaveAttribute('aria-selected', 'true')
  await card.getByLabel('Search Hardcover for').fill('wyrm')
  await card.getByRole('button', { name: 'Search Hardcover', exact: true }).click()
  await card.getByRole('button', { name: 'Use Wyrm Serial Z', exact: true }).click()
  // the row now carries the Hardcover page's title, and still says what the file had
  const linked = page.getByRole('region', { name: 'Wyrm Serial Z', exact: true })
  await expect(linked.getByText('From Hardcover: Wyrm Serial Z')).toBeVisible()
  await expect(linked.getByText('In your file: Wyrm Inbox Z')).toBeVisible()
  await linked.getByRole('button', { name: 'Create new book' }).click()
  await expect(linked).toHaveCount(0)

  // the new book is the one "Wyrm Serial Z" card that was not there before the import
  const after = await wyrmBooks(page)
  const fresh = after.filter((h) => !before.includes(h))
  expect(fresh).toHaveLength(1)
  await page.goto(fresh[0] ?? '/')
  await expect(page.getByRole('heading', { name: 'Hardcover', exact: true })).toBeVisible()
  await expect(page.getByText('Not checked yet')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Change…' })).toBeVisible()
})

test('typing in the Hardcover box asks Hardcover nothing until the search button is pressed', async ({ page }) => {
  await signIn(page)
  await addBook(page, 'Wyrm Serial Z Three')
  let lookups = 0
  page.on('request', (r) => {
    if (r.url().includes('hardcover.lookup')) lookups += 1
  })
  const dialog = await openFetch(page)
  const box = dialog.getByLabel('Search Hardcover for')
  await box.fill('wyrm')
  await page.waitForTimeout(1000)
  expect(lookups).toBe(0)
  await expect(dialog.getByRole('list', { name: 'Hardcover results' })).toHaveCount(0)
})
