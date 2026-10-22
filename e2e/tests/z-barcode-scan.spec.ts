import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// #157, as household-library's admin "parent": a photo of a back cover's barcode is read in the browser (headless
// Chromium has no barcode reader of its own, so the bundled one runs), looked up at e2e/fake-nli, reviewed and added;
// the scanner then opens for the next book, which is already here.
const BARCODE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'isbn-9789655310320.png')
const TITLE = 'לויתני האפר'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('scans a barcode photo, adds the book, and the next scan finds it already here (#157)', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()

  await page.goto('/books/shelf')
  const card = page.getByRole('region', { name: 'Add one book' })
  await card.getByRole('button', { name: 'Scan barcode' }).click()
  const scanner = page.getByRole('dialog', { name: 'Scan a barcode' })
  await expect(scanner).toBeVisible()

  const chooser = page.waitForEvent('filechooser')
  await scanner.getByRole('button', { name: 'Use a photo' }).click()
  await (await chooser).setFiles(BARCODE)
  await expect(scanner).toBeHidden()

  // the National Library's record, in the one-book review
  const add = page.getByRole('button', { name: 'Add to library' })
  await expect(add).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(TITLE).first()).toBeVisible()
  await add.click()
  await expect(page.getByText('Added', { exact: true })).toBeVisible()

  // the next book: the scanner is open again; this time the ISBN is typed
  await expect(scanner).toBeVisible()
  await scanner.getByLabel('Or type the ISBN').fill('978-965-531-032-0')
  await scanner.getByRole('button', { name: 'Look up' }).click()
  await expect(page.getByRole('button', { name: `Add a second copy of ${TITLE}` })).toBeVisible({ timeout: 15_000 })
})
