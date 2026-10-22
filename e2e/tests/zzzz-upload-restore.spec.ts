import { expect, test } from '@playwright/test'

// Runs last (file name, after zzz-backups.spec.ts): it restores a backup, which rewinds the database for
// any spec after it. The admin "parent" and "Project Hail Mary" come from the earlier specs.
test('an admin uploads a downloaded backup and restores it; the app comes back out of maintenance with that backup\'s data', async ({ page }, testInfo) => {
  test.setTimeout(420_000)
  await page.goto('/')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  // a fresh manual backup (signed in first, so this session is inside it and survives the restore)
  await page.getByRole('link', { name: 'Admin' }).first().click()
  await page.getByRole('link', { name: 'Backups', exact: true }).click()
  const manualRows = page.getByRole('listitem').filter({ hasText: 'Manual' })
  // zzz-backups left a manual backup behind: wait for the list to load, or `before` reads 0 and the old
  // backup (taken before this sign-in, so without this session) satisfies the count below
  await expect(manualRows.first()).toBeVisible()
  const before = await manualRows.count()
  await page.getByRole('button', { name: 'Back up now' }).click()
  // the worker picks the job up within its 10 s poll; the list refreshes every 10 s
  await expect(manualRows).toHaveCount(before + 1, { timeout: 120_000 })
  const newest = manualRows.first()
  await expect(newest.getByText('Verified')).toBeVisible()
  const downloading = page.waitForEvent('download')
  await newest.getByRole('link', { name: 'Download' }).click()
  const download = await downloading
  const backupName = download.suggestedFilename()
  expect(backupName).toMatch(/^my-library-.+-manual\.zip$/)
  const zipPath = testInfo.outputPath(backupName)
  await download.saveAs(zipPath)

  // a book added after the backup: restoring the upload must take it away again
  await page.getByRole('link', { name: 'Add book' }).first().click()
  await page.getByLabel('Title', { exact: true }).fill('Added After The Download')
  await page.getByLabel('Authors (one per line)').fill('E2E Author')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Added After The Download' })).toBeVisible()

  // upload it, then restore it
  await page.getByRole('link', { name: 'Admin' }).first().click()
  await page.getByRole('link', { name: 'Backups', exact: true }).click()
  await page.getByLabel('Backup file').setInputFiles(zipPath)
  await page.getByRole('button', { name: 'Restore this backup' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Restore' })).toBeDisabled()
  await dialog.getByLabel('Type "restore" to confirm').fill('restore')
  await dialog.getByRole('button', { name: 'Restore' }).click()
  // the maintenance page, then back on Admin → Backups with this upload's summary (zzz-backups' restore named a different file)
  await expect(page.getByText(`Restored ${backupName} on`)).toBeVisible({ timeout: 240_000 })
  await expect(page.getByText(/\d+ books · \d+ editions · \d+ sessions/)).toBeVisible()

  // out of maintenance
  const health = await page.request.get('/health')
  expect(health.status()).toBe(200)
  expect(await health.json()).toMatchObject({ ok: true, maintenance: null })

  // that backup's data: the earlier book is there, the one added after the download is gone
  await page.getByRole('link', { name: 'Library', exact: true }).first().click()
  await page.getByRole('radio', { name: 'Whole catalog' }).check()
  await page.getByLabel('Search books').fill('hail mary')
  await expect(page.getByRole('link', { name: /Project Hail Mary/ }).first()).toBeVisible()
  await page.getByLabel('Search books').fill('added after the download')
  await expect(page.getByText('No books match')).toBeVisible()
})
