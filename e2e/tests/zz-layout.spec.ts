import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { formatOffenders, LONG_SPACED, LONG_UNBROKEN, measureLayout, settleAnimations, stressLongText, WIDTHS } from '../support/layout'

// Runs after household-library, progress-checkin, sources-inbox and z-csv-import (file order) and reuses their
// household: admin "parent", member "kid", The Final Empire, progress-checkin's "Progress Test Book" (in progress at
// page 150), the unresolved source item הארי פוטר ואבן החכמים and the CSV-created הנסיך הקטן. Runs before zzz-backups, so Admin → Backups still says "No backups yet".
// Guardrail for the mobile layout: no page may scroll sideways, and the end of every page must clear the
// phone bottom bar, at each width below.

// the phone widths that also get the long-text stress (each page's text replaced in place, after the normal check)
const STRESS_WIDTHS = [320, 390]
// one word with no break opportunities (no spaces, no hyphens): the classic way one row widens a phone page
const LONG_TITLE = 'Pneumonoultramicroscopicsilicovolcanoconiosisandanextraordinarilylongunbrokentitlewithnobreakopportunities'
const LONG_AUTHOR = 'Wolfeschlegelsteinhausenbergerdorffwelchevoralternwarengewissenhaftschaferswessenschafewarenwohlgepflegt'
const LONG_SERIES = 'Supercalifragilisticexpialidociousandanotherunbrokenseriesnamethatkeepsgoingwellpastthephoneedge'

type State = Awaited<ReturnType<BrowserContext['storageState']>>
let state: State | undefined
// a member this spec creates and never gives a book: the empty-library state
let emptyState: State | undefined
const urls = { finalEmpire: '', hebrew: '', longTitle: '', kid: '', progress: '', longSeries: '' }

async function signIn(page: Page, username = 'parent', password = 'parent password', name = 'Parent') {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Hi, ${name}` })).toBeVisible()
}

async function bookPath(page: Page, query: string, title: string): Promise<string> {
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(query)}`)
  await page.getByRole('link', { name: new RegExp(title) }).first().click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  return new URL(page.url()).pathname
}

