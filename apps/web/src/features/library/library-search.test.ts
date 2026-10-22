import { describe, expect, it } from 'vitest'
import {
  collapseSeriesOn,
  effectiveSort,
  isPersonalLibraryEmpty,
  leaveSeries,
  entryKey,
  PAGE_SIZE,
  parseLibrarySearch,
  readCollapsePreference,
  seriesSearch,
  seriesViewId,
  toLibraryQuery,
  writeCollapsePreference,
} from './library-search'

const SET = '6f1f0a7e-3d4b-4b8e-9d7c-2a1b3c4d5e6f'
const SERIES = '16fd2706-8baf-433b-82eb-8c7fada847da'
const OTHER = '886313e1-3b8a-4372-9b90-0c9aee199e5d'

describe('library search params', () => {
  it('drops invalid params instead of failing the page', () => {
    expect(parseLibrarySearch({ formats: ['vinyl'] })).toEqual({})
    expect(parseLibrarySearch({ collapse: 'maybe' })).toEqual({})
    // an old link from the paged Library still opens it (from the top)
    expect(parseLibrarySearch({ q: 'dune', page: 2 })).toEqual({ q: 'dune' })
  })
  it('defaults to the personal library, collapsed as the device prefers', () => {
    expect(toLibraryQuery({}, true)).toEqual({
      scope: 'library',
      setId: null,
      seriesId: null,
      filter: null,
      search: '',
      sort: 'title',
      collapseSeries: true,
      limit: PAGE_SIZE,
    })
    expect(toLibraryQuery({}, false).collapseSeries).toBe(false)
  })
  it('browses a set across the catalog', () => {
    expect(toLibraryQuery({ set: SET, scope: 'library' }, true)).toMatchObject({ scope: 'catalog', setId: SET })
  })
  it('filters by what I have now', () => {
    expect(toLibraryQuery({ availability: ['owned', 'borrowed'] }, true).filter).toEqual({ op: 'availability', values: ['owned', 'borrowed'] })
  })
  it('turns facets into a filter', () => {
    expect(toLibraryQuery({ formats: ['audiobook'], minRating: 4 }, true)).toMatchObject({
      filter: { op: 'and', nodes: [{ op: 'format', formats: ['audiobook'] }, { op: 'rating', min: 4, max: 5 }] },
    })
  })
})

describe('collapse series', () => {
  it('follows the URL when it says, else the device', () => {
    expect(collapseSeriesOn({}, true)).toBe(true)
    expect(collapseSeriesOn({}, false)).toBe(false)
    expect(collapseSeriesOn({ collapse: 'off' }, true)).toBe(false)
    expect(collapseSeriesOn({ collapse: 'on' }, false)).toBe(true)
  })
  it('is off while there is search text, and inside a series', () => {
    expect(toLibraryQuery({ q: 'discworld' }, true).collapseSeries).toBe(false)
    expect(toLibraryQuery({ q: '   ' }, true).collapseSeries).toBe(true)
    expect(toLibraryQuery({ seriesIds: [SERIES] }, true).collapseSeries).toBe(false)
    // two series picked is a filter, not a series view: it still collapses
    expect(toLibraryQuery({ seriesIds: [SERIES, OTHER] }, true).collapseSeries).toBe(true)
  })
  it('remembers the device preference, on by default, and survives storage that throws', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect(readCollapsePreference(storage)).toBe(true)
    writeCollapsePreference(false, storage)
    expect(readCollapsePreference(storage)).toBe(false)
    writeCollapsePreference(true, storage)
    expect(readCollapsePreference(storage)).toBe(true)
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readCollapsePreference(broken)).toBe(true)
    expect(() => writeCollapsePreference(false, broken)).not.toThrow()
    expect(readCollapsePreference(undefined)).toBe(true)
  })
})

describe('series view', () => {
  it('is one series picked', () => {
    expect(seriesViewId({ seriesIds: [SERIES] })).toBe(SERIES)
    expect(seriesViewId({})).toBeUndefined()
    expect(seriesViewId({ seriesIds: [SERIES, OTHER] })).toBeUndefined()
  })
  it('sorts by series order unless a sort was picked', () => {
    expect(effectiveSort({ seriesIds: [SERIES] })).toBe('series')
    expect(effectiveSort({ seriesIds: [SERIES], sort: 'added' })).toBe('added')
    expect(effectiveSort({})).toBe('title')
    expect(toLibraryQuery({ seriesIds: [SERIES] }, true)).toMatchObject({ seriesId: SERIES, sort: 'series' })
  })
  it('opens from a series card in its order, remembering the sort it came from, keeping the scope, view and other filters', () => {
    expect(seriesSearch({ scope: 'catalog', view: 'list', sort: 'added', formats: ['ebook'] }, SERIES)).toEqual({
      scope: 'catalog',
      view: 'list',
      formats: ['ebook'],
      seriesIds: [SERIES],
      sort: undefined,
      outerSort: 'added',
      entry: 'card',
    })
    expect(seriesSearch({}, SERIES)).toMatchObject({ outerSort: undefined, entry: 'card' })
  })
  it('leaves by going back in history when a card opened it and there is somewhere to go back to', () => {
    expect(leaveSeries({ seriesIds: [SERIES], entry: 'card', outerSort: 'added' }, true)).toEqual({ kind: 'back' })
  })
  it('otherwise leaves with a new entry that restores the sort it came from', () => {
    // a card's view opened straight from a link: nothing to go back to
    expect(leaveSeries({ seriesIds: [SERIES], entry: 'card', outerSort: 'added' }, false)).toEqual({
      kind: 'push',
      search: { seriesIds: undefined, entry: undefined, outerSort: undefined, sort: 'added' },
    })
    // picked in Filters: the series order goes, a sort picked inside it stays
    expect(leaveSeries({ seriesIds: [SERIES], sort: 'series' }, true)).toEqual({
      kind: 'push',
      search: { seriesIds: undefined, entry: undefined, outerSort: undefined, sort: undefined },
    })
    expect(leaveSeries({ seriesIds: [SERIES], sort: 'author' }, true)).toMatchObject({ search: { sort: 'author' } })
  })
  it('keeps the remembered sort out of the query', () => {
    expect(toLibraryQuery({ seriesIds: [SERIES], outerSort: 'added', entry: 'card' }, true).sort).toBe('series')
  })
})

describe('entry key', () => {
  it('tells a book from a series with the same id', () => {
    const work = { kind: 'work', work: { id: SERIES } } as Parameters<typeof entryKey>[0]
    const series = { kind: 'series', series: { id: SERIES } } as Parameters<typeof entryKey>[0]
    expect(entryKey(work)).not.toBe(entryKey(series))
  })
})

describe('empty personal library', () => {
  it('is my library with no books at all, not one with no matches', () => {
    expect(isPersonalLibraryEmpty({}, 0)).toBe(true)
    expect(isPersonalLibraryEmpty({}, 3)).toBe(false)
    expect(isPersonalLibraryEmpty({}, undefined)).toBe(false)
    expect(isPersonalLibraryEmpty({ q: 'dune' }, 0)).toBe(false)
    expect(isPersonalLibraryEmpty({ formats: ['ebook'] }, 0)).toBe(false)
    expect(isPersonalLibraryEmpty({ scope: 'catalog' }, 0)).toBe(false)
    expect(isPersonalLibraryEmpty({ set: SET }, 0)).toBe(false)
  })
})
