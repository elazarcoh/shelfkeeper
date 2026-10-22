import { availabilities, workKindLabel, type Availability, type LibrarySort, type WorkKind } from '@mylib/domain'
import { availabilityLabel, formatLabel, statusLabel } from '@/lib/format'
import type { LibrarySearch } from './library-search'

export const sorts: { value: LibrarySort; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'author', label: 'Author' },
  { value: 'added', label: 'Recently added' },
  { value: 'rating', label: 'My rating' },
  // inside a series its order (#1, #2, …); otherwise by series, then position
  { value: 'series', label: 'Series order' },
]

export const holdingOptions: { value: string; label: string; availability: Availability[] | undefined }[] = [
  { value: '', label: 'Any', availability: undefined },
  { value: 'now', label: 'Only books I have now', availability: ['owned', 'borrowed'] },
  ...availabilities.map((a) => ({ value: a, label: availabilityLabel[a], availability: [a] })),
]

export const kindOptions: { value: string; label: string; kinds: WorkKind[] | undefined }[] = [
  { value: '', label: 'Any', kinds: undefined },
  { value: 'fanfiction', label: 'Fanfiction', kinds: ['fanfiction'] },
  { value: 'web_serial', label: 'Web serial', kinds: ['web_serial'] },
  { value: 'book', label: 'Books only', kinds: ['book'] },
  { value: 'hide_fanfiction', label: 'Hide fanfiction', kinds: ['book', 'web_serial'] },
]

export function hasFacets(s: LibrarySearch): boolean {
  const lists = [s.availability, s.formats, s.statuses, s.authorIds, s.seriesIds, s.tagIds, s.kinds]
  return lists.some((l) => (l?.length ?? 0) > 0) || s.minRating !== undefined
}

/**
 * Filters the user can clear (each has a chip). The one difference from hasFacets: a single series is a series view,
 * shown as its own pill with its own way back, so on its own it has no chip and offers no "Clear filters".
 */
export function hasRemovableFilters(s: LibrarySearch): boolean {
  return hasFacets(s.seriesIds?.length === 1 ? { ...s, seriesIds: undefined } : s)
}

/** "Clear filters": every facet, except the series of a series view (its pill's Back leaves it). */
export function clearFilters(s: LibrarySearch): Partial<LibrarySearch> {
  return s.seriesIds?.length === 1 ? { ...CLEAR_FACETS, seriesIds: s.seriesIds } : CLEAR_FACETS
}

export const CLEAR_FACETS: Partial<LibrarySearch> = {
  availability: undefined,
  formats: undefined,
  statuses: undefined,
  minRating: undefined,
  authorIds: undefined,
  seriesIds: undefined,
  tagIds: undefined,
  kinds: undefined,
}

interface Named {
  id: string
  name: string
}
export interface FacetNames {
  authors: readonly Named[]
  series: readonly Named[]
  tags: readonly Named[]
}
export interface FilterChip {
  key: string
  label: string
  remove: Partial<LibrarySearch>
}

function without<T>(list: readonly T[] | undefined, item: T): T[] | undefined {
  const rest = (list ?? []).filter((x) => x !== item)
  return rest.length > 0 ? rest : undefined
}

/**
 * One removable chip per active facet, in the order the filter fields show them. A single series is a series view:
 * its pill (with the way back) stands for it, so it has no chip.
 */
export function activeFilterChips(s: LibrarySearch, names: FacetNames | undefined): FilterChip[] {
  const chips: FilterChip[] = []
  if (s.availability !== undefined && s.availability.length > 0) {
    const option = holdingOptions.find((o) => JSON.stringify(o.availability) === JSON.stringify(s.availability))
    chips.push({ key: 'availability', label: option?.label ?? s.availability.map((a) => availabilityLabel[a]).join(' or '), remove: { availability: undefined } })
  }
  if (s.kinds !== undefined && s.kinds.length > 0) {
    const option = kindOptions.find((o) => JSON.stringify(o.kinds) === JSON.stringify(s.kinds))
    chips.push({ key: 'kind', label: option?.label ?? s.kinds.map((k) => workKindLabel[k]).join(' or '), remove: { kinds: undefined } })
  }
  for (const f of s.formats ?? []) chips.push({ key: `format:${f}`, label: formatLabel[f], remove: { formats: without(s.formats, f) } })
  for (const st of s.statuses ?? []) chips.push({ key: `status:${st}`, label: statusLabel[st], remove: { statuses: without(s.statuses, st) } })
  if (s.minRating !== undefined) chips.push({ key: 'rating', label: s.minRating === 5 ? '5 stars' : `${s.minRating}+ stars`, remove: { minRating: undefined } })
  for (const id of s.authorIds ?? []) chips.push({ key: `author:${id}`, label: names?.authors.find((a) => a.id === id)?.name ?? 'Author', remove: { authorIds: without(s.authorIds, id) } })
  const seriesView = s.seriesIds?.length === 1
  for (const id of seriesView ? [] : (s.seriesIds ?? [])) chips.push({ key: `series:${id}`, label: names?.series.find((x) => x.id === id)?.name ?? 'Series', remove: { seriesIds: without(s.seriesIds, id) } })
  for (const id of s.tagIds ?? []) chips.push({ key: `tag:${id}`, label: names?.tags.find((x) => x.id === id)?.name ?? 'Tag', remove: { tagIds: without(s.tagIds, id) } })
  return chips
}
