import { expect, test, type Page } from '@playwright/test'

// Runs after library-series (file order, which counts kid's catalog) and before mark-as-read, as admin "parent".
// Adds two books, lends both to "Dana" (typed once as "dana "), and returns them, so later specs see no open loans.
const FIRST = 'Lent Book One'
const SECOND = 'Lent Book Two'

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Username')).toHaveCount(0)
}

async function addAndLend(page: Page, title: string, borrower: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Loan Writer')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await page.getByRole('button', { name: 'Lend it out' }).click()
  await page.getByRole('dialog').getByLabel("Borrower's name").fill(borrower)
  await page.getByRole('dialog').getByRole('button', { name: 'Lend' }).click()
  await expect(page.getByRole('button', { name: 'Mark returned' })).toBeVisible()
}

test('"Who has my books" groups open loans by borrower, is seen by every member, and takes a book back', async ({ page, browser }) => {
  await signIn(page, 'parent', 'parent password')
  await addAndLend(page, FIRST, 'Dana')
  await addAndLend(page, SECOND, 'dana ')

  // from the Library header
  await page.goto('/library')
  await page.getByRole('link', { name: 'Lent out' }).first().click()
  await expect(page).toHaveURL(/\/loans$/)
  await expect(page.getByRole('heading', { name: 'Who has my books', level: 1 })).toBeVisible()
  const dana = page.getByRole('region', { name: /^dana/i })
  await expect(dana.getByRole('listitem')).toHaveCount(2)
  await expect(dana.getByRole('link', { name: FIRST })).toBeVisible()

  // another member sees the same list; the old admin address lands here too
  const kidContext = await browser.newContext()
  const kid = await kidContext.newPage()
  await signIn(kid, 'kid', 'kid password')
  await kid.goto('/loans')
  await expect(kid.getByRole('region', { name: /^dana/i }).getByRole('listitem')).toHaveCount(2)
  await kidContext.close()
  await page.goto('/admin/loans')
  await expect(page).toHaveURL(/\/loans$/)

  // returned from the list
  await page.getByRole('button', { name: `Returned: ${FIRST}` }).click()
  await expect(dana.getByRole('listitem')).toHaveCount(1)
  await page.getByRole('button', { name: `Returned: ${SECOND}` }).click()
  await expect(page.getByText('Nothing is lent out')).toBeVisible()

  // and the book page agrees
  await page.getByRole('link', { name: 'Library', exact: true }).first().click()
  await page.getByLabel('Search books').fill(FIRST)
  await page.getByRole('link', { name: new RegExp(FIRST) }).first().click()
  await expect(page.getByRole('button', { name: 'Lend it out' })).toBeVisible()
})
