import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// #161, as household-library's admin "parent": a book from a shelf photo gets its cover photo while it waits in the
// Inbox, and keeps it as its cover once it's added.
const here = path.dirname(fileURLToPath(import.meta.url))
const photo = path.join(here, '..', '..', 'apps', 'web', 'public', 'icon-512.png')
const TITLE = 'Inbox Cover Photo Book'
const answer = `\`\`\`json\n[{"position":1,"title":"${TITLE}","authors":["Shelf Photographer"]}]\n\`\`\``

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('a book waiting in the Inbox gets a cover photo, which becomes its cover on Create (#161)', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()

  await page.goto('/books/shelf')
  await page.getByLabel("The AI's answer").fill(answer)
  await page.getByRole('button', { name: 'Read the list' }).click()
  await page.getByRole('button', { name: 'Add 1 book' }).click()
  await expect(page).toHaveURL(/\/inbox\?batch=/)

  const card = page.getByRole('region', { name: TITLE })
  await card.getByRole('button', { name: 'Cover photo' }).click()
  const dialog = page.getByRole('dialog', { name: 'Cover photo' })
  await dialog.getByLabel('Cover picture').setInputFiles(photo)
  await expect(dialog.getByTestId('cover-crop')).toBeVisible()
  await dialog.getByRole('button', { name: 'Save cover' }).click()
  await expect(page.getByText('Cover photo saved')).toBeVisible()
  // the waiting book shows its photo, served to its owner before it's in the library
  await expect(card.locator('img[src*="/media/"]').first()).toBeVisible()
  await expect(card.getByRole('button', { name: 'Change cover photo' })).toBeVisible()

  await card.getByRole('button', { name: 'Create new book' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.goto('/library')
  const search = page.getByLabel('Search books')
  await search.fill(TITLE)
  await expect(search).toHaveAccessibleDescription('1 book')
  await page.getByRole('link', { name: new RegExp(`^${TITLE}`) }).first().click()
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
  await expect(page.locator('img[src*="/media/"]').first()).toBeVisible()
})
