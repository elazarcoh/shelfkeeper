import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const csv = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'reading-log.csv')

// Runs last (file name): household-library.spec.ts created the member "kid".
test('a member imports a reading log and gets the books, the reads and the ratings', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Username').fill('kid')
  await page.getByRole('textbox', { name: 'Password' }).fill('kid password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await page.getByRole('link', { name: 'Add book' }).first().click()
  await page.getByRole('link', { name: 'Import a CSV file' }).click()
  await page.getByLabel('CSV file').setInputFiles(csv)

  // the mapping was guessed from the header; the preview shows both rows, Hebrew included
  await expect(page.getByLabel('Title')).toHaveValue('0')
  await expect(page.getByLabel('My rating')).toHaveValue('3')
  await expect(page.getByText('Project Hail Mary')).toBeVisible()
  await expect(page.getByText('הנסיך הקטן')).toBeVisible()
  await expect(page.getByText('2 books to review (2 with a read date, 2 with a rating)')).toBeVisible()
  await page.getByRole('button', { name: 'Send to my Inbox' }).click()

  // the page no longer auto-navigates; it shows an "Import complete" section with a link to the Inbox
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible()
  await page.getByRole('link', { name: 'Go to my Inbox' }).click()
  await expect(page).toHaveURL(/\/inbox$/)
  await expect(page.getByRole('link', { name: 'Inbox, 2 waiting' }).first()).toBeVisible()
  const hailMary = page.getByRole('region', { name: 'Project Hail Mary' })
  await expect(hailMary.getByText('Read 2023-05-14 · ★ 5')).toBeVisible()
  await hailMary.getByRole('button', { name: 'Create new book' }).click()
  await expect(hailMary).toHaveCount(0)
  const prince = page.getByRole('region', { name: 'הנסיך הקטן' })
  await prince.getByRole('button', { name: 'Create new book' }).click()
  await expect(prince).toHaveCount(0)
  await expect(page.getByText('Nothing to review')).toBeVisible()

  // the headline: a book, a finished session and a rating for this member
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  await page.getByLabel('Search books').fill('hail mary')
  await page.getByRole('link', { name: /Project Hail Mary/ }).first().click()
  await expect(page.getByLabel('Status')).toHaveValue('read')
  await expect(page.getByText('Finished').first()).toBeVisible()
  await expect(page.getByText('2023-05-14 → 2023-05-14')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Rated 5 of 5' })).toBeVisible()
})
