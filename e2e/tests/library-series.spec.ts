import { expect, test, type Page } from '@playwright/test'

// Runs after household-library (file order) and reuses its household: admin "parent" with The Final Empire (Mistborn #1)
// in their library, and member "kid", whose library is still empty and from whom The Final Empire is hidden.

const SERIES = 'The Lantern Cycle'
// added out of order: the series view must put #1 first
const BOOKS = [
  { title: 'Lantern Two: Ashfall', position: '2' },
  { title: 'Lantern Three: Daybreak', position: '3' },
  { title: 'Lantern One: Embers', position: '1' },
]

async function signIn(page: Page, username: string, password: string, name: string) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Hi, ${name}` })).toBeVisible()
}

async function addBook(page: Page, title: string, position: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Ilse Marrow')
  await page.getByRole('button', { name: 'Add series' }).click()
  await page.getByLabel('Series name 1').fill(SERIES)
  await page.getByLabel('Series position 1').fill(position)
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

const seriesCard = (page: Page, name: string) => page.getByRole('link', { name: new RegExp(`^Series: ${name}`) })

test('a series shows as one card that opens on its books in order; the switch shows the whole catalog', async ({ page }) => {
  await signIn(page, 'parent', 'parent password', 'Parent')
  for (const b of BOOKS) await addBook(page, b.title, b.position)

  // collapse is on by default: one card per series, its books not shown one by one
  await page.goto('/library')
  await expect(page.getByRole('radio', { name: 'My library' })).toBeChecked()
  const card = seriesCard(page, SERIES)
  await expect(card).toBeVisible()
  await expect(card).toContainText('3 books')
  await expect(seriesCard(page, 'Mistborn')).toBeVisible()
  await expect(page.getByRole('link', { name: /Lantern One/ })).toHaveCount(0)

  // inside the series: its books in series order, the series as a pill with the way back
  await card.click()
  await expect(page).toHaveURL(/seriesIds=/)
  // exact: until the series query answers, the list still shows the collapsed card, whose link text also starts so
  await expect(page.getByText(`Series: ${SERIES}`, { exact: true })).toBeVisible()
  const books = page.getByRole('link', { name: /^Lantern/ })
  await expect(books).toHaveCount(3)
  await expect(books.nth(0)).toContainText('Lantern One: Embers')
  await expect(books.nth(1)).toContainText('Lantern Two: Ashfall')
  await expect(books.nth(2)).toContainText('Lantern Three: Daybreak')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(seriesCard(page, SERIES)).toBeVisible()

  // search text shows matching books one by one
  await page.getByLabel('Search books').fill('lantern')
  await expect(page.getByRole('link', { name: /^Lantern/ })).toHaveCount(3)
  await expect(seriesCard(page, SERIES)).toHaveCount(0)
  await page.getByLabel('Search books').fill('')

  // the switch: the whole catalog, in the URL, and Back returns to My library
  await page.getByRole('radio', { name: 'Whole catalog' }).check()
  await expect(page).toHaveURL(/scope=catalog/)
  await expect(page.getByRole('heading', { name: 'Whole catalog' })).toBeVisible()
  await expect(seriesCard(page, SERIES)).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('radio', { name: 'My library' })).toBeChecked()
})

test('the series pill’s Back returns to the Library as it was, and leaves no extra history entry', async ({ page }) => {
  await signIn(page, 'parent', 'parent password', 'Parent')
  await page.goto('/library?sort=added')
  await expect(page.getByLabel('Sort')).toHaveValue('added')
  await seriesCard(page, SERIES).click()
  // inside: series order, whatever the Library was sorted by
  await expect(page.getByLabel('Sort')).toHaveValue('series')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).not.toHaveURL(/seriesIds=/)
  await expect(page).toHaveURL(/sort=added/)
  await expect(page.getByLabel('Sort')).toHaveValue('added')
  await expect(seriesCard(page, SERIES)).toBeVisible()
  // the browser's Back now leaves the Library: no phantom copy of it in between
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
  await expect(page).not.toHaveURL(/\/library/)
})

test('an empty personal library says how big the household catalog is, and opens it', async ({ page }) => {
  await signIn(page, 'kid', 'kid password', 'Kid')
  await page.goto('/library')
  await expect(page.getByText('Your library is empty')).toBeVisible()
  // the three Lantern books and input-suggestions' The Well of Ascension and The Hero of Ages (The Final Empire is
  // hidden from kid)
  await expect(page.getByText('The household catalog has 5 books.')).toBeVisible()
  await page.getByRole('button', { name: 'Browse the whole catalog' }).click()
  await expect(page.getByRole('radio', { name: 'Whole catalog' })).toBeChecked()
  await expect(seriesCard(page, SERIES)).toContainText('3 books')
  // a new history entry, as from the switch: Back returns to the empty library
  await page.goBack()
  await expect(page.getByText('Your library is empty')).toBeVisible()
})

test('a book can hold a range of the series: #4–5 on its page, and a backwards range is refused (#122)', async ({ page }) => {
  await signIn(page, 'parent', 'parent password', 'Parent')
  await addBook(page, 'Lantern Omnibus', '4-5')
  await expect(page.getByText(`${SERIES} #4–5`).first()).toBeVisible()

  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill('Lantern Backwards')
  await page.getByLabel('Authors (one per line)').fill('Ilse Marrow')
  await page.getByRole('button', { name: 'Add series' }).click()
  await page.getByLabel('Series name 1').fill(SERIES)
  await page.getByLabel('Series position 1').fill('6-5')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByText('Use a number like 3 or a range like 1-2')).toBeVisible()
})
