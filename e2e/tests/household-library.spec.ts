import { expect, test } from '@playwright/test'

test('a household sets up, adds, finds, tracks and hides a book', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept())

  // first run: create the admin
  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)
  await page.getByLabel('Username').fill('parent')
  await page.getByLabel('Display name').fill('Parent')
  await page.getByLabel('Password').fill('parent password')
  await page.getByRole('button', { name: 'Create admin account' }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()

  // add a physical book
  await page.getByRole('link', { name: 'Add book' }).click()
  await page.getByLabel('Title', { exact: true }).fill('The Final Empire')
  await page.getByLabel('Authors (one per line)').fill('Brandon Sanderson')
  await page.getByRole('button', { name: 'Add series' }).click()
  await page.getByLabel('Series name 1').fill('Mistborn')
  await page.getByLabel('Series position 1').fill('1')
  await page.getByLabel('ISBN-13').fill('978-0-7653-1178-8')
  await page.getByLabel('Shelf location').fill('Living room')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'The Final Empire' })).toBeVisible()

  // fuzzy multi-field search, then track it
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  // #73: the first letters of the title find it too
  await page.getByLabel('Search books').fill('tfe')
  await expect(page.getByRole('link', { name: /The Final Empire/ }).first()).toBeVisible()
  // #98: × clears the field at once and keeps the focus there; Esc clears it too
  await page.getByLabel('Search books').fill('no such book')
  await expect(page.getByText('No books match')).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(page.getByLabel('Search books')).toHaveValue('')
  await expect(page.getByLabel('Search books')).toBeFocused()
  await expect(page).not.toHaveURL(/[?&]q=/)
  await expect(page.getByText('No books match')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Clear search' })).toHaveCount(0)
  await page.getByLabel('Search books').fill('no such book')
  await expect(page.getByText('No books match')).toBeVisible()
  await page.getByLabel('Search books').press('Escape')
  await expect(page.getByLabel('Search books')).toHaveValue('')
  await expect(page.getByText('No books match')).toHaveCount(0)
  await page.getByLabel('Search books').fill('brandon empire')
  await page.getByRole('link', { name: /The Final Empire/ }).first().click()
  await page.getByRole('button', { name: 'Rate 5 stars' }).click()
  await expect(page.getByRole('group', { name: 'Rated 5 of 5' })).toBeVisible()
  // with a mouse, the left half of a star gives the half
  await page.getByRole('button', { name: 'Rate 5 stars' }).click({ position: { x: 4, y: 22 } })
  await expect(page.getByRole('group', { name: 'Rated 4.5 of 5' })).toBeVisible()
  // from the keyboard (as on touch), pressing the same star again toggles the half
  await page.getByRole('button', { name: 'Rate 5 stars' }).press('Enter')
  await expect(page.getByRole('group', { name: 'Rated 5 of 5' })).toBeVisible()
  await page.getByRole('button', { name: 'Rate 5 stars' }).press('Enter')
  await expect(page.getByRole('group', { name: 'Rated 4.5 of 5' })).toBeVisible()
  await page.getByLabel('Status').selectOption('reading')
  await page.getByRole('button', { name: 'Add to Up next' }).click()
  await expect(page.getByRole('button', { name: 'Remove from Up next' })).toBeVisible()
  const bookUrl = page.url()

  await page.getByRole('link', { name: 'Home', exact: true }).click()
  // first visit of the day surfaces the check-in flow; nothing to resolve yet, so skip it
  await page.getByRole('button', { name: 'Skip' }).click()
  // the generated cover also renders the title (as decorative, possibly invisible, text); the
  // real title paragraph always comes after it in the DOM, hence .last()
  await expect(page.getByRole('region', { name: 'Up next' }).getByText('The Final Empire').last()).toBeVisible()
  await expect(page.getByRole('region', { name: 'Currently reading' }).getByText('The Final Empire').last()).toBeVisible()

  // losing the copy keeps the book, its rating and its history; getting it back restores it
  await page.goto(bookUrl)
  await page.getByRole('button', { name: 'No longer have it' }).click()
  await page.getByRole('dialog').getByLabel('Note').fill('Lent to a friend')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Formerly owned').first()).toBeVisible()
  await expect(page.getByRole('group', { name: 'Rated 4.5 of 5' })).toBeVisible()
  await page.getByRole('button', { name: 'Got it back' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'No longer have it' })).toBeVisible()

  // reading sessions: start and finish one from the book page (the same card check-in uses)
  await page.getByRole('button', { name: 'Start reading' }).click()
  await page.getByRole('button', { name: 'Finished' }).click()
  await page.getByRole('button', { name: 'Today' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Done' }).click() // dismiss the "up next / series continuation" suggestion
  await expect(page.getByLabel('Status')).toHaveValue('read')

  // a yearly goal picks up the book just finished
  await page.getByRole('link', { name: 'Parent' }).click()
  await page.getByLabel('Target').fill('12')
  await page.getByRole('button', { name: 'Add goal' }).click()
  await expect(page.getByText(/Books — \d{4}: 1 \/ 12/)).toBeVisible()

  await page.getByRole('link', { name: 'Stats', exact: true }).click()
  await expect(page.getByText('Books finished')).toBeVisible()
  await expect(page.getByText('Hours', { exact: true })).toBeVisible()

  // a second member who must never see the book
  await page.getByRole('link', { name: 'Admin', exact: true }).click()
  await page.getByRole('button', { name: 'New person' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Username').fill('kid')
  await dialog.getByLabel('Display name').fill('Kid')
  await dialog.getByLabel('Password').fill('kid password')
  await dialog.getByRole('button', { name: 'Create person' }).click()
  await page.getByRole('link', { name: /Kid/ }).click()
  await page.getByLabel('Find a book to hide').fill('final empire')
  await page.getByRole('button', { name: 'Hide The Final Empire' }).click()
  await expect(page.getByRole('button', { name: 'Unhide The Final Empire' })).toBeVisible()

  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByLabel('Username').fill('kid')
  // the "Password" tab panel is itself named "Password" (Radix labels tabpanels after their
  // trigger), so getByLabel('Password') is ambiguous here; the input's role narrows it down
  await page.getByRole('textbox', { name: 'Password' }).fill('kid password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Kid' })).toBeVisible()

  await page.getByRole('link', { name: 'Library', exact: true }).click()
  await page.getByRole('radio', { name: 'Whole catalog' }).check()
  await page.getByLabel('Search books').fill('empire')
  await expect(page.getByText('No books match')).toBeVisible()

  await page.goto(bookUrl)
  await expect(page.getByText('Book not found')).toBeVisible()
})
