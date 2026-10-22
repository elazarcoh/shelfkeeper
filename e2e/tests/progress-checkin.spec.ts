import { expect, test, type Page } from '@playwright/test'

// Runs after household-library (file order) as its admin "parent". The Final Empire was finished there without a page
// count, so today shows no reading until this spec's progress point. Leaves "Progress Test Book" in progress at page
// 150 of 300 for zz-layout's "book in progress" stop and check-in card test.
const TITLE = 'Progress Test Book'
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The Stats heatmap names a day "Tue, Oct 6: …" (weekdayDate in apps/web/src/features/stats/stats-view.ts). */
function todayName(): string {
  const d = new Date()
  return `${WEEKDAY[d.getDay()]}, ${MONTH[d.getMonth()]} ${d.getDate()}`
}

async function todayCell(page: Page, today: string) {
  await page.goto('/stats')
  await expect(page.getByText('Books finished')).toBeVisible()
  return page.getByRole('group', { name: 'Reading activity by day' }).getByRole('button', { name: new RegExp(`^${today}: `) })
}

/** Opens the check-in on Home: through its button, or as it is when it is already open (due today, not yet dismissed). */
async function checkIn(page: Page) {
  await page.goto('/')
  const button = page.getByRole('button', { name: 'Check in' })
  const card = page.getByText('Still reading this one?')
  await expect(button.or(card)).toBeVisible()
  if (await button.isVisible()) await button.click()
  await expect(card).toBeVisible()
  // the only in-progress session is this spec's book (household-library finished The Final Empire)
  await expect(page.locator('[data-checkin-title]')).toHaveText(TITLE)
}

test('a check-in can record where you are, and only then does today count in Stats', async ({ page }) => {
  // named once, so a run that crosses midnight cannot compare two different days
  const today = todayName()
  // every progress write, so a skipped field can be shown to make none
  const progressCalls: string[] = []
  page.on('request', (request) => {
    if (/\/trpc\/[^?]*progress\.(add|update)/.test(request.url())) progressCalls.push(request.url())
  })

  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()

  // a 300-page book, started today
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(TITLE)
  await page.getByLabel('Authors (one per line)').fill('Progress Tester')
  await page.getByLabel('Pages').fill('300')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
  const bookUrl = page.url()
  await page.getByRole('button', { name: 'Start reading' }).click()
  await expect(page.getByRole('button', { name: 'Update progress' })).toBeVisible()
  await expect(await todayCell(page, today)).toHaveAccessibleName(`${today}: No reading`)

  // skipping the field: Still going works exactly as before (no progress call, no point), and stats are unchanged
  await checkIn(page)
  await expect(page.getByLabel('Page (optional)')).toHaveValue('')
  await page.getByRole('button', { name: 'Still going', exact: true }).click()
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(page.getByRole('button', { name: 'Check in' })).toBeVisible()
  expect(progressCalls).toEqual([])
  await page.goto(bookUrl)
  await expect(page.getByRole('button', { name: 'Update progress' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Progress updates' })).toHaveCount(0)
  await expect(await todayCell(page, today)).toHaveAccessibleName(`${today}: No reading`)

  // "Still going · p. 120": 120/300 of 300 × 275 words = 33,000 words, all on today (the session started today).
  // 275 is WORDS_PER_PAGE in packages/domain/src/sessions.ts, the word count of a book known only by its page count.
  await checkIn(page)
  await page.getByLabel('Page (optional)').fill('120')
  await page.getByRole('button', { name: 'Still going · p. 120' }).click()
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(page.getByRole('button', { name: 'Check in' })).toBeVisible()
  expect(progressCalls).toHaveLength(1)
  await expect(await todayCell(page, today)).toHaveAccessibleName(`${today}: 33K words read`)

  // Home shows the bar; the book page lists the point, and a same-day update replaces it
  await page.goto('/')
  await expect(page.getByRole('progressbar', { name: `Progress in ${TITLE}` }).first()).toHaveAttribute('aria-valuenow', '40')
  await page.goto(bookUrl)
  const updates = page.getByRole('list', { name: 'Progress updates' })
  await expect(updates.getByText('p. 120')).toBeVisible()
  await page.getByRole('button', { name: 'Update progress' }).click()
  const sheet = page.getByRole('dialog', { name: 'Update progress' })
  await sheet.getByLabel('Page', { exact: true }).fill('150')
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet).toBeHidden()
  await expect(updates.getByText('p. 150')).toBeVisible()
  await expect(updates.getByRole('listitem')).toHaveCount(1)
})
