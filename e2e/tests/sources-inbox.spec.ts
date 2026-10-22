import { expect, test } from '@playwright/test'

// Runs after household-library.spec.ts (one worker, files in name order), which created the admin
// "parent" and the physical book "The Final Empire".
test('an admin syncs Audiobookshelf and files a book from the Inbox', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Username').fill('parent')
  // the "Password" tab panel is itself named "Password" (Radix labels tabpanels after their
  // trigger), so getByLabel('Password') is ambiguous here; the input's role narrows it down
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()

  // add and test the source
  await page.getByRole('link', { name: 'Admin', exact: true }).click()
  await page.getByRole('link', { name: 'Sources', exact: true }).click()
  await page.getByRole('button', { name: 'Add source' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name', { exact: true }).fill('Home ABS')
  await dialog.getByLabel('Server URL').fill('http://fake-abs')
  await dialog.getByLabel('API token').fill('fixture-token')
  await dialog.getByRole('button', { name: 'Save source' }).click()
  await expect(page.getByText('Home ABS').first()).toBeVisible()
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('Connected — Audiobooks')).toBeVisible()

  // the worker picks up "Sync now"
  await page.getByRole('button', { name: 'Sync now' }).click()
  await page.getByRole('link', { name: 'Jobs', exact: true }).click()
  await expect(page.getByText('Succeeded')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('3 seen · 3 new')).toBeVisible()

  // review in the Inbox: the audiobook joins the book we already have
  await page.getByRole('link', { name: /^Inbox/ }).click()
  await expect(page.getByRole('region', { name: 'הארי פוטר ואבן החכמים' }).first()).toBeVisible()
  const mistborn = page.getByRole('region', { name: 'The Final Empire' })
  await mistborn.getByRole('button', { name: 'Add as new edition' }).first().click()
  await expect(page.getByText('Added to the catalog')).toBeVisible()
  await expect(mistborn).toHaveCount(0)

  await page.getByRole('link', { name: 'Library', exact: true }).click()
  await page.getByLabel('Search books').fill('final empire')
  await page.getByRole('link', { name: /The Final Empire/ }).first().click()
  await expect(page.getByText('Audiobook', { exact: true })).toBeVisible()

  // the worker downloads the linked copy's cover after the resolution; the page shows it once it is there
  await expect(async () => {
    await page.reload()
    await expect(page.locator('img[src^="/media/"]').first()).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
})

// #13: on a phone an Inbox card shows its best match; the rest are one tap away. The fixture's remaining cards
// (the Hebrew Harry Potter items) have no stored matches, so the first card's list response gets three made-up ones.
test('a phone Inbox card shows its best match and reveals the rest on request', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  const match = (n: number) => ({
    workId: `00000000-0000-4000-8000-00000000000${String(n)}`,
    editionId: null,
    basis: 'title_author',
    score: 0.9 - n / 10,
    reasons: ['Title is similar', 'Same author'],
    card: {
      id: `00000000-0000-4000-8000-00000000000${String(n)}`,
      title: `Made-up match ${String(n)}`,
      subtitle: null,
      authors: ['Someone'],
      series: null,
      formats: ['ebook'],
      availability: 'owned',
      status: 'unread',
      rating: null,
      inQueue: false,
      coverAssetId: null,
    },
    edition: null,
  })
  await page.route(/\/trpc\/[^?]*inbox\.list/, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { result: { data: { json: { items: { candidates: unknown[] }[] } } } }[]
    const procedures = decodeURIComponent(new URL(route.request().url()).pathname.split('/trpc/')[1] ?? '').split(',')
    const first = body[procedures.indexOf('inbox.list')]?.result.data.json.items[0]
    if (first) first.candidates = [match(1), match(2), match(3)]
    await route.fulfill({ response, json: body })
  })

  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
  await page.goto('/inbox')

  const card = page.getByRole('region', { name: 'הארי פוטר ואבן החכמים' }).first()
  await expect(card.getByText('Made-up match 1')).toBeVisible()
  await expect(card.getByText('Made-up match 2')).toBeHidden()
  // the reasons share one line
  await expect(card.getByText('Title is similar · Same author').first()).toBeVisible()

  await card.getByRole('button', { name: 'Show 2 more matches' }).click()
  await expect(card.getByText('Made-up match 3')).toBeVisible()
  await expect(card.getByRole('button', { name: /Show \d+ more/ })).toHaveCount(0)
  // the tapped button is gone: focus lands on the first match it revealed, not on the page
  await expect(card.getByRole('listitem').nth(1).getByRole('button').first()).toBeFocused()
  await context.close()
})
