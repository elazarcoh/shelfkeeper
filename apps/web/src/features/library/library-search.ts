import { z } from 'zod'
import { Availability, EditionFormat, LibraryQuery, LibrarySort, type LibraryEntry, RatingValue, ReadingStatus, WorkKind, filterFromFacets } from '@mylib/domain'
import { hasFacets } from './library-filters'

/** Cards per load as the Library scrolls. */
export const PAGE_SIZE = 48

/** A card's identity across loads: a book, or a collapsed series. */
export const entryKey = (e: LibraryEntry): string => (e.kind === 'work' ? e.work.id : `series:${e.series.id}`)

export const LibrarySearch = z.object({
  q: z.string().max(200).optional(),
  scope: z.enum(['library', 'catalog']).optional(),
  set: z.uuid().optional(),
  availability: z.array(Availability).optional(),
  formats: z.array(EditionFormat).optional(),
  statuses: z.array(ReadingStatus).optional(),
  minRating: RatingValue.optional(),
  authorIds: z.array(z.uuid()).optional(),
  seriesIds: z.array(z.uuid()).optional(),
  tagIds: z.array(z.uuid()).optional(),
  kinds: z.array(WorkKind).optional(),
  sort: LibrarySort.optional(),
  view: z.enum(['grid', 'list']).optional(),
  /** collapse series: absent = this device's preference */
  collapse: z.enum(['on', 'off']).optional(),
  /** a series view opened from its card (a pushed entry): its Back can go back in history */
  entry: z.enum(['card']).optional(),
  /** in a series view, the sort the Library had before it (restored on leaving) */
  outerSort: LibrarySort.optional(),
})
export type LibrarySearch = z.infer<typeof LibrarySearch>

export function parseLibrarySearch(raw: Record<string, unknown>): LibrarySearch {
  const result = LibrarySearch.safeParse(raw)
  return result.success ? result.data : {}
}

/** A series view: exactly one series picked (from a series card, or the Series filter). */
export function seriesViewId(s: LibrarySearch): string | undefined {
  return s.seriesIds?.length === 1 ? s.seriesIds[0] : undefined
}

/** Inside a series its own order, #1 first, unless a sort was picked. */
export function effectiveSort(s: LibrarySearch): LibrarySort {
  return s.sort ?? (seriesViewId(s) !== undefined ? 'series' : 'title')
}

/** The Collapse series switch as shown: the URL when it says, else this device's preference. */
export function collapseSeriesOn(s: LibrarySearch, devicePreference: boolean): boolean {
  return s.collapse === undefined ? devicePreference : s.collapse === 'on'
}

/** The query for the first load; infinite scroll asks for the next ones from a cursor (the offset). */
export function toLibraryQuery(s: LibrarySearch, devicePreference: boolean): z.input<typeof LibraryQuery> {
  const search = s.q ?? ''
  const seriesId = seriesViewId(s) ?? null
  return {
    scope: s.set !== undefined ? 'catalog' : (s.scope ?? 'library'),
    setId: s.set ?? null,
    seriesId,
    filter: filterFromFacets(s),
    search,
    sort: effectiveSort(s),
    // search text shows matching books one by one; inside a series, collapsing would leave one card
    collapseSeries: collapseSeriesOn(s, devicePreference) && search.trim() === '' && seriesId === null,
    limit: PAGE_SIZE,
  }
}

/**
 * A series card's link: that series in its order, keeping the scope, set, view and other filters, and remembering
 * the sort it came from and that a card opened it.
 */
export function seriesSearch(s: LibrarySearch, seriesId: string): LibrarySearch {
  return { ...s, seriesIds: [seriesId], sort: undefined, outerSort: s.sort === 'series' ? undefined : s.sort, entry: 'card' }
}

export type LeaveSeries = { kind: 'back' } | { kind: 'push'; search: Partial<LibrarySearch> }

/**
 * The series pill's Back. Opened from a card (a pushed entry) with somewhere to go back to: history back, so no
 * extra entry is left behind and the Library returns exactly as it was. Otherwise (picked in Filters, or a shared
 * link): a new entry without the series, restoring the sort it came from (or keeping one picked inside it).
 */
export function leaveSeries(s: LibrarySearch, canGoBack: boolean): LeaveSeries {
  if (s.entry === 'card' && canGoBack) return { kind: 'back' }
  return {
    kind: 'push',
    search: { seriesIds: undefined, entry: undefined, outerSort: undefined, sort: s.outerSort ?? (s.sort === 'series' ? undefined : s.sort) },
  }
}

/** Pages, not books: the cards on a page are books and series, so "1–48 of 120" would read against "300 books". */
export function pageLabel(page: number, total: number, pageSize: number): string {
  return `Page ${page + 1} of ${Math.max(1, Math.ceil(total / pageSize))}`
}

/** My library with no books at all (not "no matches"): `books` is the unfiltered count, undefined while it loads. */
export function isPersonalLibraryEmpty(s: LibrarySearch, books: number | undefined): boolean {
  const unfiltered = (s.scope ?? 'library') === 'library' && s.set === undefined && (s.q ?? '').trim() === '' && !hasFacets(s)
  return unfiltered && books === 0
}

const COLLAPSE_KEY = 'mylib.library.collapseSeries'

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

function deviceStorage(): PreferenceStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** On unless this device turned it off; storage that is missing or throws (private mode, blocked) reads as on. */
export function readCollapsePreference(storage: PreferenceStorage | undefined = deviceStorage()): boolean {
  try {
    return storage?.getItem(COLLAPSE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeCollapsePreference(on: boolean, storage: PreferenceStorage | undefined = deviceStorage()): void {
  try {
    storage?.setItem(COLLAPSE_KEY, on ? 'on' : 'off')
  } catch {
    // a per-device convenience: the URL still carries the choice
  }
}
