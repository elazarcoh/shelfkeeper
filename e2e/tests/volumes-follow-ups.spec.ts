// e2e/tests/volumes-follow-ups.spec.ts
import { expect, test, type Page } from '@playwright/test'

// Runs after household-library (file order) as its admin "parent".
const TITLE = 'כרכים עם תאריכים'

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** How the list names a day within the last week. */
function weekday(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] ?? ''
}

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

test('a finished volume keeps its day, and an update can say which volume it belongs to', async ({ page }) => {
  await signIn(page)

  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(TITLE)
  await page.getByLabel('Authors (one per line)').fill('Volume Reader')
  await page.getByLabel('Format').selectOption('physical')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).last().click()
  const edit = page.getByRole('dialog', { name: 'Edit edition' })
  await edit.getByLabel('Edition language').fill('he')
  await edit.getByLabel('Volume', { exact: true }).fill('1')
  await edit.getByLabel('Of', { exact: true }).fill('2')
  await edit.getByLabel('Pages').fill('400')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit).toBeHidden()

  await page.getByRole('button', { name: 'Add edition' }).click()
  const add = page.getByRole('dialog', { name: 'Add an edition' })
  await add.getByLabel('Format').selectOption('physical')
  await add.getByLabel('Edition language').fill('he')
  await add.getByLabel('Volume', { exact: true }).fill('2')
  await add.getByLabel('Pages').fill('600')
  await add.getByRole('button', { name: 'Add edition' }).click()
  await expect(add).toBeHidden()
  await expect(page.getByText('Vol 2 of 2', { exact: true })).toBeVisible()

  // started three days ago, so earlier days can be picked
  await page.getByRole('button', { name: 'Started earlier?' }).click()
  await page.getByLabel('Exact date').fill(daysAgo(3))
  await page.getByRole('button', { name: 'Start reading' }).click()
  await expect(page.getByRole('button', { name: 'Update progress' })).toBeVisible()

  // #70: the end of volume 1 is yesterday
  await page.getByRole('button', { name: 'Finished volume 1' }).click()
  await page.getByRole('button', { name: 'Yesterday' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('On to volume 2')).toBeVisible()

  const updates = page.getByRole('list', { name: 'Progress updates' })

  // today: page 10 of volume 2
  await page.getByRole('button', { name: 'Update progress' }).click()
  const today = page.getByRole('dialog', { name: 'Update progress' })
  await today.getByLabel('Page', { exact: true }).fill('10')
  await today.getByRole('button', { name: 'Save' }).click()
  await expect(today).toBeHidden()
  await expect(updates.getByText('p. 10')).toBeVisible()

  // #69: two days ago, on volume 1
  await page.getByRole('button', { name: 'Update progress' }).click()
  const earlier = page.getByRole('dialog', { name: 'Update progress' })
  await earlier.getByLabel('Date').fill(daysAgo(2))
  const vol1 = await earlier.getByLabel('Volume').locator('option', { hasText: /Vol 1/ }).getAttribute('value')
  await earlier.getByLabel('Volume').selectOption(vol1)
  await earlier.getByLabel('Page', { exact: true }).fill('50')
  await earlier.getByRole('button', { name: 'Save' }).click()
  await expect(earlier).toBeHidden()

  // #68: newest first: vol 2 today, vol 1's end yesterday, vol 1's point before it
  const items = updates.getByRole('listitem')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toContainText('today')
  await expect(items.nth(0)).toContainText('Vol 2')
  await expect(items.nth(1)).toContainText(weekday(1))
  await expect(items.nth(1)).toContainText('Vol 1')
  await expect(items.nth(2)).toContainText(weekday(2))
  await expect(items.nth(2)).toContainText('Vol 1')
  await expect(items.nth(2)).toContainText('p. 50')

  // clean up: an in-progress read with an update today would take the first check-in card in zz-layout
  await page.getByRole('button', { name: 'More actions for this book' }).click()
  await page.getByRole('menuitem', { name: 'Delete book…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete book' }).click()
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(TITLE)}`)
  await expect(page.getByRole('link', { name: new RegExp(TITLE) })).toHaveCount(0)
})
