import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// Runs after household-library (file order) as its admin "parent".
const here = path.dirname(fileURLToPath(import.meta.url))
const photo = path.join(here, '..', '..', 'apps', 'web', 'public', 'icon-512.png')
const TITLE = 'Cover Photo Book'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('on a phone, a cover can be taken with the camera and framed as a book before it is saved (#155)', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()

  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(TITLE)
  await page.getByLabel('Authors (one per line)').fill('Camera Person')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()

  await page.getByRole('button', { name: 'More actions for this copy' }).click()
  await page.getByRole('menuitem', { name: 'Set cover…' }).click()
  const dialog = page.getByRole('dialog')
  // the camera input asks for the back camera; the test hands it a picture as the phone would
  await expect(page.getByLabel('Cover photo')).toHaveAttribute('capture', 'environment')
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Take a photo' }).click()
  await (await chooser).setFiles(photo)

  // a photo starts on the book frame, ready to trim what's around the cover
  await expect(dialog.getByTestId('cover-crop')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Book 2:3' })).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: 'Save cover' }).click()
  await expect(page.getByText('Cover set')).toBeVisible()
  await expect(page.locator('img[src*="/media/"]').first()).toBeVisible()
})
