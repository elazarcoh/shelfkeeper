import { describe, expect, it } from 'vitest'
import { dayAllowed, recentYears, undatedFinishNote, yearOf } from './date-options'

describe('recentYears', () => {
  it('lists this year back through the last 60, newest first', () => {
    const years = recentYears('2026-10-07')
    expect(years).toHaveLength(60)
    expect(years[0]).toBe(2026)
    expect(years.at(-1)).toBe(1967)
  })
  it('takes another count', () => {
    expect(recentYears('2026-01-01', 3)).toEqual([2026, 2025, 2024])
  })
  it('stops at the year of a minimum date (a finish never before its start)', () => {
    expect(recentYears('2026-10-07', 60, '2024-03-01')).toEqual([2026, 2025, 2024])
    expect(recentYears('2026-10-07', 60, '2026-10-01')).toEqual([2026])
  })
})

describe('undatedFinishNote', () => {
  it('says the read counts but stays out of dated stats, in the words of its mode', () => {
    expect(undatedFinishNote('read')).toBe('It counts as read, but not in any year’s stats or goals.')
    expect(undatedFinishNote('listen')).toBe('It counts as listened, but not in any year’s stats or goals.')
  })
})

describe('dayAllowed', () => {
  it('is false before the minimum date, true from it or without one', () => {
    expect(dayAllowed('2026-10-06', '2026-10-07')).toBe(false)
    expect(dayAllowed('2026-10-07', '2026-10-07')).toBe(true)
    expect(dayAllowed('2026-10-06', undefined)).toBe(true)
  })
})

describe('yearOf', () => {
  it('is a year-precision value on the first day of that year', () => {
    expect(yearOf(2019)).toEqual({ date: '2019-01-01', precision: 'year' })
  })
})
