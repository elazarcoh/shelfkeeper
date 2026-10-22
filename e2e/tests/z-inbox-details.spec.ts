import { expect, test } from '@playwright/test'

// after z-csv-volumes (file name): household-library.spec.ts created the member "kid"; leaves kid's Inbox empty
test('Details… files an Inbox row onto an existing book as volume 2 of 3', async ({ page }) => {
  // #138: a CI retry finds the first attempt's book and edition, so each attempt files a title of its own
  const title = ['Glass Lanterns', 'Paper Lanterns', 'Stone Lanterns'][test.info().retry] ?? `Lanterns ${test.info().retry}`
  const csv = ['Title,Author', `${title},Mira Okafor`, ''].join('\n')

  await page.goto('/')
  await page.getByLabel('Username').fill('kid')
  await page.getByRole('textbox', { name: 'Password' }).fill('kid password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  // a row's matches are found when the CSV is imported, so the book must exist before the second import
  const importCsv = async (name: string) => {
    await page.getByRole('link', { name: 'Add book' }).first().click()
    await page.getByRole('link', { name: 'Import a CSV file' }).click()
    await page.getByLabel('CSV file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await page.getByRole('button', { name: 'Send to my Inbox' }).click()
    await page.getByRole('link', { name: 'Go to my Inbox' }).click()
  }
  const rows = page.getByRole('region', { name: title })

  await importCsv('first.csv')
  await rows.getByRole('button', { name: 'Create new book' }).click()
  await expect(rows).toHaveCount(0)

  await importCsv('details.csv')
  await rows.getByRole('button', { name: 'Details…' }).first().click()

  const dialog = page.getByRole('dialog', { name: `Add to ${title}` })
  await dialog.getByLabel('Volume', { exact: true }).fill('2')
  await dialog.getByLabel('Of', { exact: true }).fill('3')
  await dialog.getByRole('button', { name: 'Add edition' }).click()
  await expect(dialog).toBeHidden()
  await expect(rows).toHaveCount(0)

  await page.getByRole('link', { name: 'Library', exact: true }).click()
  const search = page.getByLabel('Search books')
  await search.fill(title.toLowerCase())
  // #138: kid's unsearched list already shows the card, and a click while the results re-render goes nowhere;
  // the box is described by its count, which reads "1 book" only once the searched list has loaded
  await expect(search).toHaveAccessibleDescription('1 book')
  await page.getByRole('link', { name: new RegExp(title) }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title)
  await expect(page.getByText('Vol 2 of 3', { exact: true })).toBeVisible()
})
