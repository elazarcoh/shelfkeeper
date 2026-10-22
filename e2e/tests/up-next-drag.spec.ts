import { expect, test, type Locator, type Page } from '@playwright/test'

// #11: Up next reorders by dragging a row's handle, with the mouse or the keyboard. Runs after household-library
// (the admin "parent"); queues three books of its own and takes them out again at the end.
const BOOKS = ['Drag Order A', 'Drag Order B', 'Drag Order C']

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('parent')
  await page.getByRole('textbox', { name: 'Password' }).fill('parent password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hi, Parent' })).toBeVisible()
}

async function addAndQueue(page: Page, title: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill('Drag Tester')
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await page.getByRole('button', { name: 'Add to Up next' }).click()
  await expect(page.getByRole('button', { name: 'Remove from Up next' })).toBeVisible()
}

/** This spec's books in the order Up next shows them. */
async function order(upNext: Locator): Promise<string[]> {
  const titles = await upNext.getByRole('listitem').getByRole('link').allInnerTexts()
  return titles.map((t) => BOOKS.find((b) => t.includes(b))).filter((b) => b !== undefined)
}

async function dragHandle(page: Page, handle: Locator, onto: Locator) {
  // both ends on screen (Up next sits below the fold): mouse coordinates are the viewport's
  await onto.scrollIntoViewIfNeeded()
  await handle.scrollIntoViewIfNeeded()
  const from = await handle.boundingBox()
  const to = await onto.boundingBox()
  if (!from || !to) throw new Error('no box to drag between')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  // in steps, so the sensor sees a drag start (past its 4px threshold) and the rows make way
  await page.mouse.move(from.x + from.width / 2, to.y + to.height / 4, { steps: 12 })
  await page.mouse.up()
}

test('Up next reorders by dragging a handle, with the mouse or the keyboard, and the order sticks', async ({ page }) => {
  await signIn(page)
  for (const title of BOOKS) await addAndQueue(page, title)

  await page.goto('/')
  const upNext = page.getByRole('region', { name: 'Up next' })
  await expect.poll(() => order(upNext)).toEqual(BOOKS)

  // mouse: C's handle onto A's row puts C first
  await dragHandle(page, upNext.getByRole('button', { name: 'Reorder Drag Order C' }), upNext.getByRole('listitem').filter({ hasText: 'Drag Order A' }))
  await expect.poll(() => order(upNext)).toEqual(['Drag Order C', 'Drag Order A', 'Drag Order B'])
  await page.reload()
  await expect.poll(() => order(upNext)).toEqual(['Drag Order C', 'Drag Order A', 'Drag Order B'])

  // keyboard: Space picks C up, ↓ moves it one down, Space drops it; focus stays on its handle
  const handleC = upNext.getByRole('button', { name: 'Reorder Drag Order C' })
  await handleC.focus()
  // each step waits for the drag to take it in before the next key: picked up (aria-pressed), then what a screen
  // reader hears (dnd-kit's live region, which keeps only the latest announcement)
  const live = page.getByRole('status').filter({ hasText: 'Drag Order C' })
  // C's place in the whole list (earlier specs may have queued books above this spec's)
  const cAt = (await upNext.getByRole('listitem').allInnerTexts()).findIndex((t) => t.includes('Drag Order C')) + 1
  await page.keyboard.press('Space')
  await expect(handleC).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(live).toHaveText(new RegExp(`^Drag Order C is over position ${String(cAt + 1)} of \\d+\\.$`))
  await page.keyboard.press('Space')
  await expect(live).toHaveText(new RegExp(`^Drag Order C dropped at position ${String(cAt + 1)} of \\d+\\.$`))
  await expect.poll(() => order(upNext)).toEqual(['Drag Order A', 'Drag Order C', 'Drag Order B'])
  await expect(handleC).toBeFocused()
  await page.reload()
  await expect.poll(() => order(upNext)).toEqual(['Drag Order A', 'Drag Order C', 'Drag Order B'])

  // a small phone: the handle, the ⋯ and the title share the row without crowding
  await page.setViewportSize({ width: 320, height: 568 })
  await upNext.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('up-next-320.png') })
  await page.setViewportSize({ width: 1280, height: 720 })

  // leave Up next as this spec found it
  for (const title of BOOKS) {
    await upNext.getByRole('button', { name: `Remove ${title} from Up next` }).click()
    await expect(upNext.getByRole('link', { name: new RegExp(title) })).toHaveCount(0)
  }
})
