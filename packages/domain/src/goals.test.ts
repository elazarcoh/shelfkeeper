import { describe, expect, it } from 'vitest'
import { GoalInput, expectedProgress, goalPace, goalProgress, metricTotal } from './goals'

describe('GoalInput', () => {
  it('rejects a period that ends before it starts', () => {
    expect(GoalInput.safeParse({ periodStart: '2026-06-01', periodEnd: '2026-01-01', metric: 'books', target: 12 }).success).toBe(
      false,
    )
  })
  it('accepts a valid yearly goal', () => {
    const goal = GoalInput.parse({ periodStart: '2026-01-01', periodEnd: '2026-12-31', metric: 'books', target: 24 })
    expect(goal.target).toBe(24)
  })
})

describe('goalProgress', () => {
  it('clamps to [0, 1] and never divides by zero', () => {
    expect(goalProgress(12, 0)).toBe(0)
    expect(goalProgress(12, 6)).toBeCloseTo(0.5)
    expect(goalProgress(12, 24)).toBe(1)
    expect(goalProgress(0, 5)).toBe(0)
  })
})

describe('metricTotal', () => {
  const totals = { booksFinished: 3, minutes: 120, words: 27_500 }
  it('maps each metric to its underlying total, pages derived from words', () => {
    expect(metricTotal('books', totals)).toBe(3)
    expect(metricTotal('hours', totals)).toBe(2)
    expect(metricTotal('words', totals)).toBe(27_500)
    expect(metricTotal('pages', totals)).toBe(100)
  })
})

describe('expectedProgress', () => {
  it('is the inclusive fraction of the period elapsed by today, clamped to [0, 1]', () => {
    expect(expectedProgress('2026-01-01', '2026-01-10', '2026-01-01')).toBeCloseTo(0.1)
    expect(expectedProgress('2026-01-01', '2026-01-10', '2026-01-05')).toBeCloseTo(0.5)
    expect(expectedProgress('2026-01-01', '2026-01-10', '2026-01-10')).toBe(1)
    expect(expectedProgress('2026-01-01', '2026-01-10', '2025-12-01')).toBe(0)
    expect(expectedProgress('2026-01-01', '2026-01-10', '2026-02-01')).toBe(1)
  })
})

describe('goalPace', () => {
  it('compares progress with the expected fraction, within a small tolerance', () => {
    expect(goalPace(0.6, 0.5)).toBe('ahead')
    expect(goalPace(0.4, 0.5)).toBe('behind')
    expect(goalPace(0.51, 0.5)).toBe('on_track')
    expect(goalPace(1, 1)).toBe('on_track')
  })
})
