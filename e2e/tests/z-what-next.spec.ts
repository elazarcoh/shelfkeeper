import { expect, test, type Page } from '@playwright/test'

// Runs after z-hardcover (file order) as its admin "parent", against e2e/fake-hardcover (#56). The fake knows the series
// "Wnxt Saga" (Hardcover has #3), its author, a recent book of the author's, a recommended book at #2 of a series the
// library lacks, and one book on the user's Read list that the recommendations also name.
const TOKEN = 'fake-hardcover-token-e2e-0001'
const SERIES = 'Wnxt Saga'
const AUTHOR = 'Wnxt Author'
const BOOKS = [
  { title: 'Wnxt Saga One', isbn: '9789001000011', position: '1' },
  { title: 'Wnxt Saga Two', isbn: '9789001000028', position: '2' },
  { title: 'Wnxt Standalone', isbn: '9789001000035', position: null },
]

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function addBook(page: Page, b: (typeof BOOKS)[number]) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(b.title)
  await page.getByLabel('Authors (one per line)').fill(AUTHOR)
  await page.getByLabel('Format').selectOption('physical')
  await page.getByLabel('ISBN-13').fill(b.isbn)
  if (b.position !== null) {
    await page.getByRole('button', { name: 'Add series' }).click()
    await page.getByLabel('Series name 1').fill(SERIES)
    await page.getByLabel('Series position 1').fill(b.position)
  }
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: b.title })).toBeVisible()
  // the series books go in Up next, which ranks them ahead of whatever earlier specs left unread (the list shows five)
  if (b.position !== null) {
    await page.getByRole('button', { name: 'Add to Up next' }).click()
    await expect(page.getByRole('button', { name: 'Remove from Up next' })).toBeVisible()
  }
  return page.url()
}

/** "Mark as read…" with today's date, so the book counts as the last finished one. */
async function markFinished(page: Page) {
  await page.getByRole('button', { name: 'Mark as read…' }).click()
  const sheet = page.getByRole('dialog', { name: 'When did you finish?' })
  await sheet.getByRole('button', { name: 'Exact date' }).click()
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByLabel('Status')).toHaveValue('read')
}

const section = (page: Page, title: string) => page.getByRole('region', { name: title })
const row = (page: Page, title: string) => page.getByRole('listitem').filter({ hasText: title })

