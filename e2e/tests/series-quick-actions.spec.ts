import { expect, test, type Page } from '@playwright/test'

// Runs after household-library (file order) and reuses its admin "parent". Builds its own two-book series, so
// the other specs' series and counts are untouched.

const SERIES = 'Zephyr Quartet'
const BOOKS = [
  { title: 'Zephyr Two: Gale', position: '2' },
  { title: 'Zephyr One: Breeze', position: '1' },
]

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function addBook(page: Page, title: string, position: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Quick Tester')
  await page.getByRole('button', { name: 'Add series' }).click()
  await page.getByLabel('Series name 1').fill(SERIES)
  await page.getByLabel('Series position 1').fill(position)
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

const seriesCard = (page: Page) => page.getByRole('link', { name: new RegExp(`^Series: ${SERIES}`) })

// each test builds on the state the one before leaves
test.describe.configure({ mode: 'serial' })

test('right-click a series card: Mark all as read, then Undo', async ({ page }) => {
  await signIn(page)
  for (const b of BOOKS) await addBook(page, b.title, b.position)
  await page.goto('/library')
  const card = seriesCard(page)
  await expect(card).toContainText('2 books')

  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Mark all as read (2)' }).click()
  await expect(page.getByText('Marked 2 books as read')).toBeVisible()
  await expect(card).toContainText('2 of 2 read')

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(card).not.toContainText('of 2 read')

  await card.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Mark all as read (2)' })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('⋯ on a series card: add its next unread book to Up next', async ({ page }) => {
  await signIn(page)
  await page.goto('/library')
  const card = seriesCard(page)
  await expect(card).toBeVisible()

  await card.focus()
  await page.keyboard.press('Tab')
  const more = page.getByRole('button', { name: `Actions for ${SERIES}` })
  await expect(more).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Add “Zephyr One: Breeze” to Up next' }).click()

  await more.click()
  await expect(page.getByRole('menuitem', { name: '“Zephyr One: Breeze” is in Up next' })).toBeDisabled()
  await page.keyboard.press('Escape')
})

test('hide a series from Series continuation on Home, Undo, then show it again from its Library card', async ({ page }) => {
  await signIn(page)
  // started: the first book (in Up next since the test above) in progress, so Home suggests the second
  await page.getByRole('region', { name: 'Up next' }).getByRole('link', { name: /Zephyr One: Breeze/ }).first().click()
  await page.getByLabel('Status').selectOption('reading')
  await expect(page.getByLabel('Status')).toHaveValue('reading')

  await page.getByRole('link', { name: 'Home', exact: true }).click()
  const continuations = page.getByRole('region', { name: 'Series continuations' })
  const next = continuations.getByRole('link', { name: /Zephyr Two: Gale/ })
  await expect(next).toBeVisible()

  await next.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide from Series continuation' }).click()
  await expect(page.getByText(`Hid “${SERIES}” from Series continuation`)).toBeVisible()
  await expect(next).toBeHidden()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(next).toBeVisible()

  await next.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide from Series continuation' }).click()
  await expect(next).toBeHidden()

  await page.goto('/library')
  await seriesCard(page).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Show in Series continuation' }).click()
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Series continuations' }).getByRole('link', { name: /Zephyr Two: Gale/ })).toBeVisible()
})
