import { expect, test, type Page } from '@playwright/test'

const HEBREW = 'ספר הפלטה הקטן'
const ENGLISH = 'Palette Test Book' // abbreviation "ptb"

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
  await page.getByLabel('Authors (one per line)').fill('Palette Tester')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

const input = (page: Page) => page.getByRole('combobox', { name: 'Search books, people, pages and commands' })

async function openPalette(page: Page) {
  await page.waitForLoadState('networkidle') // the shortcut listener exists only once the app has hydrated
  await page.keyboard.press('ControlOrMeta+k')
  await expect(input(page)).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test('Ctrl-K → part of a Hebrew title → Enter, Enter → the book page', async ({ page }) => {
  await signIn(page)
  await addBook(page, HEBREW)
  await addBook(page, ENGLISH)
  await page.goto('/library')
  await openPalette(page)
  await input(page).fill('הפלטה')
  await expect(page.getByRole('option', { name: new RegExp(HEBREW) })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('option', { name: 'Open book' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: HEBREW })).toBeVisible()
})

test('an abbreviation finds the book', async ({ page }) => {
  await signIn(page)
  await openPalette(page)
  await input(page).fill('ptb')
  await expect(page.getByRole('group', { name: 'Books' }).getByRole('option', { name: new RegExp(ENGLISH) })).toBeVisible()
})

test('Start reading from the palette, then Undo after it closed; Escape on the Book screen goes back', async ({ page }) => {
  await signIn(page)
  // start on the Library with the book's card visible: Start reading must show on it, and so must Undo
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(ENGLISH)}`)
  const card = page.getByRole('link', { name: new RegExp(ENGLISH) })
  await expect(card).toHaveCount(1)
  await expect(card.getByText('Reading', { exact: true })).toHaveCount(0)
  await openPalette(page)
  await input(page).fill('Palette Test')
  await page.getByRole('option', { name: new RegExp(ENGLISH) }).click()
  await expect(page.getByRole('option', { name: 'Open book' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(input(page)).toBeVisible()
  await expect(input(page)).toHaveValue('')
  await input(page).fill('Palette Test')
  await page.getByRole('option', { name: new RegExp(ENGLISH) }).click()

  await page.getByRole('option', { name: 'Start reading' }).click()
  await expect(input(page)).toBeHidden()
  await expect(page.getByText('Started reading')).toBeVisible()
  await expect(card.getByText('Reading', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(card.getByText('Reading', { exact: true })).toHaveCount(0)
})

test('Escape closes the palette and focus returns to the field it was opened from', async ({ page }) => {
  await signIn(page)
  await page.goto('/library')
  const search = page.getByRole('textbox', { name: 'Search books' })
  await search.focus()
  await openPalette(page)
  await page.keyboard.press('Escape')
  await expect(input(page)).toBeHidden()
  await expect(search).toBeFocused()
})

test('"Check in" opens the check-in flow on Home and drops the param', async ({ page }) => {
  await signIn(page)
  await page.goto('/library')
  await openPalette(page)
  await input(page).fill('check in')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/$/)
  // the flow shows one card at a time, each with a [data-checkin-title] heading; which card comes first depends on
  // what earlier specs left in progress (progress-checkin leaves "Progress Test Book"), so only its presence is checked
  await expect(page.locator('[data-checkin-title]')).toBeVisible()
})

test('the phone top bar’s search icon opens the palette', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await signIn(page)
  await page.getByRole('button', { name: 'Search' }).tap()
  await expect(input(page)).toBeVisible()
  // a book → Back (Root, empty input) → ✕ closes: all reachable by touch alone
  await input(page).fill('Palette Test')
  await page.getByRole('option', { name: new RegExp(ENGLISH) }).tap()
  await expect(page.getByRole('option', { name: 'Open book' })).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).tap()
  await expect(input(page)).toBeVisible()
  await expect(input(page)).toHaveValue('')
  await expect(page.getByRole('option', { name: 'Open book' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Close' }).tap()
  await expect(input(page)).toBeHidden()
  await context.close()
})
