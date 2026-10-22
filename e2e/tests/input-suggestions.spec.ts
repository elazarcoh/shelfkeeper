import { expect, test } from '@playwright/test'

// Runs after household-library (file order) as its admin "parent", which added The Final Empire (Brandon Sanderson,
// Mistborn #1). Adds "The Well of Ascension" (Mistborn #2) and "The Hero of Ages", both visible to member "kid":
// library-series counts them in kid's household catalog.
test('name fields suggest what the library already has, and the series row picks the next position', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()

  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill('The Well of Ascension')

  // authors: a partial name offers the existing author; a click picks it
  const authors = page.getByLabel('Authors (one per line)')
  await authors.fill('brand')
  await page.getByRole('option', { name: 'Brandon Sanderson' }).click()
  await expect(authors).toHaveValue('Brandon Sanderson')

  // series: ArrowDown + Enter picks (and must not submit the form); the position fills with the next number
  await page.getByRole('button', { name: 'Add series' }).click()
  const seriesName = page.getByLabel('Series name 1')
  await seriesName.fill('mist')
  await expect(page.getByRole('option', { name: 'Mistborn' })).toBeVisible()
  await seriesName.press('ArrowDown')
  await seriesName.press('Enter')
  await expect(page).toHaveURL(/\/books\/new$/)
  await expect(seriesName).toHaveValue('Mistborn')
  await expect(page.getByLabel('Series position 1')).toHaveValue('2')
  await expect(page.getByText('In this series: #1 — next #2')).toBeVisible()

  // a misspelling is called out before saving
  await page.getByRole('button', { name: 'Add series' }).click()
  await page.getByLabel('Series name 2').fill('Mistborm')
  await expect(page.getByText('New series — will be created')).toBeVisible()
  await page.getByRole('button', { name: 'Remove series 2' }).click()

  await page.getByLabel('Tags (comma separated)').fill('Epic fantasy, Cosmere')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'The Well of Ascension' })).toBeVisible()
  // joined the existing series, not a new one
  await expect(page.getByText(/Mistborn #1 — The Final Empire/)).toBeVisible()

  // tags in the edit dialog: a pick keeps the earlier tags; Esc closes the list, not the dialog
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  await page.getByLabel('Search books').fill('final empire')
  await page.getByRole('link', { name: /The Final Empire/ }).first().click()
  await page.getByRole('button', { name: 'Edit details' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit book' })
  const tagsField = dialog.getByLabel('Tags (comma separated)')
  await tagsField.fill('cos')
  await dialog.getByRole('option', { name: 'Cosmere' }).click()
  await tagsField.press('End')
  await tagsField.pressSequentially('epic')
  await expect(dialog.getByRole('option', { name: 'Epic fantasy' })).toBeVisible()
  await tagsField.press('Escape')
  await expect(dialog.getByRole('listbox')).toBeHidden()
  await expect(dialog).toBeVisible()
  await tagsField.press('ArrowDown')
  await expect(dialog.getByRole('option', { name: 'Epic fantasy' })).toBeHidden()
  await tagsField.pressSequentially(' f')
  await dialog.getByRole('option', { name: 'Epic fantasy' }).click()
  await expect(tagsField).toHaveValue('Cosmere, Epic fantasy, ')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
})

test('edition fields and the borrower suggest what was entered before', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()

  // household-library set The Final Empire's shelf location to "Living room"
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill('The Hero of Ages')
  await page.getByLabel('Authors (one per line)').fill('Brandon Sanderson')
  const shelf = page.getByLabel('Shelf location')
  await shelf.fill('liv')
  await page.getByRole('option', { name: 'Living room' }).click()
  await expect(shelf).toHaveValue('Living room')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'The Hero of Ages' })).toBeVisible()

  // lend it, take it back, lend again: the borrower is offered
  await page.getByRole('button', { name: 'Lend it out' }).click()
  await page.getByRole('dialog').getByLabel("Borrower's name").fill('Dana Levi')
  await page.getByRole('dialog').getByRole('button', { name: 'Lend' }).click()
  await page.getByRole('button', { name: 'Mark returned' }).click()
  await page.getByRole('button', { name: 'Lend it out' }).click()
  const borrower = page.getByRole('dialog').getByLabel("Borrower's name")
  await borrower.fill('dan')
  await page.getByRole('option', { name: 'Dana Levi' }).click()
  await expect(borrower).toHaveValue('Dana Levi')
  await page.keyboard.press('Escape')
})
