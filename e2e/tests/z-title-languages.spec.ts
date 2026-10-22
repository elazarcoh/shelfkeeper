import { expect, test, type Page } from '@playwright/test'

// after z-inbox-details (file order); uses the admin "parent" only. The spec changes parent's title order and puts it
// back to "English first, then Hebrew" when it ends, so later specs (zz-layout, ...) see the default.

const ENGLISH_FIRST = 'English first, then Hebrew'
const HEBREW_FIRST = 'Hebrew first, then English'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function setOrder(page: Page, label: string) {
  await page.goto('/account')
  await page.getByLabel('Titles and names').selectOption({ label })
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Titles and names')).toHaveValue(label === ENGLISH_FIRST ? 'en,he' : 'he,en')
}

test('a book shows in the person’s title language order, search matches every title, an edition keeps its printed title (#145)', async ({ page }) => {
  // a CI retry finds the first attempt's book, so each attempt makes its own
  test.setTimeout(150_000)
  const n = test.info().retry
  const hebrew = ['קצב המלחמה', 'קצב השלום', 'קצב הקרב'][n] ?? `קצב ${n}`
  const english = ['Rhythm of War', 'Rhythm of Peace', 'Rhythm of Battle'][n] ?? `Rhythm of ${n}`
  const printed = `${english} (GraphicAudio)`

  try {
    await signIn(page)
    await setOrder(page, ENGLISH_FIRST)

    // a Hebrew book, then its English title in the edit dialog
    await page.goto('/books/new')
    await page.getByLabel('Title', { exact: true }).fill(hebrew)
    await page.getByLabel('Authors (one per line)').fill('Brandon Sanderson')
    await page.getByLabel('Format').selectOption('physical')
    await page.getByLabel('Edition language').fill('he')
    await page.getByRole('button', { name: 'Add book', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: hebrew })).toBeVisible()

    await page.getByRole('button', { name: 'Edit details' }).click()
    const edit = page.getByRole('dialog', { name: 'Edit book' })
    await edit.getByRole('button', { name: 'Add a title in another language' }).click()
    const add = page.getByRole('dialog', { name: 'Add a title' })
    await add.getByLabel('Language', { exact: true }).selectOption('en')
    await add.getByLabel('Title', { exact: true }).fill(english)
    await add.getByRole('button', { name: 'Save' }).click()
    await expect(add).toBeHidden()
    await expect(edit.getByRole('button', { name: `Actions for ${english}` })).toBeVisible()
    await expect(edit.getByRole('button', { name: `Actions for ${hebrew}` })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(edit).toBeHidden()
    // English first: the book page and the Library card say the English title
    await expect(page.getByRole('heading', { level: 1, name: english })).toBeVisible()

    const search = page.getByLabel('Search books')
    const card = (title: string) => page.getByRole('link', { name: new RegExp(title) }).first()
    const find = async (query: string, title: string) => {
      await page.goto(`/library?scope=catalog&q=${encodeURIComponent(query)}`)
      await expect(search).toHaveValue(query)
      await expect(card(title)).toBeVisible()
    }
    await find(english, english)
    await expect(page.getByRole('link', { name: new RegExp(hebrew) })).toHaveCount(0)
    // search matches every title, whichever language is shown
    await find(hebrew, english)

    // Hebrew first: the same card says the Hebrew title, and both searches still find it
    await setOrder(page, HEBREW_FIRST)
    await find(english.toLowerCase(), hebrew)
    await find(hebrew, hebrew)
    await expect(page.getByRole('link', { name: new RegExp(english) })).toHaveCount(0)

    // an English edition with its own printed title: its row shows it (the header says the book's title)
    await setOrder(page, ENGLISH_FIRST)
    await find(english, english)
    await card(english).click()
    await expect(page.getByRole('heading', { level: 1, name: english })).toBeVisible()
    await page.getByRole('button', { name: 'Add edition' }).click()
    const addEdition = page.getByRole('dialog', { name: 'Add an edition' })
    await addEdition.getByLabel('Format').selectOption('ebook')
    await addEdition.getByLabel('Edition language').fill('en')
    await addEdition.getByLabel('Edition language').press('Tab')
    await addEdition.getByRole('button', { name: 'Add edition' }).click()
    await expect(addEdition).toBeHidden()

    const ebook = page.locator('[data-slot="card"]').filter({ hasText: 'Ebook' }).filter({ has: page.locator('[data-edition-edit]') })
    await ebook.locator('[data-edition-edit]').click()
    const editEdition = page.getByRole('dialog', { name: 'Edit edition' })
    await editEdition.getByLabel('Edition title').fill(printed)
    await editEdition.getByRole('button', { name: 'Save' }).click()
    await expect(editEdition).toBeHidden()
    await expect(page.getByText(printed, { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: english })).toBeVisible()
  } finally {
    // later specs expect the default order
    await setOrder(page, ENGLISH_FIRST)
  }
})
