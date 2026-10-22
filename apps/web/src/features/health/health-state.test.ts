import { describe, expect, it } from 'vitest'
import type { HealthCounts } from '@mylib/domain'
import { checkLabel, defaultCheck, itemDetail, missingText, parseHealthSearch } from './health-state'

const zero: HealthCounts = { no_cover: 0, no_isbn: 0, no_author: 0, no_length: 0, duplicates: 0, empty_series: 0, series_gaps: 0, long_loans: 0, kind_suggestions: 0, abs_out_of_sync: 0 }

describe('health page state', () => {
  it('opens on the first check that has problems, else the first check', () => {
    expect(defaultCheck(undefined)).toBe('no_cover')
    expect(defaultCheck(zero)).toBe('no_cover')
    expect(defaultCheck({ ...zero, duplicates: 3, long_loans: 1 })).toBe('duplicates')
    expect(defaultCheck({ ...zero, abs_out_of_sync: 2 })).toBe('abs_out_of_sync')
  })

  it('keeps only a known check from the URL', () => {
    expect(parseHealthSearch({ check: 'series_gaps' })).toEqual({ check: 'series_gaps' })
    expect(parseHealthSearch({ check: 'abs_out_of_sync' })).toEqual({ check: 'abs_out_of_sync' })
    expect(parseHealthSearch({ check: 'bogus' })).toEqual({})
    expect(parseHealthSearch({})).toEqual({})
  })

  it('shows at most ten missing numbers', () => {
    expect(missingText([3])).toBe('Missing #3')
    expect(missingText([3, 5])).toBe('Missing #3, #5')
    expect(missingText(Array.from({ length: 12 }, (_, i) => i + 1))).toBe('Missing #1, #2, #3, #4, #5, #6, #7, #8, #9, #10 and 2 more')
  })

  it('describes each kind of row', () => {
    const work = { id: 'w', title: 'T' }
    expect(itemDetail({ check: 'no_isbn', key: 'w', work })).toBe('No ISBN on a printed or ebook copy')
    expect(itemDetail({ check: 'no_length', key: 'e', work, edition: { id: 'e', format: 'audiobook', volume: null } })).toBe('Audiobook: no duration')
    expect(itemDetail({ check: 'no_length', key: 'e', work, edition: { id: 'e', format: 'physical', volume: 2 } })).toBe('Physical, volume 2: no page count')
    expect(itemDetail({ check: 'long_loans', key: 'l', work, loan: { id: 'l', borrower: 'Dana', lentOn: '2026-09-01', dueOn: '2026-10-17' } })).toBeNull()
    expect(itemDetail({ check: 'kind_suggestions', key: 'w', work, suggested: 'fanfiction' })).toBe('Looks like fanfiction')
    expect(itemDetail({ check: 'kind_suggestions', key: 'w', work, suggested: 'web_serial' })).toBe('Looks like a web serial')
    expect(checkLabel.series_gaps).toBe('Series gaps')
  })

  it('a gap row says when some books have no number (#123)', () => {
    const series = { id: 's', name: 'S' }
    expect(itemDetail({ check: 'series_gaps', key: 's', series, missing: [3], unnumbered: 0 })).toBe('Missing #3')
    expect(itemDetail({ check: 'series_gaps', key: 's', series, missing: [1, 2], unnumbered: 1 })).toBe('Missing #1, #2 · 1 book has no number')
    expect(itemDetail({ check: 'series_gaps', key: 's', series, missing: [1, 2], unnumbered: 2 })).toBe('Missing #1, #2 · 2 books have no number')
  })
})