async function addBook(page: Page, title: string, author: string, position: string) {
  await page.goto('/books/new')
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByLabel('Authors (one per line)').fill(author)
  await page.getByRole('button', { name: 'Add series' }).click()
  await page.getByLabel('Series name 1').fill(LONG_SERIES)
  await page.getByLabel('Series position 1').fill(position)
  await page.getByRole('button', { name: 'Add book', exact: true }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await signIn(page)
  // Playwright reruns beforeAll in a fresh worker after a failed test: add the books only once per run
  await page.goto(`/library?scope=catalog&q=${encodeURIComponent(LONG_TITLE)}`)
  await page.waitForLoadState('networkidle')
  if ((await longTitleLink(page).count()) > 0) {
    urls.longTitle = await bookPath(page, LONG_TITLE, LONG_TITLE)
  } else {
    // Add book requires only Title and one author (the edition's format defaults to physical, owned).
    // Two books in the long series, so the book page shows its series card too.
    await addBook(page, 'Layout series companion', 'Layout Tester', '2')
    await addBook(page, LONG_TITLE, LONG_AUTHOR, '1')
    urls.longTitle = new URL(page.url()).pathname
  }
  urls.finalEmpire = await bookPath(page, 'final empire', 'The Final Empire')
  urls.hebrew = await bookPath(page, 'הנסיך', 'הנסיך הקטן')
  urls.progress = await bookPath(page, 'Progress Test Book', 'Progress Test Book')
  // the long series opened from its card (collapsed by default): the series view
  await page.goto('/library?scope=catalog')
  await longSeriesCard(page).click()
  await expect(longTitleLink(page)).toBeVisible()
  urls.longSeries = new URL(page.url()).pathname + new URL(page.url()).search
  await page.goto('/admin')
  await expect(page.getByRole('link', { name: /Kid/ })).toBeVisible()
  if ((await page.getByRole('link', { name: /Empty Shelf/ }).count()) === 0) {
    await page.getByRole('button', { name: 'New person' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Username').fill('emptyshelf')
    await dialog.getByLabel('Display name').fill('Empty Shelf')
    await dialog.getByLabel('Password').fill('empty shelf password')
    await dialog.getByRole('button', { name: 'Create person' }).click()
    await expect(page.getByRole('link', { name: /Empty Shelf/ })).toBeVisible()
  }
  await page.getByRole('link', { name: /Kid/ }).click()
  await expect(page.getByLabel('Find a book to hide')).toBeVisible()
  urls.kid = new URL(page.url()).pathname
  state = await context.storageState()
  await context.close()

  const empty = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await signIn(await empty.newPage(), 'emptyshelf', 'empty shelf password', 'Empty Shelf')
  emptyState = await empty.storageState()
  await empty.close()
})

/** A context signed in as parent; below 1024px a touch screen, so (pointer: coarse) and the 44px rules apply. */
async function newContext(browser: Browser, size: { width: number; height: number }, touch = size.width < 1024) {
  expect(state).toBeDefined()
  return browser.newContext({ ...(state ? { storageState: state } : {}), viewport: size, hasTouch: touch })
}

async function expectCoarsePointer(page: Page) {
  expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true)
}

interface Stop {
  name: string
  path: () => string
  ready: (page: Page) => Locator
}

const finalEmpireLink = (p: Page) => p.getByRole('link', { name: /The Final Empire/ }).first()
const longTitleLink = (p: Page) => p.getByRole('link', { name: /Pneumono/ }).first()
// series are collapsed by default: The Final Empire shows as the Mistborn card, the long title as its long series' card
const mistbornCard = (p: Page) => p.getByRole('link', { name: /^Series: Mistborn/ }).first()
const longSeriesCard = (p: Page) => p.getByRole('link', { name: /^Series: Supercali/ }).first()
const adminHeading = (p: Page) => p.getByRole('heading', { name: 'Admin' })

const STOPS: Stop[] = [
  { name: 'home', path: () => '/', ready: (p) => p.getByRole('heading', { name: 'Hi, Parent' }) },
  { name: 'library series cards', path: () => '/library', ready: mistbornCard },
  { name: 'library series cards list', path: () => '/library?view=list', ready: mistbornCard },
  { name: 'library not collapsed', path: () => '/library?collapse=off', ready: finalEmpireLink },
  { name: 'whole catalog', path: () => '/library?scope=catalog', ready: longSeriesCard },
  { name: 'whole catalog list', path: () => '/library?scope=catalog&view=list', ready: longSeriesCard },
  { name: 'series view', path: () => urls.longSeries, ready: longTitleLink },
  { name: 'series view list', path: () => `${urls.longSeries}&view=list`, ready: longTitleLink },
  { name: 'sets', path: () => '/sets', ready: (p) => p.getByRole('switch').first() },
  { name: 'stats', path: () => '/stats', ready: (p) => p.getByText('Books finished') },
  { name: 'inbox', path: () => '/inbox', ready: (p) => p.getByRole('region', { name: 'הארי פוטר ואבן החכמים' }).first() },
  { name: 'account', path: () => '/account', ready: (p) => p.getByText('Signed in as @parent') },
  { name: 'add book', path: () => '/books/new', ready: (p) => p.getByLabel('Title', { exact: true }) },
  { name: 'csv import', path: () => '/books/import', ready: (p) => p.getByLabel('CSV file') },
  { name: 'book', path: () => urls.finalEmpire, ready: (p) => p.getByRole('heading', { name: 'The Final Empire' }) },
  { name: 'book in progress', path: () => urls.progress, ready: (p) => p.getByRole('button', { name: 'Update progress' }) },
  { name: 'hebrew book', path: () => urls.hebrew, ready: (p) => p.getByRole('heading', { name: 'הנסיך הקטן' }) },
  { name: 'long-title book', path: () => urls.longTitle, ready: (p) => p.getByRole('heading', { name: LONG_TITLE }) },
  { name: 'admin people', path: () => '/admin', ready: (p) => p.getByRole('link', { name: /Kid/ }) },
  { name: 'admin person', path: () => urls.kid, ready: (p) => p.getByLabel('Find a book to hide') },
  { name: 'admin sets', path: () => '/admin/sets', ready: adminHeading },
  { name: 'loans', path: () => '/loans', ready: (p) => p.getByRole('heading', { name: 'Who has my books', level: 1 }) },
  { name: 'admin sources', path: () => '/admin/sources', ready: (p) => p.getByText('Home ABS').first() },
  { name: 'admin jobs', path: () => '/admin/jobs', ready: (p) => p.getByText('Succeeded').first() },
  { name: 'admin backups', path: () => '/admin/backups', ready: (p) => p.getByText('No backups yet') },
  { name: 'admin system', path: () => '/admin/system', ready: (p) => p.getByText('App version') },
  { name: 'admin series', path: () => '/admin/series', ready: (p) => p.getByLabel('Find a series') },
  { name: 'admin health', path: () => '/admin/health', ready: (p) => p.getByLabel('Show ignored') },
]

async function settle(page: Page) {
  await page.waitForLoadState('networkidle')
  await settleAnimations(page)
}

for (const size of WIDTHS) {
  test(`every page fits ${size.width}px and ends clear of the bottom bar`, async ({ browser }) => {
    test.setTimeout(240_000)
    const context = await newContext(browser, size)
    const page = await context.newPage()
    for (const stop of STOPS) {
      await test.step(stop.name, async () => {
        await page.goto(stop.path())
        await expect(stop.ready(page)).toBeVisible()
        await settle(page)
        const r = await measureLayout(page)
        expect.soft(r.scrollWidth, `${stop.name} @${size.width}px scrolls sideways: ${r.offenders.join('; ')}`).toBeLessThanOrEqual(r.innerWidth)
        expect.soft(r.hiddenBehindNav, `${stop.name} @${size.width}px: the end of the page is under the bottom bar`).toBeLessThanOrEqual(1)
        if (STRESS_WIDTHS.includes(size.width)) {
          // long-text stress: every truncating / wrapping / dir="auto" element gets a 150-character string, first one
          // unbroken word, then a sentence; the page must still not scroll sideways (the demo data's short titles
          // once hid a timeline row that a long title widened to ~720px)
          for (const [kind, text] of [
            ['unbroken', LONG_UNBROKEN],
            ['spaced', LONG_SPACED],
          ] as const) {
            const s = await stressLongText(page, text)
            expect(s.stressed, `${stop.name}: nothing to stress`).toBeGreaterThan(0)
            expect
              .soft(s.scrollWidth, `${stop.name} @${size.width}px with ${kind} long text scrolls sideways:\n  ${formatOffenders(s)}`)
              .toBeLessThanOrEqual(s.innerWidth)
          }
        }
      })
    }
    await context.close()
  })
}

test('the empty personal library fits every width, with long text too', async ({ browser }) => {
  test.setTimeout(120_000)
  expect(emptyState).toBeDefined()
  for (const size of WIDTHS) {
    const context = await browser.newContext({ ...(emptyState ? { storageState: emptyState } : {}), viewport: size, hasTouch: size.width < 1024 })
    const page = await context.newPage()
    await page.goto('/library')
    await expect(page.getByText(/^The household catalog has \d+ books\.$/)).toBeVisible()
    await expect(page.getByRole('radio', { name: 'My library' })).toBeChecked()
    await settle(page)
    const r = await measureLayout(page)
    expect.soft(r.scrollWidth, `empty library @${size.width}px: ${r.offenders.join('; ')}`).toBeLessThanOrEqual(r.innerWidth)
    expect.soft(r.hiddenBehindNav, `empty library @${size.width}px: the end of the page is under the bottom bar`).toBeLessThanOrEqual(1)
    if (STRESS_WIDTHS.includes(size.width)) {
      for (const text of [LONG_UNBROKEN, LONG_SPACED]) {
        const s = await stressLongText(page, text)
        expect(s.stressed, 'empty library: nothing to stress').toBeGreaterThan(0)
        expect.soft(s.scrollWidth, `empty library @${size.width}px with long text:\n  ${formatOffenders(s)}`).toBeLessThanOrEqual(s.innerWidth)
      }
    }
    await context.close()
  }
})

test('the sign-in page fits every width', async ({ browser }) => {
  for (const size of WIDTHS) {
    const context = await browser.newContext({ viewport: size, hasTouch: size.width < 1024 })
    const page = await context.newPage()
    await page.goto('/login')
    await expect(page.getByLabel('Username')).toBeVisible()
    await settleAnimations(page)
    const r = await measureLayout(page)
    expect.soft(r.scrollWidth, `login @${size.width}px: ${r.offenders.join('; ')}`).toBeLessThanOrEqual(r.innerWidth)
    await context.close()
  }
})

async function expectOnScreen(locator: Locator, size: { width: number; height: number }) {
  await expect(locator).toBeVisible()
  // let the sheet finish sliding in; skip infinite animations, which never finish
  await locator.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  )
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  expect(box.x).toBeGreaterThanOrEqual(-1)
  expect(box.y).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1)
}

