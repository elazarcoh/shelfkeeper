import { z } from 'zod'
import { GoalMetric } from './enums'
import { WORDS_PER_PAGE } from './sessions'

export const GoalInput = z
  .object({
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    metric: GoalMetric,
    target: z.number().positive(),
  })
  .refine((v) => v.periodStart <= v.periodEnd, { message: 'Period end must be on or after period start', path: ['periodEnd'] })
export type GoalInput = z.output<typeof GoalInput>

export function goalProgress(target: number, total: number): number {
  if (target <= 0) return 0
  return Math.min(1, Math.max(0, total / target))
}

const MS_PER_DAY = 86_400_000
const dayNumber = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY)

/** The fraction of a goal that should be done by `today` at an even pace: elapsed days (inclusive) / period days, clamped. */
export function expectedProgress(periodStart: string, periodEnd: string, today: string): number {
  const length = dayNumber(periodEnd) - dayNumber(periodStart) + 1
  if (length <= 0) return 0
  const elapsed = dayNumber(today) - dayNumber(periodStart) + 1
  return Math.min(1, Math.max(0, elapsed / length))
}

export type GoalPace = 'ahead' | 'behind' | 'on_track'

const PACE_TOLERANCE = 0.02

/** Progress compared with the even-pace expectation; within a small tolerance counts as on track. */
export function goalPace(progress: number, expected: number): GoalPace {
  if (progress > expected + PACE_TOLERANCE) return 'ahead'
  if (progress < expected - PACE_TOLERANCE) return 'behind'
  return 'on_track'
}

export interface MetricTotals {
  booksFinished: number
  minutes: number
  words: number
}

/** daily_stat has no pages column; a pages goal is compared against words/275, the same ratio the word-count fallback uses. */
export function metricTotal(metric: GoalMetric, totals: MetricTotals): number {
  switch (metric) {
    case 'books':
      return totals.booksFinished
    case 'hours':
      return totals.minutes / 60
    case 'words':
      return totals.words
    case 'pages':
      return totals.words / WORDS_PER_PAGE
  }
}
