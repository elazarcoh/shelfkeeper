import { describe, expect, it } from 'vitest'
import { formatSeriesHint, seriesPositionHint } from './series-hint'

const e = (id: string, position: number | null) => ({ id, position })

describe('seriesPositionHint', () => {
  it('lists the taken positions in order and the next whole number', () => {
    expect(seriesPositionHint([e('a', 2), e('b', 1), e('c', 4)], undefined)).toEqual({ taken: [1, 2, 4], next: 5 })
    expect(seriesPositionHint([e('a', 2.5)], undefined)).toEqual({ taken: [2.5], next: 3 })
  })

  it('leaves out the book being edited, entries without a position and repeats', () => {
    expect(seriesPositionHint([e('me', 3), e('a', 1), e('b', null), e('c', 1)], 'me')).toEqual({ taken: [1], next: 2 })
  })

  it('a range takes its whole numbers; next is past its end (#122)', () => {
    expect(seriesPositionHint([{ id: 'p', position: 1, positionEnd: 2 }, e('c', 4)], undefined)).toEqual({ taken: [1, 2, 4], next: 5 })
    expect(seriesPositionHint([{ id: 'p', position: 1, positionEnd: 2 }], undefined)).toEqual({ taken: [1, 2], next: 3 })
  })

  it('is null when nothing else has a position', () => {
    expect(seriesPositionHint([e('me', 1), e('b', null)], 'me')).toBeNull()
    expect(seriesPositionHint([], undefined)).toBeNull()
  })
})

describe('formatSeriesHint', () => {
  it('names the positions and the next one', () => {
    expect(formatSeriesHint({ taken: [1, 2, 4], next: 5 })).toBe('In this series: #1, #2, #4 — next #5')
  })

  it('shortens a long series to its first and last three', () => {
    expect(formatSeriesHint({ taken: [1, 2, 3, 4, 5, 6, 7, 8, 9], next: 10 })).toBe('In this series: #1, #2, #3, …, #7, #8, #9 — next #10')
  })
})