test('sheets keep their action button on a small phone, and open on their title', async ({ browser }) => {
  test.setTimeout(120_000)
  for (const size of [WIDTHS[0], WIDTHS[1]]) {
    if (!size) continue
    const context = await newContext(browser, size, true)
    const page = await context.newPage()

    await page.goto('/library')
    await expectCoarsePointer(page)
    await page.getByRole('button', { name: /^Filters/ }).click()
    const filters = page.getByRole('dialog', { name: 'Filters' })
    await expectOnScreen(filters, size)
    // on a touch screen a dialog opens on its title, so no keyboard pops up over the sheet
    await expect(filters.getByRole('heading', { name: 'Filters' })).toBeFocused()
    await expect(filters.getByLabel('Collapse series')).toBeVisible()
    await expectOnScreen(filters.getByRole('button', { name: /^(Show (\d+ )?books?|Done)$/ }), size)
    await page.keyboard.press('Escape')
    await expect(filters).toBeHidden()

    await page.goto(urls.finalEmpire)
    await page.getByRole('button', { name: 'Edit details' }).click()
    const edit = page.getByRole('dialog', { name: 'Edit book' })
    await expectOnScreen(edit, size)
    await expect(edit.getByRole('heading', { name: 'Edit book' })).toBeFocused()
    await expectOnScreen(edit.getByRole('button', { name: 'Save' }), size)

    // the suggestion list opens inside the dialog and fits the screen at this width
    const seriesName = edit.getByLabel('Series name 1')
    await seriesName.fill('Mist')
    const list = edit.getByRole('listbox')
    await expect(list).toBeVisible()
    await expectOnScreen(list, size)
    await seriesName.press('Escape')
    await expect(list).toBeHidden()
    await expect(edit).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(edit).toBeHidden()

    await page.goto(urls.progress)
    await page.getByRole('button', { name: 'Update progress' }).click()
    const progress = page.getByRole('dialog', { name: 'Update progress' })
    await expectOnScreen(progress, size)
    await expect(progress.getByRole('heading', { name: 'Update progress' })).toBeFocused()
    await expectOnScreen(progress.getByRole('button', { name: 'Save' }), size)
    await page.keyboard.press('Escape')
    await expect(progress).toBeHidden()

    // "Mark as read…" (closed without saving: the long-title book stays unread)
    await page.goto(urls.longTitle)
    await page.getByRole('button', { name: 'Mark as read…' }).click()
    const mark = page.getByRole('dialog', { name: 'When did you finish?' })
    await expectOnScreen(mark, size)
    await expect(mark.getByRole('heading', { name: 'When did you finish?' })).toBeFocused()
    await expectOnScreen(mark.getByRole('button', { name: 'Save' }), size)
    await page.keyboard.press('Escape')
    await expect(mark).toBeHidden()

    await context.close()
  }
})

