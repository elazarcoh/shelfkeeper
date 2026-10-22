import { expect, test } from '@playwright/test'

// Runs after household-library (file order) as its admin "parent".
const TITLE = 'Offline Atlas'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('with no connection, the app opens the offline copy of the catalog and searches it (#62)', async ({ page, context }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()

  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(TITLE)
  await page.getByLabel('Authors (one per line)').fill('Map Maker')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()

  // the copy saved on the first page may predate this book: update it now, as before leaving the house
  await page.goto('/account')
  const card = page.locator('[data-slot="card"]').filter({ hasText: 'Offline copy' })
  await expect(card.getByRole('status')).toHaveText(/books, saved/)
  await card.getByRole('button', { name: 'Update now' }).click()
  await expect(card.getByRole('button', { name: 'Update now' })).toBeEnabled()

  // the service worker serves the app with no network once it controls the page
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)

  await context.setOffline(true)
  try {
    await page.goto('/library')
    await expect(page).toHaveURL(/\/offline$/)
    await expect(page.getByRole('heading', { name: 'Offline' })).toBeVisible()
    await expect(page.getByText("This is Parent's copy of the catalog")).toBeVisible()

    const search = page.getByLabel('Search the offline copy')
    const results = page.getByRole('list', { name: 'Offline results' })
    // on a phone (#167): the copy is there to browse before typing, and the keyboard waits for a tap
    await expect(results.getByText(TITLE)).toBeVisible()
    await expect(search).not.toBeFocused()
    await search.fill('atlas off')
    await expect(results.getByRole('listitem')).toHaveCount(1)
    await expect(results.getByText(TITLE)).toBeVisible()
    await expect(results.getByText('Owned', { exact: true })).toBeVisible()
    // first letters work as in the Library (#73)
    await search.fill('oa')
    await expect(results.getByText(TITLE)).toBeVisible()
    await search.fill('qqqzz')
    await expect(page.getByText('Not in the catalog')).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
})