test('What next: shelf, series and author picks from the cache, the Read list hidden, the mood chips, the AI answer and the Wishlist (#56)', async ({ page }) => {
  await signIn(page)

  // the household connects Hardcover; the admin links the same fake as a personal account (its Read list is read with that token)
  await page.goto('/admin/hardcover')
  await page.getByLabel('Hardcover API token').fill(TOKEN)
  await page.getByRole('button', { name: 'Save token' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Connected as @fakehome' })).toBeVisible()
  await page.goto('/account')
  await page.getByLabel('Hardcover API token').fill(TOKEN)
  await page.getByRole('button', { name: 'Save token' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Connected as @fakehome' })).toBeVisible()

  const urls: string[] = []
  for (const b of BOOKS) urls.push(await addBook(page, b))
  const [one, two, standalone] = urls as [string, string, string]

  // a series shows once on the shelf: its lowest unread book
  await page.goto('/next?mood=keep_going&format=any')
  await expect(section(page, 'On your shelves')).toBeVisible()
  await expect(row(page, 'Wnxt Saga One')).toBeVisible()
  await expect(row(page, 'Wnxt Saga Two')).toHaveCount(0)

  // finishing #1: the toast leads to the page, and #2 is next in the series
  await page.goto(one)
  await markFinished(page)
  await page.getByRole('button', { name: 'What next?' }).click()
  await expect(page).toHaveURL(/\/next/)
  await expect(page.getByText('You just finished')).toBeVisible()
  // an earlier spec left this person on Audiobook, which would hide the print books
  await page.getByRole('button', { name: 'Any format' }).click()
  const shelf = section(page, 'On your shelves')
  await expect(row(page, 'Wnxt Saga Two')).toBeVisible()
  await expect(shelf.getByText(`Next in ${SERIES} (#2)`)).toBeVisible()

  // #2 and a standalone make three reads of the author, so the author's new books are asked for
  await page.goto(two)
  await markFinished(page)
  await page.goto(standalone)
  await markFinished(page)

  await page.goto('/admin/hardcover')
  await page.getByRole('button', { name: 'Refresh now' }).click()
  // the worker polls every 10 s; its explore step caches the series, the author's books and the details of what the page may show
  await expect(async () => {
    await page.goto('/next?mood=keep_going&format=any')
    await expect(row(page, 'Wnxt Saga Three')).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 90_000 })
  await expect(section(page, 'Next in your series').getByText(`Next in ${SERIES} (#3)`)).toBeVisible()
  const authors = section(page, 'New from your authors')
  await expect(authors.getByText('Wnxt New Release')).toBeVisible()
  // a book outside the 24-month window is not offered
  await expect(page.getByText('Wnxt Old Release')).toHaveCount(0)

  // light: the series list is hidden; the recommended book at #2 names the first unread book of its series
  await page.getByRole('button', { name: 'Something light' }).click()
  await expect(page).toHaveURL(/mood=light/)
  await expect(page.getByRole('heading', { name: 'Next in your series' })).toHaveCount(0)
  const recommended = row(page, 'Wnxt Other Two')
  await expect(recommended).toBeVisible()
  await expect(recommended.getByText('First unread: Wnxt Other One (#1)')).toBeVisible()
  // the book on the personal Hardcover Read list is recommended too, but never shown, in any mood
  await expect(page.getByText('Wnxt Already Read')).toHaveCount(0)
  await page.goto('/next?mood=surprise&format=any')
  await expect(row(page, 'Wnxt Other Two')).toBeVisible()
  await expect(page.getByText('Wnxt Already Read')).toHaveCount(0)

  // a Hardcover pick goes on the Wishlist
  await page.goto('/next?mood=light&format=any')
  await row(page, 'Wnxt Other Two').getByRole('button', { name: 'Add to Wishlist' }).click()
  await expect(row(page, 'Wnxt Other Two').getByText('On your Wishlist')).toBeVisible()
  await page.goto('/wishlist')
  await expect(page.getByText('Wnxt Other Two')).toBeVisible()

  // a pasted AI answer with prose around the JSON: the read book is left out, the fanfiction keeps its link
  await page.goto('/next?mood=surprise&format=any')
  const answer = [
    'Sure, here are my picks:',
    '[{"title": "Wnxt Saga One", "authors": ["Wnxt Author"], "reason": "You loved it"},',
    ' {"title": "Wnxt Serial Z", "authors": ["Fan Writer"], "kind": "fanfiction", "url": "https://example.org/wnxt-serial", "reason": "A gripping web serial"}]',
    'Enjoy!',
  ].join('\n')
  await page.getByLabel("Paste the AI's answer").fill(answer)
  await page.getByRole('button', { name: 'Show picks' }).click()
  await expect(page.getByText("1 pick you've already read was left out")).toBeVisible()
  const ai = section(page, 'Ask AI')
  await expect(row(page, 'Wnxt Serial Z')).toHaveCount(1)
  await expect(ai.getByText('Fanfiction', { exact: true })).toBeVisible()
  await expect(ai.getByRole('link', { name: 'Open link' })).toHaveAttribute('href', 'https://example.org/wnxt-serial')
  await expect(row(page, 'Wnxt Saga One')).toHaveCount(0)

  await row(page, 'Wnxt Serial Z').getByRole('button', { name: 'Add to Wishlist' }).click()
  await expect(row(page, 'Wnxt Serial Z').getByText('On your Wishlist')).toBeVisible()
  await page.goto('/wishlist')
  await expect(page.getByText('Wnxt Serial Z')).toBeVisible()

  // clean up: zz-wishlist expects an empty Wishlist for this user
  for (const title of ['Wnxt Other Two', 'Wnxt Serial Z']) {
    await row(page, title).getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText(title)).toHaveCount(0)
  }
  await expect(page.getByText('Nothing here yet')).toBeVisible()
})