test('the edit dialog with three titles, and its add-title sheet, fit a small phone, with long text too', async ({ browser }) => {
  test.setTimeout(120_000)
  for (const width of STRESS_WIDTHS) {
    const size = WIDTHS.find((w) => w.width === width) ?? { width, height: 800 }
    const context = await newContext(browser, size, true)
    const page = await context.newPage()
    // the long-title book is this spec's own throwaway; its extra titles are in languages parent never picks, so its
    // heading stays as other tests expect. A rerun (or the second width) finds them already there.
    await page.goto(urls.longTitle)
    await page.getByRole('button', { name: 'Edit details' }).click()
    const edit = page.getByRole('dialog', { name: 'Edit book' })
    const titles = edit.getByRole('region', { name: 'Titles in other languages' })
    await expect(titles).toBeVisible()
    for (const [code, text] of [
      ['fr', LONG_AUTHOR],
      ['ru', LONG_SERIES],
    ] as const) {
      if ((await titles.getByRole('button', { name: `Actions for ${text}` }).count()) > 0) continue
      await titles.getByRole('button', { name: 'Add a title in another language' }).click()
      const add = page.getByRole('dialog', { name: 'Add a title' })
      await add.getByLabel('Language', { exact: true }).selectOption('other')
      await add.getByLabel('Language code').fill(code)
      await add.getByLabel('Title', { exact: true }).fill(text)
      await add.getByLabel('Subtitle').fill(text)
      await expectOnScreen(add, size)
      await expectOnScreen(add.getByRole('button', { name: 'Save' }), size)
      await add.getByRole('button', { name: 'Save' }).click()
      await expect(add).toBeHidden()
      await expect(titles.getByRole('button', { name: `Actions for ${text}` })).toBeVisible()
    }
    await expect(titles.getByRole('listitem')).toHaveCount(3)
    await expectOnScreen(edit, size)
    await settle(page)
    const r = await measureLayout(page)
    expect.soft(r.scrollWidth, `edit book with three titles @${width}px: ${r.offenders.join('; ')}`).toBeLessThanOrEqual(r.innerWidth)
    for (const text of [LONG_UNBROKEN, LONG_SPACED]) {
      const s = await stressLongText(page, text)
      expect(s.stressed, 'edit book: nothing to stress').toBeGreaterThan(0)
      expect.soft(s.scrollWidth, `edit book with three titles @${width}px with long text:\n  ${formatOffenders(s)}`).toBeLessThanOrEqual(s.innerWidth)
    }
    await context.close()
  }
})

