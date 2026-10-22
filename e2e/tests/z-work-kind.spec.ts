import { expect, test, type Page } from '@playwright/test'

// Runs after household-library (file order) as its admin "parent". Sets kinds by hand, from a series and from Admin →
// Health, filters the Library by kind, then deletes every book (and the emptied series) so the later zz- specs see the
// library they expect (#133).
const FANFIC = 'Wkind Quill'
const SERIES = 'Wkind Serial'
const SERIAL_BOOKS = ['Wkind Serial One', 'Wkind Serial Two']
const SUGGESTED = 'Losing Hogwarts Wkind'
const PLAIN = 'Wkind Plain'
const ALL = [FANFIC, ...SERIAL_BOOKS, SUGGESTED, PLAIN]

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function addBook(page: Page, title: string, series?: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Kind Tester')
  if (series) {
    await page.getByRole('button', { name: 'Add series' }).click()
    await page.getByLabel('Series name 1').fill(series)
    await page.getByLabel('Series position 1').fill(String(SERIAL_BOOKS.length - SERIAL_BOOKS.indexOf(title)))
  }
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

async function deleteBook(page: Page, title: string) {
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(title)}`)
  await page.getByRole('link', { name: new RegExp(title) }).first().click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await page.getByRole('button', { name: 'More actions for this book' }).click()
  await page.getByRole('menuitem', { name: 'Delete book…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete book' }).click()
  // the app leaves for the Library once the delete went through
  await expect(page.getByText('Book deleted')).toBeVisible()
  await expect(page).toHaveURL(/\/library/)
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(title)}`)
  // the count line proves the list loaded before absence is asserted
  await expect(page.getByText('0 books', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0)
}

const grid = (page: Page, title: string) => page.getByRole('link', { name: new RegExp(title) })

test.describe.configure({ mode: 'serial' })

test('a kind set by hand shows on the book page and as a pill on its Library card, clear of the ⋯ button', async ({ page }) => {
  await signIn(page)
  await addBook(page, PLAIN)
  await expect(page.getByText('Fanfiction', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Web serial', { exact: true })).toHaveCount(0)

  await addBook(page, FANFIC)
  await page.getByRole('button', { name: 'Edit details' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit book' })
  await dialog.getByLabel('Kind', { exact: true }).selectOption('fanfiction')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('Fanfiction', { exact: true })).toBeVisible()

  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(FANFIC)}`)
  await expect(grid(page, FANFIC)).toBeVisible()
  const pill = page.getByRole('img', { name: 'Fanfiction' })
  await expect(pill).toBeVisible()
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(PLAIN)}`)
  await expect(grid(page, PLAIN)).toBeVisible()
  await expect(page.getByRole('img', { name: /^(Fanfiction|Web serial)$/ })).toHaveCount(0)

  // the cover pill (top-start) and the ⋯ button (top-end) must not meet on the narrowest phone
  await page.setViewportSize({ width: 320, height: 700 })
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(FANFIC)}`)
  await expect(pill).toBeVisible()
  const more = page.getByRole('button', { name: `Actions for ${FANFIC}` })
  const [a, b] = [await pill.boundingBox(), await more.boundingBox()]
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  if (a && b) {
    const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
    expect(apart, `pill ${JSON.stringify(a)} vs ⋯ ${JSON.stringify(b)}`).toBe(true)
  }
})

test('Mark series as… Web serial marks every book in a series, and the Library filters by kind', async ({ page }) => {
  await signIn(page)
  for (const t of SERIAL_BOOKS) await addBook(page, t, SERIES)

  await page.goto('/library')
  const card = page.getByRole('link', { name: new RegExp(`^Series: ${SERIES}`) })
  await expect(card).toContainText('2 books')
  await page.getByRole('button', { name: `Actions for ${SERIES}` }).click({ force: true })
  await page.getByRole('menuitem', { name: 'Mark series as…' }).click()
  await page.getByRole('menuitem', { name: 'Web serial' }).click()
  await expect(page.getByText('Marked 2 books as Web serial')).toBeVisible()

  await page.goto('/library?scope=catalog&q=Wkind')
  await expect(grid(page, FANFIC)).toBeVisible()
  await expect(page.getByRole('img', { name: 'Web serial' })).toHaveCount(2)

  await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('Fanfiction')
  await expect(grid(page, FANFIC)).toBeVisible()
  await expect(page.getByRole('link', { name: /Wkind Serial/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: new RegExp(PLAIN) })).toHaveCount(0)

  await page.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('Hide fanfiction')
  await expect(grid(page, FANFIC)).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'Web serial' })).toHaveCount(2)
  await expect(grid(page, PLAIN)).toBeVisible()
})

test('Admin → Health suggests fanfiction from a title; "Not this" keeps it a book', async ({ page }) => {
  await signIn(page)
  await addBook(page, SUGGESTED)
  await page.goto('/admin/health?check=kind_suggestions')
  const row = page.getByRole('list', { name: 'Possible fanfiction or web serial' }).getByRole('listitem').filter({ hasText: SUGGESTED })
  await expect(row).toContainText('Looks like fanfiction')
  await expect(row.getByRole('button', { name: 'Mark as Fanfiction' })).toBeVisible()
  await row.getByRole('button', { name: 'Not this' }).click()
  await expect(row).toHaveCount(0)

  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(SUGGESTED)}`)
  await grid(page, SUGGESTED).click()
  await expect(page.getByRole('heading', { name: SUGGESTED })).toBeVisible()
  await expect(page.getByText('Fanfiction', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Web serial', { exact: true })).toHaveCount(0)
})

// teardown runs even when an earlier test failed; a book that was never made is skipped
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  await signIn(page)
  for (const t of ALL) {
    await page.goto(`/library?scope=catalog&q=${encodeURIComponent(t)}`)
    await expect(page.getByRole('textbox', { name: 'Search books' })).toHaveValue(t)
    // either the count line says none, or the card shows up
    await expect(page.getByText('0 books', { exact: true }).first().or(grid(page, t).first())).toBeVisible()
    if ((await grid(page, t).count()) > 0) await deleteBook(page, t)
  }
  // an emptied series lingers until it is deleted from Admin → Health
  await page.goto('/admin/health?check=empty_series')
  const list = page.getByRole('list', { name: 'Empty series' })
  await expect(list.or(page.getByText('Nothing to fix here.'))).toBeVisible()
  const row = list.getByRole('listitem').filter({ hasText: SERIES })
  if ((await row.count()) > 0) {
    await row.getByRole('button', { name: 'Delete series' }).click()
    await row.getByRole('button', { name: /^Delete “/ }).click()
  }
  await expect(row).toHaveCount(0)
  await page.close()
})
