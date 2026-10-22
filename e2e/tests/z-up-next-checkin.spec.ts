import { expect, test, type Page } from '@playwright/test'

// #84: "Started anything new?" offers the first book in Up next. Runs after household-library (the admin "parent")
// and progress-checkin; puts a book of its own first in Up next, starts nothing, and takes the book out again.
const TITLE = 'Checkin Suggestion Book'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

test('"Started anything new?" suggests the first book in Up next', async ({ page }) => {
  await signIn(page)
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(TITLE)
  await page.getByLabel('Authors (one per line)').fill('Suggestion Tester')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
  const bookUrl = page.url()
  await page.getByRole('button', { name: 'Add to Up next' }).click()
  await expect(page.getByRole('button', { name: 'Remove from Up next' })).toBeVisible()

  // first in Up next: earlier specs left books of their own there
  await page.goto('/')
  const upNext = page.getByRole('region', { name: 'Up next' })
  const up = upNext.getByRole('button', { name: `Move ${TITLE} up` })
  const first = upNext.getByRole('listitem').first()
  await expect(up).toBeVisible()
  const atTop = async () => (await first.innerText()).includes(TITLE)
  for (let i = 0; i < 20 && !(await atTop()); i++) {
    await up.click()
    // the move buttons are disabled while a reorder saves: settled once it is back, or the book is first
    await expect.poll(async () => (await atTop()) || (await up.isEnabled())).toBe(true)
  }
  await expect(first).toContainText(TITLE)
  await expect(up).toBeDisabled()

  // the check-in asks about each book in progress first ("Still going" moves on), then "Started anything new?"
  const button = page.getByRole('button', { name: 'Check in' })
  const title = page.locator('[data-checkin-title]')
  await expect(button.or(title)).toBeVisible()
  if (await button.isVisible()) await button.click()
  await expect(title).toBeVisible()
  for (let i = 0; i < 10 && (await title.innerText()) !== 'Started anything new?'; i++) {
    const current = await title.innerText()
    await page.getByRole('button', { name: 'Still going', exact: true }).click()
    await expect(title).not.toHaveText(current)
  }
  await expect(title).toHaveText('Started anything new?')

  await page.getByRole('button', { name: `Up next: ${TITLE}` }).click()
  // picked, as if chosen from search: its title above the Reading/Listening, date and edition step
  await expect(page.locator('strong', { hasText: TITLE })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(button).toBeVisible()

  await page.goto(bookUrl)
  await page.getByRole('button', { name: 'Remove from Up next' }).click()
  await expect(page.getByRole('button', { name: 'Add to Up next' })).toBeVisible()
})