test('the Admin → Series merge dialog fits a small phone, both steps, with long text too', async ({ browser }) => {
  test.setTimeout(120_000)
  for (const width of STRESS_WIDTHS) {
    const size = WIDTHS.find((w) => w.width === width) ?? { width, height: 800 }
    const context = await newContext(browser, size, true)
    const page = await context.newPage()
    // opened and left without merging
    await page.goto('/admin/series')
    await page.getByLabel('Find a series').fill(LONG_SERIES)
    await page.getByRole('region', { name: LONG_SERIES }).getByRole('button', { name: 'Same series as…' }).click()
    const pick = page.getByRole('dialog', { name: 'Same series as…' })
    await expectOnScreen(pick, size)
    await pick.getByLabel('Find the other series').fill('Mistborn')
    await pick.getByRole('button', { name: 'Pick Mistborn' }).click()
    const review = page.getByRole('dialog', { name: 'Merge series' })
    await expect(review.getByRole('radiogroup', { name: 'Primary name' })).toBeVisible()
    await expectOnScreen(review, size)
    await expectOnScreen(review.getByRole('button', { name: 'Merge', exact: true }), size)
    await settle(page)
    const r = await measureLayout(page)
    expect.soft(r.scrollWidth, `merge series @${width}px: ${r.offenders.join('; ')}`).toBeLessThanOrEqual(r.innerWidth)
    for (const text of [LONG_UNBROKEN, LONG_SPACED]) {
      const s = await stressLongText(page, text)
      expect(s.stressed, 'merge series: nothing to stress').toBeGreaterThan(0)
      expect.soft(s.scrollWidth, `merge series @${width}px with long text:
  ${formatOffenders(s)}`).toBeLessThanOrEqual(s.innerWidth)
    }
    await context.close()
  }
})

test('the mark-as-read sheet fits a small phone with each picker, with long text too', async ({ browser }) => {
  for (const width of STRESS_WIDTHS) {
    const size = WIDTHS.find((w) => w.width === width) ?? { width, height: 800 }
    const context = await newContext(browser, size, true)
    const page = await context.newPage()
    // opened and left without saving, so the long-title book stays unread
    await page.goto(urls.longTitle)
    await page.getByRole('button', { name: 'Mark as read…' }).click()
    const sheet = page.getByRole('dialog', { name: 'When did you finish?' })
    await expect(sheet).toBeVisible()
    for (const [choice, picker] of [
      ['In a year…', 'Year'],
      ['In a month…', 'Month'],
      ['Exact date', 'Date'],
    ] as const) {
      await sheet.getByRole('button', { name: choice }).click()
      await expect(sheet.getByLabel(picker, { exact: true })).toBeVisible()
      await settle(page)
      const r = await measureLayout(page)
      expect.soft(r.scrollWidth, `mark-as-read "${choice}" @${width}px: ${r.offenders.join('; ')}`).toBeLessThanOrEqual(r.innerWidth)
      await expectOnScreen(sheet.getByRole('button', { name: 'Save' }), size)
    }
    // the longest refusal: an exact date left empty
    await sheet.getByLabel('Date', { exact: true }).fill('')
    await sheet.getByRole('button', { name: 'Save' }).click()
    await expect(sheet.getByText('Pick the day you finished')).toBeVisible()
    for (const text of [LONG_UNBROKEN, LONG_SPACED]) {
      const s = await stressLongText(page, text)
      expect(s.stressed, 'mark-as-read: nothing to stress').toBeGreaterThan(0)
      expect.soft(s.scrollWidth, `mark-as-read @${width}px with long text:\n  ${formatOffenders(s)}`).toBeLessThanOrEqual(s.innerWidth)
    }
    await context.close()
  }
})

