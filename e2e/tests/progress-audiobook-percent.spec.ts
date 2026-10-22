import { expect, test, type Browser, type Page } from '@playwright/test'
import { measureLayout } from '../support/layout'

// #31: an audiobook takes a percentage as well as a time, on a small touch phone. Runs after household-library (file
// order) and signs in as its admin "parent" only to create its own person "listener", so the check-ins of the other
// specs (parent's single in-progress book) are untouched.
const TITLE = 'Percent Audiobook'
const PHONE = { width: 320, height: 568 }

async function signIn(page: Page, username: string, password: string, name: string) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Hi, ${name}` })).toBeVisible()
}

async function ensureListener(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await signIn(page, 'parent', 'parent password', 'Parent')
  await page.goto('/admin')
  await expect(page.getByRole('link', { name: /Kid/ })).toBeVisible()
  if ((await page.getByRole('link', { name: /Listener/ }).count()) === 0) {
    await page.getByRole('button', { name: 'New person' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Username').fill('listener')
    await dialog.getByLabel('Display name').fill('Listener')
    await dialog.getByLabel('Password').fill('listener password')
    await dialog.getByRole('button', { name: 'Create person' }).click()
    await expect(page.getByRole('link', { name: /Listener/ })).toBeVisible()
  }
  await context.close()
}

/** Opens the check-in on Home: through its button, or as it is when it is already open. */
async function checkIn(page: Page) {
  await page.goto('/')
  const button = page.getByRole('button', { name: 'Check in' })
  const card = page.getByText('Still reading this one?')
  await expect(button.or(card)).toBeVisible()
  if (await button.isVisible()) await button.tap()
  await expect(card).toBeVisible()
  await expect(page.locator('[data-checkin-title]')).toHaveText(TITLE)
}

test('on a small phone, an audiobook check-in takes a percentage, and the next check-in remembers it', async ({ browser }) => {
  await ensureListener(browser)
  const context = await browser.newContext({ viewport: PHONE, hasTouch: true })
  const page = await context.newPage()
  await signIn(page, 'listener', 'listener password', 'Listener')
  expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true)

  // a 10-hour audiobook, started today
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(TITLE)
  await page.getByLabel('Authors (one per line)').fill('Percent Tester')
  await page.getByLabel('Format').selectOption('audiobook')
  const hours = page.getByLabel('Hours')
  // below sm the book and the edition each tuck fields behind their own "More details"; Hours is the edition's (the last)
  if (!(await hours.isVisible())) await page.getByRole('button', { name: 'More details' }).last().tap()
  await hours.fill('10')
  await page.getByRole('button', { name: 'Add book', exact: true }).tap()
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
  const bookUrl = page.url()
  await page.getByRole('button', { name: 'Start listening' }).tap()
  await expect(page.getByRole('button', { name: 'Update progress' })).toBeVisible()

  // the field starts on Time, as before; the % toggle is a full touch target and switches the field
  await checkIn(page)
  const toggles = page.getByRole('group', { name: 'Progress as' })
  await expect(toggles.getByRole('button', { name: 'Time' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Time (h:mm:ss) (optional)')).toBeVisible()
  const percent = toggles.getByRole('button', { name: 'Percent' })
  const box = await percent.boundingBox()
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
  await percent.tap()
  await expect(percent).toHaveAttribute('aria-pressed', 'true')
  const field = page.getByLabel('Percent (optional)')
  await expect(field).toHaveAttribute('inputmode', 'decimal')
  await field.fill('25')
  const save = page.getByRole('button', { name: 'Still going · 25%' })
  await expect(save).toBeVisible()
  const r = await measureLayout(page)
  expect.soft(r.scrollWidth, `audiobook check-in @${PHONE.width}px: ${r.offenders.join('; ')}`).toBeLessThanOrEqual(r.innerWidth)
  await save.tap()
  await page.getByRole('button', { name: 'Skip' }).tap()
  await expect(page.getByRole('button', { name: 'Check in' })).toBeVisible()

  // the point is saved as 25% (the server accepts a percent for an audiobook)
  await page.goto(bookUrl)
  await expect(page.getByRole('list', { name: 'Progress updates' })).toContainText('25%')

  // the next check-in opens on % (the last kind used)
  await checkIn(page)
  await expect(page.getByLabel('Percent (optional)')).toBeVisible()
  await expect(toggles.getByRole('button', { name: 'Percent' })).toHaveAttribute('aria-pressed', 'true')
  await context.close()
})
