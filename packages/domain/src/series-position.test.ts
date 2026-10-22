import { describe, expect, it } from 'vitest'
import { coveredPositions, formatSeriesPosition, parseSeriesPosition } from './series-position'

describe('parseSeriesPosition', () => {
  it('reads a number, a decimal and nothing', () => {
    expect(parseSeriesPosition('3')).toEqual({ position: 3, positionEnd: null })
    expect(parseSeriesPosition(' 2.5 ')).toEqual({ position: 2.5, positionEnd: null })
    expect(parseSeriesPosition('2,5')).toEqual({ position: 2.5, positionEnd: null })
    expect(parseSeriesPosition('')).toEqual({ position: null, positionEnd: null })
    expect(parseSeriesPosition('  ')).toEqual({ position: null, positionEnd: null })
  })
  it('reads a range with any dash, with or without spaces', () => {
    for (const text of ['1-2', '1–2', '1—2', '1 - 2', ' 1 –2 ']) expect(parseSeriesPosition(text)).toEqual({ position: 1, positionEnd: 2 })
    expect(parseSeriesPosition('1.5-3')).toEqual({ position: 1.5, positionEnd: 3 })
  })
  it('is null for unreadable text and for a range that does not go up', () => {
    for (const text of ['x', '1-x', '-', '1-', '-2', '2-1', '1-1', '1-2-3']) expect(parseSeriesPosition(text)).toBeNull()
  })
})

describe('formatSeriesPosition', () => {
  it('gives nothing, a number or an en-dash range', () => {
    expect(formatSeriesPosition(null, null)).toBe('')
    expect(formatSeriesPosition(3, null)).toBe('3')
    expect(formatSeriesPosition(2.5, null)).toBe('2.5')
    expect(formatSeriesPosition(1, 2)).toBe('1–2')
  })
})

describe('coveredPositions', () => {
  it('a single position covers itself; a range its ends and the whole numbers between', () => {
    expect(coveredPositions(null, null)).toEqual([])
    expect(coveredPositions(3, null)).toEqual([3])
    expect(coveredPositions(2.5, null)).toEqual([2.5])
    expect(coveredPositions(1, 3)).toEqual([1, 2, 3])
    expect(coveredPositions(1.5, 3)).toEqual([1.5, 2, 3])
    expect(coveredPositions(1, 2.5)).toEqual([1, 2, 2.5])
  })
})