test('the check-in card with its optional progress field fits a small phone, with long text too', async ({ browser }) => {
  for (const width of STRESS_WIDTHS) {
    const size = WIDTHS.find((w) => w.width === width) ?? { width, height: 800 }
    const context = await newContext(browser, size, true)
    const page = await context.newPage()
    // it opens the card and leaves without answering, so nothing is saved or dismissed; the check-in may already be
    // open (due today), or behind its button (dismissed today)
    await page.goto('/')
    const open = page.getByRole('button', { name: 'Check in' })
    const field = page.getByLabel('Page (optional)')
    await expect(open.or(field)).toBeVisible()
    if (await open.isVisible()) await open.click()
    await expect(field).toBeVisible()
    // a value lengthens the Still going label: it must take its own row, not widen the card (the book has 300 pages)
    await field.fill('300')
    await expect(page.getByRole('button', { name: 'Still going · p. 300' })).toBeVisible()
    await settle(page)
    const r = await measureLayout(page)
    expect.soft(r.scrollWidth, `check-in @${width}px: ${r.offenders.join('; ')}`).toBeLessThanOrEqual(r.innerWidth)
    // a page past the end is refused in the card (nothing is sent), with the longest message the field shows
    await field.fill('99999')
    await page.getByRole('button', { name: 'Still going', exact: true }).click()
    await expect(page.getByText('This edition has 300 pages. If yours has more, update the page count on the book page.')).toBeVisible()
    await settle(page)
    const refused = await measureLayout(page)
    expect.soft(refused.scrollWidth, `check-in refusal @${width}px: ${refused.offenders.join('; ')}`).toBeLessThanOrEqual(refused.innerWidth)
    for (const text of [LONG_UNBROKEN, LONG_SPACED]) {
      const s = await stressLongText(page, text)
      expect.soft(s.scrollWidth, `check-in @${width}px with long text:\n  ${formatOffenders(s)}`).toBeLessThanOrEqual(s.innerWidth)
    }
    await context.close()
  }
})

test('Back on a deep link with no history opens the tab’s main page', async ({ browser }) => {
  const context = await newContext(browser, WIDTHS[1] ?? { width: 390, height: 844 })
  const page = await context.newPage()
  // a shared or bookmarked book URL opened straight away: no in-app history to step back through
  await page.goto(urls.finalEmpire)
  await expect(page.getByRole('heading', { name: 'The Final Empire' })).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(/\/library$/)
  await expect(mistbornCard(page)).toBeVisible()
  await context.close()
})

/** Lets the focus, resize and visualViewport handlers run and React commit: two frames, then a task. */
async function afterFocusHandlers(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))
      }),
  )
}

test('the bottom bar steps aside only while a text field is focused and the keyboard is up', async ({ browser }) => {
  const tall = { width: 390, height: 844 }
  // headless Chromium has no on-screen keyboard: shrinking the viewport at the same width stands in for one
  const keyboardUp = { width: 390, height: 450 }
  const context = await newContext(browser, tall)
  const page = await context.newPage()
  const nav = page.locator('[data-slot="bottom-nav"]')

  await page.goto('/library')
  await expectCoarsePointer(page)
  await expect(mistbornCard(page)).toBeVisible()
  await expect(nav).toBeVisible()

  // focus alone (a hardware keyboard, no on-screen one) keeps the bar
  const search = page.getByLabel('Search books')
  await search.focus()
  await expect(search).toBeFocused()
  await afterFocusHandlers(page)
  await expect(nav).toBeVisible()
  // the keyboard comes up: the bar hides
  await page.setViewportSize(keyboardUp)
  await expect(nav).toBeHidden()
  // the keyboard goes away with the focus: the bar is back
  await search.blur()
  await page.setViewportSize(tall)
  await expect(nav).toBeVisible()

  // a select opens a picker, not a keyboard: the bar stays even if the viewport shrinks
  await page.goto(urls.finalEmpire)
  const status = page.getByLabel('Status')
  await status.focus()
  await page.setViewportSize(keyboardUp)
  await afterFocusHandlers(page)
  await expect(status).toBeFocused()
  await expect(nav).toBeVisible()
  await context.close()
})

