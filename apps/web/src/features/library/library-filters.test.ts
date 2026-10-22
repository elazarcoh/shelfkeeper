import { describe, expect, it } from 'vitest'
import { formatLabel, statusLabel } from '@/lib/format'
import { activeFilterChips, CLEAR_FACETS, clearFilters, hasFacets, hasRemovableFilters } from './library-filters'

const AUTHOR = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SERIES = '16fd2706-8baf-433b-82eb-8c7fada847da'
const TAG = '886313e1-3b8a-4372-9b90-0c9aee199e5d'
const names = { authors: [{ id: AUTHOR, name: 'אורה אהרוני' }], series: [{ id: SERIES, name: 'Mistborn' }], tags: [] }

describe('activeFilterChips', () => {
  it('is empty without filters, and the search box, scope, set, sort and view are not filters', () => {
    expect(activeFilterChips({}, names)).toEqual([])
    expect(activeFilterChips({ q: 'empire', scope: 'catalog', sort: 'added', view: 'list' }, names)).toEqual([])
  })

  it('gives one chip per format, and removing one keeps the others', () => {
    const chips = activeFilterChips({ formats: ['ebook', 'audiobook'] }, names)
    expect(chips.map((c) => c.label)).toEqual([formatLabel.ebook, formatLabel.audiobook])
    expect(chips[0]?.remove).toEqual({ formats: ['audiobook'] })
    expect(activeFilterChips({ formats: ['ebook'] }, names)[0]?.remove).toEqual({ formats: undefined })
  })

  it('names the copy filter after its menu option', () => {
    expect(activeFilterChips({ availability: ['owned', 'borrowed'] }, names)[0]?.label).toBe('Only books I have now')
  })

  it('names the kind filter after its menu option, any other combination by its labels', () => {
    const label = (kinds: ('book' | 'fanfiction' | 'web_serial')[]) => activeFilterChips({ kinds }, names)[0]?.label
    expect(label(['fanfiction'])).toBe('Fanfiction')
    expect(label(['web_serial'])).toBe('Web serial')
    expect(label(['book'])).toBe('Books only')
    expect(label(['book', 'web_serial'])).toBe('Hide fanfiction')
    expect(label(['fanfiction', 'web_serial'])).toBe('Fanfiction or Web serial')
    expect(activeFilterChips({ kinds: ['book'] }, names)[0]?.remove).toEqual({ kinds: undefined })
    expect(hasFacets({ kinds: ['book'] })).toBe(true)
  })

  it('labels status and rating', () => {
    expect(activeFilterChips({ statuses: ['reading'] }, names)[0]?.label).toBe(statusLabel.reading)
    expect(activeFilterChips({ minRating: 4 }, names)[0]?.label).toBe('4+ stars')
    expect(activeFilterChips({ minRating: 5 }, names)[0]?.label).toBe('5 stars')
  })

  it('names authors, series and tags from the facets, with a fallback while they load', () => {
    expect(activeFilterChips({ authorIds: [AUTHOR] }, names)[0]?.label).toBe('אורה אהרוני')
    expect(activeFilterChips({ seriesIds: [SERIES, TAG] }, names)[0]?.label).toBe('Mistborn')
    expect(activeFilterChips({ tagIds: [TAG] }, names)[0]?.label).toBe('Tag')
    expect(activeFilterChips({ authorIds: [AUTHOR] }, undefined)[0]?.label).toBe('Author')
  })

  it('gives a single series (a series view, shown as its own pill) no chip', () => {
    expect(activeFilterChips({ seriesIds: [SERIES] }, names)).toEqual([])
    expect(activeFilterChips({ seriesIds: [SERIES], formats: ['ebook'] }, names).map((c) => c.key)).toEqual(['format:ebook'])
  })

  it('offers "Clear filters" exactly when there are chips to clear', () => {
    for (const s of [{}, { formats: ['ebook' as const] }, { minRating: 3 }, { q: 'x' }, { seriesIds: [SERIES, TAG] }, { seriesIds: [SERIES] }, { seriesIds: [SERIES], minRating: 3 }]) {
      expect(activeFilterChips(s, names).length > 0, JSON.stringify(s)).toBe(hasRemovableFilters(s))
    }
  })

  it('counts a single series as a filter (it can be saved as a smart set), the one case with no chip', () => {
    // the deliberate exception: the series view's pill stands for it, and "Clear filters" does not show for it alone
    expect(hasFacets({ seriesIds: [SERIES] })).toBe(true)
    expect(hasRemovableFilters({ seriesIds: [SERIES] })).toBe(false)
    for (const s of [{}, { formats: ['ebook' as const] }, { minRating: 3 }, { q: 'x' }, { seriesIds: [SERIES, TAG] }]) {
      expect(hasRemovableFilters(s)).toBe(hasFacets(s))
    }
  })

  it('clearing keeps the series of a series view, and clears everything elsewhere', () => {
    expect(clearFilters({ seriesIds: [SERIES], minRating: 3 })).toEqual({ ...CLEAR_FACETS, seriesIds: [SERIES] })
    expect(clearFilters({ seriesIds: [SERIES, TAG], minRating: 3 })).toEqual(CLEAR_FACETS)
  })

  it('CLEAR_FACETS removes every facet', () => {
    expect(hasFacets({ formats: ['ebook'], minRating: 3, tagIds: [TAG], kinds: ['book'], ...CLEAR_FACETS })).toBe(false)
  })
})
