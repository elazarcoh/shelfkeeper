// e2e/tests/quick-actions.spec.ts
import { expect, test, type Browser, type Page } from '@playwright/test'

const MENU_BOOK = 'Quick Menu Book'
const TOUCH_BOOK = 'Quick Touch Book'
const SET = 'Quick Picks'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function addBook(page: Page, title: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Quick Tester')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

/** The book's card, alone in the whole catalog (grid). */
async function openCard(page: Page, title: string) {
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(title)}`)
  const link = page.getByRole('link', { name: new RegExp(title) })
  await expect(link).toHaveCount(1)
  return link
}

// the keyboard test builds on the state the right-click test leaves
test.describe.configure({ mode: 'serial' })

test('right-click: mark as read, and the book page agrees', async ({ page }) => {
  await signIn(page)
  await addBook(page, MENU_BOOK)
  const card = await openCard(page, MENU_BOOK)

  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Mark as read' }).click()
  await expect(page.getByText('Marked as read')).toBeVisible()
  await expect(card.getByText('Read', { exact: true })).toBeVisible()

  await card.click()
  await expect(page.getByLabel('Status')).toHaveValue('read')
  await expect(page.getByText('Finished, date unknown')).toBeVisible()
})

test('⋯ by keyboard: add to Up next; Start reading is undone', async ({ page }) => {
  await signIn(page)
  const card = await openCard(page, MENU_BOOK)

  await card.focus()
  await page.keyboard.press('Tab')
  const more = page.getByRole('button', { name: `Actions for ${MENU_BOOK}` })
  await expect(more).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Add to Up next' }).click()
  await expect(card.getByRole('img', { name: 'In Up next' })).toBeVisible()

  await more.click()
  await page.getByRole('menuitem', { name: 'Start reading' }).click()
  await expect(card.getByText('Reading', { exact: true })).toBeVisible()
  // #85: starting takes the book off Up next, and Undo puts it back
  await expect(page.getByText('Started reading · removed from Up next')).toBeVisible()
  await expect(card.getByRole('img', { name: 'In Up next' })).toBeHidden()
  await page.getByRole('button', { name: 'Undo' }).click()
  // back to what it was before Start: read (the first test's Mark as read), in Up next, and nothing in progress
  await expect(card.getByText('Read', { exact: true })).toBeVisible()
  await expect(card.getByRole('img', { name: 'In Up next' })).toBeVisible()
  await more.click()
  await expect(page.getByRole('menuitem', { name: 'Start reading' })).toBeVisible()
  await page.keyboard.press('Escape')
})

async function phone(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  return { context, page }
}

/** A touch held still on the element, past the long-press delay. */
async function longPress(page: Page, target: ReturnType<Page['getByRole']>) {
  const box = await target.boundingBox()
  if (box === null) throw new Error('no box')
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 4, pointerType: 'touch', isPrimary: true, bubbles: true }
  // a handle, not the locator: once the sheet opens the card is aria-hidden and the role locator no longer finds it
  const el = await target.elementHandle()
  await el.dispatchEvent('pointerdown', at)
  await page.waitForTimeout(700)
  await el.dispatchEvent('pointerup', at)
  await el.dispatchEvent('click', at)
}

test('touch: a long-press opens the sheet without opening the book; a set added there shows on the book page', async ({ browser }) => {
  const { context, page } = await phone(browser)
  await signIn(page)
  await page.goto('/sets')
  await page.getByRole('button', { name: 'New set' }).click()
  await page.getByLabel('Set name').fill(SET)
  await page.getByRole('button', { name: 'Create set' }).click()
  await expect(page.getByText(SET)).toBeVisible()
  await addBook(page, TOUCH_BOOK)

  const card = await openCard(page, TOUCH_BOOK)
  await longPress(page, card)
  const sheet = page.getByRole('dialog', { name: TOUCH_BOOK })
  await expect(sheet).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/library')

  await sheet.getByRole('checkbox', { name: SET }).click()
  await expect(sheet.getByRole('checkbox', { name: SET })).toBeChecked()
  await sheet.getByRole('button', { name: 'Done' }).click()

  await card.tap()
  await expect(page.getByRole('heading', { name: TOUCH_BOOK })).toBeVisible()
  await expect(page.getByText(SET)).toBeVisible()
  await context.close()
})
