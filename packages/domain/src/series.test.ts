import { describe, expect, it } from 'vitest'
import { firstUnreadInSeries, nextInSeries, replaceSeriesInFilter, type SeriesEntry } from './series'

describe('nextInSeries', () => {
  const entries: SeriesEntry[] = [
    { workId: 'a', position: 1, status: 'read' },
    { workId: 'b', position: 2, status: 'reading' },
    { workId: 'c', position: 3, status: 'none' },
    { workId: 'd', position: null, status: 'none' },
  ]

  it('finds the first not-yet-read entry after the current one', () => {
    expect(nextInSeries(entries, 'a')).toBe('b')
    expect(nextInSeries(entries, 'b')).toBe('c')
  })
  it('returns null past the end of the series', () => {
    expect(nextInSeries(entries, 'd')).toBeNull()
  })
  it('returns null, not throws, for a single-entry or already-finished series', () => {
    expect(nextInSeries([{ workId: 'a', position: 1, status: 'read' }], 'a')).toBeNull()
    expect(nextInSeries([], 'missing')).toBeNull()
  })
})

describe('firstUnreadInSeries', () => {
  it('finds the first not-yet-read entry in position order, with no pivot needed', () => {
    const entries: SeriesEntry[] = [
      { workId: 'a', position: 1, status: 'read' },
      { workId: 'b', position: 2, status: 'none' },
      { workId: 'c', position: 3, status: 'none' },
    ]
    expect(firstUnreadInSeries(entries)).toBe('b')
  })
  it('skips an entry that is currently being read', () => {
    const entries: SeriesEntry[] = [
      { workId: 'a', position: 1, status: 'reading' },
      { workId: 'b', position: 2, status: 'none' },
    ]
    expect(firstUnreadInSeries(entries)).toBe('b')
  })
  it('returns null, not throws, when everything is read or the series is empty', () => {
    expect(firstUnreadInSeries([{ workId: 'a', position: 1, status: 'read' }])).toBeNull()
    expect(firstUnreadInSeries([])).toBeNull()
  })
})

describe('replaceSeriesInFilter', () => {
  const A = '00000000-0000-4000-8000-00000000000a'
  const B = '00000000-0000-4000-8000-00000000000b'
  const C = '00000000-0000-4000-8000-00000000000c'
  it('rewrites series ids anywhere in the tree, without duplicates', () => {
    expect(
      replaceSeriesInFilter(
        {
          op: 'and',
          nodes: [
            { op: 'series', seriesIds: [A, B] },
            { op: 'not', node: { op: 'series', seriesIds: [A] } },
            { op: 'or', nodes: [{ op: 'format', formats: ['ebook'] }, { op: 'series', seriesIds: [C] }] },
          ],
        },
        A,
        B,
      ),
    ).toEqual({
      op: 'and',
      nodes: [
        { op: 'series', seriesIds: [B] },
        { op: 'not', node: { op: 'series', seriesIds: [B] } },
        { op: 'or', nodes: [{ op: 'format', formats: ['ebook'] }, { op: 'series', seriesIds: [C] }] },
      ],
    })
  })
})
