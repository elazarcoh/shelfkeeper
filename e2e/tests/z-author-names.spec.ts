import { expect, test, type Page } from '@playwright/test'

const HEBREW = 'ברנדון סנדרסון'
const HE_BOOK = 'דרך המלכים (e2e)'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function addBook(page: Page, title: string, author: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill(author)
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

test('two spellings become one person, show their own spelling, and split apart again', async ({ page }) => {
  await signIn(page)
  await addBook(page, HE_BOOK, HEBREW)

  // merge the Hebrew spelling into Brandon Sanderson
  await page.goto('/admin/authors')
  await page.getByLabel('Find a person').fill('סנדרסון')
  const hebrew = page.getByRole('region', { name: HEBREW })
  await hebrew.getByRole('button', { name: 'Same person as…' }).click()
  const pick = page.getByRole('dialog', { name: 'Same person as…' })
  await pick.getByLabel('Find the other person').fill('Sanderson')
  await pick.getByRole('button', { name: 'Pick Brandon Sanderson' }).click()
  const review = page.getByRole('dialog', { name: 'Merge people' })
  await expect(review.getByText('You can split a name off again later.')).toBeVisible()
  // the default primary depends on book counts left by earlier specs, so choose it explicitly
  await review.getByRole('radio', { name: 'Brandon Sanderson' }).check()
  await review.getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(page.getByText('Merged into Brandon Sanderson')).toBeVisible()

  // one filter entry with both books, the signed-in user reads English first, so both cards show the English spelling
  await page.goto('/library?scope=catalog')
  const author = page.getByRole('combobox', { name: /^Author/ })
  await expect(author.locator('option', { hasText: 'Brandon Sanderson' })).toHaveText(`Brandon Sanderson (${HEBREW})`)
  await author.selectOption({ label: `Brandon Sanderson (${HEBREW})` })
  await expect(page.getByRole('link', { name: HE_BOOK })).toContainText('Brandon Sanderson')
  // The Final Empire sits inside the Mistborn series card; The Hero of Ages is a loose card (both by Brandon Sanderson)
  await expect(page.getByRole('link', { name: /The Hero of Ages/ })).toContainText('Brandon Sanderson')

  // the Hebrew spelling finds the English book
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent('סנדרסון')}`)
  await expect(page.getByRole('link', { name: /The Hero of Ages|Mistborn/ }).first()).toBeVisible()

  // split the Hebrew name off: two people again
  await page.goto('/admin/authors')
  await page.getByLabel('Find a person').fill('Sanderson')
  await page.getByRole('region', { name: 'Brandon Sanderson' }).getByRole('button', { name: `Actions for ${HEBREW}` }).click()
  await page.getByRole('menuitem', { name: 'Split off this name' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Split off' }).click()
  await expect(page.getByText(`Split off ${HEBREW}`)).toBeVisible()
  await page.goto('/library?scope=catalog')
  await expect(page.getByRole('combobox', { name: /^Author/ }).locator('option', { hasText: 'Brandon Sanderson' })).toHaveText('Brandon Sanderson')
  await expect(page.getByRole('combobox', { name: /^Author/ }).locator('option', { hasText: HEBREW })).toHaveText(HEBREW)

  // a new book crediting the Hebrew spelling lands on the split-off person
  await addBook(page, 'מיסטבורן (e2e)', HEBREW)
  await page.goto('/admin/authors')
  await page.getByLabel('Find a person').fill('סנדרסון')
  await expect(page.getByRole('region', { name: HEBREW }).getByText('Author of 2')).toBeVisible()
})
