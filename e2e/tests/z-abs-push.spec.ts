import { expect, test, type Page } from '@playwright/test'

// Runs after household-library (admin "parent") and sources-inbox (the "Home ABS" source, with The Final Empire
// linked to its Mistborn audiobook). Changes the book's subtitle, sends it to the fake ABS from Admin → Health and
// syncs again (#115). The fake keeps what it was sent in memory, so it is reset before and after.
const FAKE_ABS = 'http://localhost:18081'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

test.afterAll(async ({ request }) => {
  await request.post(`${FAKE_ABS}/__reset`)
})

test('an admin sends a changed subtitle to Audiobookshelf and a sync leaves it alone', async ({ page, request }) => {
  await request.post(`${FAKE_ABS}/__reset`)
  // per run: the work keeps the subtitle of an earlier attempt
  const subtitle = `Mistborn Saga ${String(Date.now())}`
  await signIn(page)

  // a failed attempt may have left Title unticked (kept per user): start from the default
  await page.goto('/admin/health?check=abs_out_of_sync')
  const title = page.getByRole('checkbox', { name: 'Title', exact: true })
  await expect(title).toBeVisible()
  if (!(await title.isChecked())) await title.click()
  await expect(title).toBeChecked()

  await page.goto('/library?scope=catalog&q=final+empire')
  await page.getByRole('link', { name: /The Final Empire/ }).first().click()
  await page.getByRole('button', { name: 'Edit details' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit book' })
  await edit.getByLabel('Subtitle').fill(subtitle)
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(subtitle).first()).toBeVisible()
  const bookUrl = page.url()

  await page.goto('/admin/health?check=abs_out_of_sync')
  await expect(page.getByRole('tab', { name: /^Out of sync with Audiobookshelf \d+$/ })).toBeVisible()
  const row = page.getByRole('list', { name: 'Out of sync with Audiobookshelf' }).getByRole('listitem').filter({ hasText: 'The Final Empire' }).first()
  await expect(row.getByText('Subtitle:')).toBeVisible()
  await expect(row.getByText(subtitle)).toBeVisible()

  try {
    // the choice of fields is remembered per user
    await title.click()
    await expect(title).not.toBeChecked()
    await page.reload()
    await expect(page.getByRole('checkbox', { name: 'Title', exact: true })).not.toBeChecked()

    // only this book is ticked, and only its ticked fields go out
    await page.getByRole('button', { name: /^Send \d+ books?$/ }).click()
    await expect(page.getByText(/^Sent \d+ · 0 failed$/)).toBeVisible({ timeout: 30_000 })
    const patches = (await (await request.get(`${FAKE_ABS}/__patches`)).json()) as { id: string; body: { metadata: Record<string, unknown> } }[]
    const mine = patches.filter((p) => p.id === 'li_mistborn')
    expect(mine).toHaveLength(1)
    expect(Object.keys(mine[0]?.body.metadata ?? {})).toEqual(['subtitle'])
    expect(mine[0]?.body.metadata.subtitle).toBe(subtitle)

    // a sync reads back what ABS now holds: the book is unchanged and no longer out of sync
    await page.goto('/admin/sources')
    const source = page.getByRole('listitem').filter({ hasText: 'Home ABS' })
    const lastSync = source.getByText(/last sync/)
    const before = await lastSync.textContent()
    await source.getByRole('button', { name: 'Sync now' }).click()
    await expect(async () => {
      await page.reload()
      expect(await lastSync.textContent()).not.toBe(before)
    }).toPass({ timeout: 30_000 })

    await page.goto(bookUrl)
    await expect(page.getByText(subtitle).first()).toBeVisible()
    await page.goto('/admin/health?check=abs_out_of_sync')
    // the panel has loaded once its freshness line shows
    await expect(page.getByText(/Audiobookshelf last synced/)).toBeVisible()
    await expect(page.getByRole('list', { name: 'Out of sync with Audiobookshelf' }).getByText('The Final Empire')).toHaveCount(0)
  } finally {
    // later specs see the default choice
    await page.goto('/admin/health?check=abs_out_of_sync')
    const again = page.getByRole('checkbox', { name: 'Title', exact: true })
    await expect(again).toBeVisible()
    if (!(await again.isChecked())) await again.click()
    await expect(again).toBeChecked()
  }
})
