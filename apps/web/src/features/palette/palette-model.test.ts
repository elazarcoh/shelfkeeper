import { describe, expect, it } from 'vitest'
import type { WorkCard } from '@mylib/domain'
import { GROUP_CAP, libraryLink, matchLabel, paletteGroups, type PaletteSources } from './palette-model'

const NONE: PaletteSources = { books: undefined, authors: undefined, series: undefined, tags: undefined, sets: undefined, users: undefined, borrowers: undefined }

function card(id: string, title: string, authors: string[] = []): WorkCard {
  return { id, title, subtitle: null, kind: 'book', authors, series: null, formats: [], availability: 'owned', status: 'none', rating: null, inQueue: false, wishedBy: [], coverAssetId: null }
}

const ids = (groups: ReturnType<typeof paletteGroups>) => groups.map((g) => g.id)
const group = (groups: ReturnType<typeof paletteGroups>, id: string) => groups.find((g) => g.id === id)
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value')
  return value
}
const items = (groups: ReturnType<typeof paletteGroups>, id: string) => need(group(groups, id)).items
const first = (groups: ReturnType<typeof paletteGroups>, id: string) => need(items(groups, id)[0])

describe('matchLabel', () => {
  it('ranks a whole-label prefix 0 and a per-token prefix 1', () => {
    expect(matchLabel('lib', 'Library')).toBe(0)
    expect(matchLabel('stor', 'The Way of Kings', 'stormlight')).toBe(1)
    expect(matchLabel('ki wa', 'The Way of Kings')).toBe(1)
    expect(matchLabel('xyz', 'Library')).toBeNull()
  })
  it('needs every token to match', () => {
    expect(matchLabel('way zzz', 'The Way of Kings')).toBeNull()
  })
  it('ignores case, punctuation and niqqud', () => {
    expect(matchLabel('שָׁלוֹם', 'שלום עליכם')).toBe(0)
    expect(matchLabel('עליכם', 'שָׁלוֹם עֲלֵיכֶם')).toBe(1)
    expect(matchLabel("o'brien", 'Patrick OBrian Obrien')).toBe(1)
  })
  it('an empty query matches nothing', () => {
    expect(matchLabel('  ', 'Library')).toBeNull()
  })
})

describe('libraryLink', () => {
  it('builds a catalog-wide Library link per kind', () => {
    expect(libraryLink('author', 'a1')).toEqual({ scope: 'catalog', authorIds: ['a1'] })
    expect(libraryLink('series', 's1')).toEqual({ scope: 'catalog', seriesIds: ['s1'] })
    expect(libraryLink('tag', 't1')).toEqual({ scope: 'catalog', tagIds: ['t1'] })
    expect(libraryLink('set', 'x1')).toEqual({ scope: 'catalog', set: 'x1' })
  })
})

