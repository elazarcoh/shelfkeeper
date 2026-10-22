import { expect, test } from '@playwright/test'

// Runs last (file name): it restores a backup, which rewinds the database for any spec after it.
// The admin "parent" and the imported "Project Hail Mary" come from the earlier specs.
test('an admin backs up, downloads the backup, restores it, and the library is still there', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await page.getByRole('link', { name: 'Admin' }).first().click()
  // Ruling R16: exact, because the stale-backup banner also links "Admin → Backups"
  await page.getByRole('link', { name: 'Backups', exact: true }).click()
  await page.getByRole('button', { name: 'Back up now' }).click()
  // the worker picks the job up within its 10 s poll; the list refreshes every 10 s
  const row = page.getByRole('listitem').filter({ hasText: 'Manual' }).first()
  await expect(row).toBeVisible({ timeout: 120_000 })
  await expect(row.getByText('Verified')).toBeVisible()

  // an admin-only zip download
  const download = page.waitForEvent('download')
  await row.getByRole('link', { name: 'Download' }).click()
  expect((await download).suggestedFilename()).toMatch(/^my-library-.+-manual\.zip$/)

  // restore it: typed confirmation, the maintenance page, then back here with the summary
  await row.getByRole('button', { name: 'Restore' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Restore' })).toBeDisabled()
  await dialog.getByLabel('Type "restore" to confirm').fill('restore')
  await dialog.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByText('Last restore')).toBeVisible({ timeout: 240_000 })
  await expect(page.getByText(/\d+ books · \d+ editions · \d+ sessions/)).toBeVisible()
  // the backup taken just before the restore is listed too
  await expect(page.getByRole('listitem').filter({ hasText: 'Before a restore' }).first()).toBeVisible()

  await page.getByRole('link', { name: 'Library', exact: true }).first().click()
  // "Project Hail Mary" is kid's own book (z-csv-import.spec.ts): the default "My library" scope only
  // shows works this signed-in user (parent) has personally added, so switch to the whole catalog.
  await page.getByRole('radio', { name: 'Whole catalog' }).check()
  await page.getByLabel('Search books').fill('hail mary')
  await expect(page.getByRole('link', { name: /Project Hail Mary/ }).first()).toBeVisible()
})
