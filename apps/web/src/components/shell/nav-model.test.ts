import { describe, expect, it, vi } from 'vitest'
import { backFallback, goBack, inboxBadge, inboxLabel, isRootPath, tabForPath, TABS, titleForPath } from './nav-model'

const BOOK = '/books/0f8fad5b-d9cb-469f-a165-70867728950e'

describe('TABS', () => {
  it('is exactly the five phone tabs, in order', () => {
    expect(TABS.map((t) => t.label)).toEqual(['Home', 'Library', 'Stats', 'Inbox', 'Me'])
    expect(TABS.map((t) => t.to)).toEqual(['/', '/library', '/stats', '/inbox', '/account'])
  })
})

describe('tabForPath', () => {
  it.each([
    ['/', 'home'],
    ['/library', 'library'],
    ['/library/', 'library'],
    ['/sets', 'library'],
    ['/wishlist', 'library'],
    ['/loans', 'library'],
    ['/next', 'home'],
    [BOOK, 'library'],
    // adding a book is the top bar's ＋, open from every tab: no tab lights up (#9)
    ['/books/new', null],
    ['/books/import', null],
    ['/stats', 'stats'],
    ['/inbox', 'inbox'],
    ['/account', 'me'],
    ['/admin', 'me'],
    ['/admin/users/0f8fad5b-d9cb-469f-a165-70867728950e', 'me'],
  ])('%s belongs to the %s tab', (path, tab) => {
    expect(tabForPath(path)).toBe(tab)
  })

  it('does not treat a shared prefix as a parent', () => {
    expect(tabForPath('/libraryx')).toBeNull()
    expect(tabForPath('/statistics')).toBeNull()
  })

  it('has no tab outside the app shell', () => {
    expect(tabForPath('/login')).toBeNull()
  })
})

describe('isRootPath', () => {
  it('is true only for the five tab roots', () => {
    for (const p of ['/', '/library', '/library/', '/stats', '/inbox', '/account']) expect(isRootPath(p)).toBe(true)
    for (const p of ['/sets', '/books/new', BOOK, '/admin', '/admin/sets']) expect(isRootPath(p)).toBe(false)
  })
})

describe('titleForPath', () => {
  it.each([
    ['/', 'My Library'],
    ['/library', 'Library'],
    ['/sets', 'Sets'],
    ['/books/new', 'Add a book'],
    ['/wishlist', 'Wishlist'],
    ['/loans', 'Who has my books'],
    ['/next', 'What next?'],
    ['/books/import', 'Import a CSV file'],
    [BOOK, 'Book'],
    ['/stats', 'Stats'],
    ['/inbox', 'Inbox'],
    ['/account', 'Account'],
    ['/admin/backups', 'Admin'],
    ['/somewhere-else', 'My Library'],
  ])('%s → %s', (path, title) => {
    expect(titleForPath(path)).toBe(title)
  })
})

describe('backFallback', () => {
  it("goes to the tab's root when there is no history to go back to", () => {
    expect(backFallback(BOOK)).toBe('/library')
    expect(backFallback('/sets')).toBe('/library')
    expect(backFallback('/wishlist')).toBe('/library')
    expect(backFallback('/books/new')).toBe('/library')
    expect(backFallback('/books/import')).toBe('/library')
    expect(backFallback('/admin/sets')).toBe('/account')
    expect(backFallback('/somewhere-else')).toBe('/')
  })
})

describe('goBack (the top bar Back button)', () => {
  it("opens the tab's main page on a deep link with no in-app history, never leaving the app", () => {
    const back = vi.fn()
    const navigate = vi.fn()
    goBack({ pathname: BOOK, canGoBack: false, back, navigate })
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/library')
    expect(back).not.toHaveBeenCalled()
  })

  it('steps back through history when there is some', () => {
    const back = vi.fn()
    const navigate = vi.fn()
    goBack({ pathname: BOOK, canGoBack: true, back, navigate })
    expect(back).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('sends an admin deep link to Me', () => {
    const navigate = vi.fn()
    goBack({ pathname: '/admin/sets', canGoBack: false, back: vi.fn(), navigate })
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/account')
  })
})

describe('inbox count', () => {
  it('labels the tab for screen readers', () => {
    expect(inboxLabel(undefined)).toBe('Inbox')
    expect(inboxLabel(0)).toBe('Inbox')
    expect(inboxLabel(1)).toBe('Inbox, 1 waiting')
    expect(inboxLabel(6)).toBe('Inbox, 6 waiting')
  })

  it('caps the badge at 99+', () => {
    expect(inboxBadge(undefined)).toBeNull()
    expect(inboxBadge(0)).toBeNull()
    expect(inboxBadge(1)).toBe('1')
    expect(inboxBadge(99)).toBe('99')
    expect(inboxBadge(100)).toBe('99+')
  })
})