// #10: iOS lays its keyboard over the page. The layout viewport (innerHeight) keeps its height, only the visual
// viewport shrinks, and iOS may pan it down by offsetTop. Headless Chromium has no such keyboard (resizing the page
// shrinks innerHeight too, the Android way), so a stand-in visualViewport plays iOS: window.__keyboard(height, pan).
test('a bottom sheet (phone) and a centred dialog (iPad) stay above an iOS-style keyboard, panned or not', async ({ browser }) => {
  // the phone's sheet sits on the keyboard; from sm (iPad) the dialog is centred in what the keyboard leaves (#9)
  const devices = [
    { size: { width: 390, height: 844 }, keyboardHeight: 336, pan: 120, sheet: true },
    { size: { width: 820, height: 1180 }, keyboardHeight: 400, pan: 100, sheet: false },
  ]
  for (const { size, keyboardHeight, pan, sheet: isSheet } of devices) {
    const context = await newContext(browser, size)
    await context.addInitScript(() => {
      const events = new EventTarget()
      const geometry: { height: number | null; offsetTop: number } = { height: null, offsetTop: 0 }
      const viewport = {
        get width() {
          return window.innerWidth
        },
        get height() {
          return geometry.height ?? window.innerHeight
        },
        get offsetTop() {
          return geometry.offsetTop
        },
        offsetLeft: 0,
        scale: 1,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      }
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport })
      Object.assign(window, {
        __keyboard: (height: number | null, offsetTop: number) => {
          geometry.height = height
          geometry.offsetTop = offsetTop
          events.dispatchEvent(new Event('resize'))
          events.dispatchEvent(new Event('scroll'))
        },
      })
    })
    const page = await context.newPage()
    const keyboard = (height: number | null, offsetTop = 0) =>
      page.evaluate(([h, top]) => (window as unknown as { __keyboard: (h: number | null, t: number) => void }).__keyboard(h, top), [height, offsetTop] as const)
    /** Every part must sit inside the visible band [top, bottom] of the layout viewport (1px rounding slack). */
    const expectInside = async (locators: Locator[], top: number, bottom: number) => {
      for (const l of locators) {
        await expect
          .poll(async () => {
            const box = await l.boundingBox()
            return box !== null && box.y >= top - 1 && box.y + box.height <= bottom + 1
          })
          .toBe(true)
      }
    }

    await page.goto('/sets')
    await expectCoarsePointer(page)
    await page.getByRole('button', { name: /^Actions for / }).first().click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const sheet = page.getByRole('dialog', { name: 'Rename set' })
    await expectOnScreen(sheet, size)
    const name = sheet.getByLabel('Set name')
    await name.click()
    await expect(name).toBeFocused()
    const parts = [sheet, sheet.getByRole('heading', { name: 'Rename set' }), name, sheet.getByRole('button', { name: 'Save' })]

    /** How far the dialog's middle is from `y`, in px (expected within 1: rounding) */
    const offMiddle = (y: number) => async () => {
      const box = await sheet.boundingBox()
      return box === null ? Infinity : Math.abs(box.y + box.height / 2 - y)
    }

    // the keyboard comes up over the bottom of the screen
    await keyboard(size.height - keyboardHeight)
    await expectInside(parts, 0, size.height - keyboardHeight)
    if (!isSheet) await expect.poll(offMiddle((size.height - keyboardHeight) / 2)).toBeLessThanOrEqual(1)
    // iOS pans the page up to keep the field in view: the visible band moves down the layout viewport
    await keyboard(size.height - keyboardHeight, pan)
    await expectInside(parts, pan, size.height - keyboardHeight + pan)
    if (!isSheet) await expect.poll(offMiddle(pan + (size.height - keyboardHeight) / 2)).toBeLessThanOrEqual(1)
    // the keyboard goes away: the sheet sits on the bottom edge again, the dialog in the middle
    await keyboard(null)
    if (isSheet) await expect.poll(async () => Math.round(((await sheet.boundingBox())?.y ?? 0) + ((await sheet.boundingBox())?.height ?? 0))).toBe(size.height)
    else await expect.poll(offMiddle(size.height / 2)).toBeLessThanOrEqual(1)
    await context.close()
  }
})


// #9: a removal that fails leaves its row, so focus goes back to the row's control (not on to the next row), and the
// error toast sits below the phone top bar, not over its Back and ＋
test('a failed removal gives focus back to its row, and the toast clears the top bar', async ({ browser }) => {
  const context = await newContext(browser, WIDTHS[1] ?? { width: 390, height: 844 })
  const page = await context.newPage()
  await page.goto(urls.finalEmpire)
  const add = page.getByRole('button', { name: 'Add to Up next' })
  const queued = page.getByRole('button', { name: 'Remove from Up next' })
  await expect(add.or(queued)).toBeVisible()
  const addedHere = await add.isVisible()
  if (addedHere) {
    await add.click()
    await expect(queued).toBeVisible()
  }

  await page.goto('/')
  const upNext = page.getByRole('region', { name: 'Up next' })
  await page.route(/\/trpc\/[^?]*tracking\.queueRemove/, (route) => route.abort())
  const menu = upNext.getByRole('button', { name: 'Actions for The Final Empire' })
  await menu.click()
  await page.getByRole('menuitem', { name: 'Remove from Up next' }).click()
  const toast = page.locator('[data-sonner-toast]').first()
  await expect(toast).toBeVisible()
  await expect(upNext.getByRole('link', { name: /The Final Empire/ })).toBeVisible()
  await expect(menu).toBeFocused()
  await expect
    .poll(async () => ((await toast.boundingBox())?.y ?? 0) - ((await page.locator('header').first().boundingBox())?.height ?? Infinity))
    .toBeGreaterThanOrEqual(0)
  await page.unroute(/\/trpc\/[^?]*tracking\.queueRemove/)

  if (addedHere) {
    await page.goto(urls.finalEmpire)
    await queued.click()
    await expect(add).toBeVisible()
  }
  await context.close()
})