describe('paletteGroups', () => {
  it('with an empty query shows only Actions and Pages, in full', () => {
    const groups = paletteGroups('', { ...NONE, authors: [{ id: 'a', name: 'Anne' }], books: [card('w', 'Anne of Green Gables')] }, { isAdmin: false })
    expect(ids(groups)).toEqual(['actions', 'pages'])
    expect(items(groups, 'pages').length).toBeGreaterThan(GROUP_CAP)
  })

  it('orders groups Actions, Books, Pages, Authors, Series, Sets, Tags, People and drops empty ones', () => {
    const sources: PaletteSources = {
      books: [card('w1', 'Sea of Stars')],
      authors: [{ id: 'a1', name: 'Seanan McGuire' }],
      series: [{ id: 's1', name: 'Sea Trilogy' }],
      tags: [{ id: 't1', name: 'sea' }],
      sets: [{ id: 'x1', name: 'Seaside reads' }],
      users: undefined,
      borrowers: ['Sean'],
    }
    expect(ids(paletteGroups('sea', sources, { isAdmin: false }))).toEqual(['books', 'authors', 'series', 'sets', 'tags', 'people'])
    expect(ids(paletteGroups('check', NONE, { isAdmin: false }))).toEqual(['actions'])
  })

  it('keeps books in server order and does not filter them', () => {
    const groups = paletteGroups('twi', { ...NONE, books: [card('b', 'The Wise Man’s Fear'), card('a', 'Twilight')] }, { isAdmin: false })
    expect(items(groups, 'books').map((i) => i.id)).toEqual(['book:b', 'book:a'])
    expect(items(groups, 'books')[0]).toMatchObject({ label: 'The Wise Man’s Fear', target: { kind: 'book' } })
  })

  it('shows a book’s authors as its hint', () => {
    const groups = paletteGroups('x', { ...NONE, books: [card('b', 'X', ['Ann Leckie', 'Someone'])] }, { isAdmin: false })
    expect(first(groups, 'books').hint).toBe('Ann Leckie, Someone')
  })

  it('ranks whole-label prefixes first, then by label, and caps each group', () => {
    const authors = ['Zed Tolkien', 'Tolkien, J. R. R.', 'Christopher Tolkien', 'Ann Tolkien', 'Bo Tolkien', 'Cy Tolkien', 'Di Tolkien'].map((name, i) => ({ id: `a${i}`, name }))
    const authorItems = items(paletteGroups('tolk', { ...NONE, authors }, { isAdmin: false }), 'authors')
    expect(authorItems).toHaveLength(GROUP_CAP)
    expect(authorItems.map((i) => i.label)).toEqual(['Tolkien, J. R. R.', 'Ann Tolkien', 'Bo Tolkien', 'Christopher Tolkien', 'Cy Tolkien'])
    expect(need(authorItems[0]).target).toEqual({ kind: 'library', search: { scope: 'catalog', authorIds: ['a1'] } })
  })

  it('hides admin pages and household users from members', () => {
    const sources = { ...NONE, users: [{ id: 'u1', displayName: 'Admin Person', username: 'adm' }] }
    const member = paletteGroups('', sources, { isAdmin: false })
    expect(items(member, 'pages').map((i) => i.label)).not.toContain('Admin')
    expect(group(paletteGroups('backups', sources, { isAdmin: false }), 'pages')).toBeUndefined()
    expect(group(paletteGroups('adm', sources, { isAdmin: false }), 'people')).toBeUndefined()

    const admin = paletteGroups('adm', sources, { isAdmin: true })
    expect(items(admin, 'people')[0]).toMatchObject({ label: 'Admin Person', hint: '@adm', target: { kind: 'user', userId: 'u1' } })
    expect(first(paletteGroups('backups', sources, { isAdmin: true }), 'pages').target).toEqual({ kind: 'page', to: '/admin/backups' })
  })

  it('sends borrowers to the loans page', () => {
    expect(first(paletteGroups('dan', { ...NONE, borrowers: ['Dana'] }, { isAdmin: false }), 'people')).toMatchObject({ label: 'Dana', hint: 'Lent out', target: { kind: 'page', to: '/loans' } })
  })

  it('finds pages and actions by keyword', () => {
    expect(first(paletteGroups('who has', NONE, { isAdmin: false }), 'pages').target).toEqual({ kind: 'page', to: '/loans' })
    expect(first(paletteGroups('csv', NONE, { isAdmin: false }), 'actions').target).toEqual({ kind: 'page', to: '/books/import' })
    expect(first(paletteGroups('check', NONE, { isAdmin: false }), 'actions').target).toEqual({ kind: 'checkin' })
  })

  it('gives every item a unique id', () => {
    const sources: PaletteSources = {
      books: [card('same', 'Same')],
      authors: [{ id: 'same', name: 'Same' }],
      series: [{ id: 'same', name: 'Same' }],
      tags: [{ id: 'same', name: 'Same' }],
      sets: [{ id: 'same', name: 'Same' }],
      users: [{ id: 'same', displayName: 'Same', username: 'same' }],
      borrowers: ['Same'],
    }
    const all = paletteGroups('same', sources, { isAdmin: true }).flatMap((g) => g.items.map((i) => i.id))
    expect(new Set(all).size).toBe(all.length)
  })
})
