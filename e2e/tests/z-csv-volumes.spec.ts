import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const csv = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'volumes.csv')

// after z-csv-import (file name): household-library.spec.ts created the member "kid"
test('two volume rows of a CSV become one book with two volumes, and the wish says what is missing', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Username').fill('kid')
  await page.getByRole('textbox', { name: 'Password' }).fill('kid password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  await page.getByRole('link', { name: 'Add book' }).first().click()
  await page.getByRole('link', { name: 'Import a CSV file' }).click()
  await page.getByLabel('CSV file').setInputFiles(csv)
  await page.getByRole('button', { name: 'Send to my Inbox' }).click()
  await page.getByRole('link', { name: 'Go to my Inbox' }).click()
  await page.getByRole('button', { name: /Create books for all unmatched/ }).click()
  await expect(page.getByText('Nothing to review')).toBeVisible()

  await page.getByRole('link', { name: 'Library', exact: true }).click()
  await page.getByLabel('Search books').fill('shards of glass')
  await expect(page.getByRole('link', { name: /Shards of Glass/ })).toHaveCount(1)
  await page.getByRole('link', { name: /Shards of Glass/ }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Shards of Glass')
  await expect(page.getByText('Vol 1 of 3', { exact: true })).toBeVisible()
  await expect(page.getByText('Vol 2 of 3', { exact: true })).toBeVisible()
  await expect(page.getByText('Missing: vol 3')).toBeVisible()

  await page.getByRole('button', { name: 'Want it' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Have vols 1, 2 of 3 — missing vol 3')).toBeVisible()

  // leave no wish behind: zz-wishlist expects kid's Wishlist to start empty
  await page.getByRole('button', { name: 'On your wishlist' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('button', { name: 'Want it' })).toBeVisible()
})