// #12: below lg the header's book count scrolls away, so the sticky search row carries it too
test('the Library’s book count rides along in the sticky search row on a phone', async ({ browser }) => {
  for (const width of STRESS_WIDTHS) {
    const size = WIDTHS.find((w) => w.width === width) ?? { width, height: 800 }
    const context = await newContext(browser, size)
    const page = await context.newPage()
    await page.goto('/library?scope=catalog&view=list')
    const bar = page.locator('[data-sticky-bar]')
    const count = bar.getByText(/^\d+ books?$/)
    await expect(count).toBeVisible()
    // the header says the same number
    await expect(page.getByText(await count.innerText(), { exact: true })).toHaveCount(2)
    await expect(page.getByLabel('Search books')).toHaveAccessibleDescription(/^\d+ books?$/)
    // a short screen, so the list scrolls the header (and its count) away; the bar's count stays
    await page.setViewportSize({ width, height: 420 })
    const headerCount = page.locator('main').getByText(await count.innerText(), { exact: true }).and(page.locator(':not([data-sticky-bar] *)'))
    await page.mouse.wheel(0, 10_000)
    await expect(headerCount).not.toBeInViewport()
    await expect(count).toBeInViewport()
    if (width === 390) await page.screenshot({ path: test.info().outputPath('library-sticky-count.png') })
    await context.close()
  }
})

test('a touch double-tap on a star gives the half star', async ({ browser }) => {
  // the long-title book is this spec's own throwaway, so its rating is free to change
  const context = await newContext(browser, WIDTHS[1] ?? { width: 390, height: 844 })
  const page = await context.newPage()
  await page.goto(urls.longTitle)
  await expectCoarsePointer(page)
  const star = page.getByRole('button', { name: 'Rate 3 stars' })
  await star.tap()
  await expect(page.getByRole('group', { name: 'Rated 3 of 5' })).toBeVisible()
  await star.tap()
  await expect(page.getByRole('group', { name: 'Rated 2.5 of 5' })).toBeVisible()
  // leave it as it was
  await page.getByRole('button', { name: 'Clear rating' }).tap()
  await expect(page.getByRole('group', { name: 'Not rated' })).toBeVisible()
  await context.close()
})

test('removing from Up next moves focus to the next row, then to the heading, never to the top of the page', async ({ browser }) => {
  // this spec's two throwaway books, queued last (companion, then the long title); the test leaves them unqueued
  const context = await newContext(browser, WIDTHS[1] ?? { width: 390, height: 844 })
  const page = await context.newPage()
  const companion = await bookPath(page, 'Layout series companion', 'Layout series companion')
  for (const path of [companion, urls.longTitle]) {
    await page.goto(path)
    const add = page.getByRole('button', { name: 'Add to Up next' })
    const queued = page.getByRole('button', { name: 'Remove from Up next' })
    await expect(add.or(queued)).toBeVisible()
    // already queued (a rerun): take it out first, so it goes back in at the end
    if (await queued.isVisible()) await queued.click()
    await add.click()
    await expect(queued).toBeVisible()
  }

  await page.goto('/')
  const upNext = page.getByRole('region', { name: 'Up next' })
  // phone: the row's ⋯ menu; focus goes to the next row's ⋯, not back to this row's (which is about to go)
  await upNext.getByRole('button', { name: 'Actions for Layout series companion' }).click()
  await page.getByRole('menuitem', { name: 'Remove from Up next' }).click()
  await expect(upNext.getByRole('link', { name: /Layout series companion/ })).toBeHidden()
  await expect(upNext.getByRole('button', { name: `Actions for ${LONG_TITLE}` })).toBeFocused()

  // from sm: the row's ✕; the last row's lands on the section heading
  await page.setViewportSize({ width: 1280, height: 800 })
  await upNext.getByRole('button', { name: `Remove ${LONG_TITLE} from Up next` }).click()
  await expect(upNext.getByRole('link', { name: /Pneumono/ })).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Up next', exact: true })).toBeFocused()
  await context.close()
})
