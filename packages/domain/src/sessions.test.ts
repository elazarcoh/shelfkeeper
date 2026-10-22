import { describe, expect, it } from 'vitest'
import {
  computeSessionAmount,
  deriveIsReread,
  editionFormatsForMode,
  finishCountsInRange,
  futureDateProblem,
  isDatedPrecision,
  markedReadDates,
  isRereadOfPastRead,
  MarkFinishedInput,
  pastReadDates,
  sessionStatsRange,
  statusAfterCompletion,
  statusForSessionOutcome,
  resolveDateRange,
  resolveFractionCompleted,
  resolveWordCount,
  spreadSessionStats,
} from './sessions'

describe('resolveFractionCompleted', () => {
  it('is always 1 when finished', () => {
    expect(resolveFractionCompleted('finished', null)).toBe(1)
    expect(resolveFractionCompleted('finished', 0.3)).toBe(1)
  })
  it('uses the estimate when abandoned, defaulting to 0.5', () => {
    expect(resolveFractionCompleted('abandoned', 0.25)).toBe(0.25)
    expect(resolveFractionCompleted('abandoned', null)).toBe(0.5)
  })
  it('defaults to the high-water mark instead when that is above 0.5 (#7)', () => {
    expect(resolveFractionCompleted('abandoned', null, 0.8)).toBe(0.8)
    expect(resolveFractionCompleted('abandoned', null, 0.3)).toBe(0.5)
    expect(resolveFractionCompleted('abandoned', 0.9, 0.8)).toBe(0.9)
  })
})

describe('deriveIsReread', () => {
  it('is true only if a prior session for the same work finished', () => {
    expect(deriveIsReread([])).toBe(false)
    expect(deriveIsReread(['abandoned', 'in_progress'])).toBe(false)
    expect(deriveIsReread(['abandoned', 'finished'])).toBe(true)
  })
})

describe('resolveWordCount', () => {
  it('prefers edition word count, then work-level, then pages (estimated), then none', () => {
    expect(resolveWordCount({ editionWordCount: 90_000, workWordCount: 80_000, pageCount: 300 })).toEqual({
      words: 90_000,
      estimated: false,
    })
    expect(resolveWordCount({ editionWordCount: null, workWordCount: 80_000, pageCount: 300 })).toEqual({
      words: 80_000,
      estimated: false,
    })
    expect(resolveWordCount({ editionWordCount: null, workWordCount: null, pageCount: 300 })).toEqual({
      words: 82_500,
      estimated: true,
    })
    expect(resolveWordCount({ editionWordCount: null, workWordCount: null, pageCount: null })).toBeNull()
  })
})

describe('computeSessionAmount', () => {
  it('converts listening duration to minutes and ignores word count', () => {
    expect(
      computeSessionAmount('listen', 0.5, 3600, { editionWordCount: null, workWordCount: null, pageCount: null }),
    ).toEqual({ minutes: 30, words: 0, estimated: false })
  })
  it('computes words for reading and ignores duration', () => {
    expect(computeSessionAmount('read', 0.5, null, { editionWordCount: 100_000, workWordCount: null, pageCount: null })).toEqual(
      { minutes: 0, words: 50_000, estimated: false },
    )
  })
  it('contributes nothing, without crashing, when no source data exists', () => {
    expect(computeSessionAmount('listen', 1, null, { editionWordCount: null, workWordCount: null, pageCount: null })).toEqual({
      minutes: 0,
      words: 0,
      estimated: false,
    })
    expect(computeSessionAmount('read', 1, null, { editionWordCount: null, workWordCount: null, pageCount: null })).toEqual({
      minutes: 0,
      words: 0,
      estimated: false,
    })
  })
})

describe('resolveDateRange', () => {
  it('resolves day and unknown precision to a single, correctly-flagged day', () => {
    expect(resolveDateRange('2026-03-14', 'day')).toEqual({ from: '2026-03-14', to: '2026-03-14', estimated: false })
    expect(resolveDateRange('2026-03-14', 'unknown')).toEqual({ from: '2026-03-14', to: '2026-03-14', estimated: true })
  })
  it('resolves month and year precision to the whole calendar range, estimated', () => {
    expect(resolveDateRange('2026-02-10', 'month')).toEqual({ from: '2026-02-01', to: '2026-02-28', estimated: true })
    expect(resolveDateRange('2024-02-10', 'month')).toEqual({ from: '2024-02-01', to: '2024-02-29', estimated: true })
    expect(resolveDateRange('2025-06-01', 'year')).toEqual({ from: '2025-01-01', to: '2025-12-31', estimated: true })
  })
})

describe('spreadSessionStats', () => {
  const words = { editionWordCount: 10_000, workWordCount: null, pageCount: null }

  it('spreads evenly across an exact day range, inclusive', () => {
    const rows = spreadSessionStats({
      mode: 'read',
      startedOn: '2026-03-01',
      startedPrecision: 'day',
      finishedOn: '2026-03-03',
      finishedPrecision: 'day',
      fractionCompleted: 1,
      durationSec: null,
      wordCountSource: words,
    })
    expect(rows).toEqual([
      { date: '2026-03-01', minutes: 0, words: 10_000 / 3, estimated: false },
      { date: '2026-03-02', minutes: 0, words: 10_000 / 3, estimated: false },
      { date: '2026-03-03', minutes: 0, words: 10_000 / 3, estimated: false },
    ])
  })

  it('unions an imprecise start with a precise finish instead of double-counting', () => {
    const rows = spreadSessionStats({
      mode: 'read',
      startedOn: '2026-02-01',
      startedPrecision: 'month', // -> 2026-02-01..2026-02-28
      finishedOn: '2026-02-10',
      finishedPrecision: 'day', // -> 2026-02-10..2026-02-10, subset of the above
      fractionCompleted: 1,
      durationSec: null,
      wordCountSource: words,
    })
    expect(rows[0]?.date).toBe('2026-02-01')
    expect(rows.at(-1)?.date).toBe('2026-02-28')
    expect(rows).toHaveLength(28)
    expect(rows.every((r) => r.estimated)).toBe(true)
    const total = rows.reduce((sum, r) => sum + r.words, 0)
    expect(total).toBeCloseTo(10_000, 6)
  })

  it('produces nothing but does not throw for a session with no measurable amount', () => {
    const rows = spreadSessionStats({
      mode: 'listen',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
      finishedOn: '2026-01-01',
      finishedPrecision: 'day',
      fractionCompleted: 1,
      durationSec: null,
      wordCountSource: { editionWordCount: null, workWordCount: null, pageCount: null },
    })
    expect(rows).toEqual([{ date: '2026-01-01', minutes: 0, words: 0, estimated: false }])
  })
})

describe('an unknown finish date (long ago / don\'t remember)', () => {
  const words = { editionWordCount: 10_000, workWordCount: null, pageCount: null }
  const session = (over: Partial<Parameters<typeof spreadSessionStats>[0]>) =>
    spreadSessionStats({
      mode: 'read',
      startedOn: '2026-03-01',
      startedPrecision: 'day',
      finishedOn: '2026-03-03',
      finishedPrecision: 'day',
      fractionCompleted: 1,
      durationSec: null,
      wordCountSource: words,
      ...over,
    })

  it('spreads nothing onto any day: a finished read with no date is kept out of every dated stat', () => {
    expect(session({ startedOn: '2026-10-07', startedPrecision: 'unknown', finishedOn: '2026-10-07', finishedPrecision: 'unknown' })).toEqual([])
    expect(session({ finishedOn: '2026-10-07', finishedPrecision: 'unknown' })).toEqual([])
    expect(session({ finishedOn: '2026-10-07', finishedPrecision: 'unknown', fractionCompleted: 0.5 })).toEqual([])
  })

  it('has no stats range, while a known finish keeps the union of its start and finish', () => {
    expect(sessionStatsRange({ startedOn: '2026-10-07', startedPrecision: 'unknown', finishedOn: '2026-10-07', finishedPrecision: 'unknown' })).toBeNull()
    expect(sessionStatsRange({ startedOn: '2026-02-01', startedPrecision: 'month', finishedOn: '2026-02-10', finishedPrecision: 'day' })).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
      estimated: true,
    })
  })

  it('keeps an unknown start with a known finish as before (it spreads from the stored start day)', () => {
    const rows = session({ startedOn: '2026-03-02', startedPrecision: 'unknown' })
    expect(rows.map((r) => r.date)).toEqual(['2026-03-02', '2026-03-03'])
    expect(rows.every((r) => r.estimated)).toBe(true)
  })

  it('is never dated', () => {
    expect(isDatedPrecision('unknown')).toBe(false)
    for (const p of ['day', 'month', 'year'] as const) expect(isDatedPrecision(p)).toBe(true)
  })
})

describe('a year-only finish', () => {
  it('spreads over the whole year, estimated, as resolveDateRange always has', () => {
    const rows = spreadSessionStats({
      mode: 'read',
      startedOn: '2019-01-01',
      startedPrecision: 'year',
      finishedOn: '2019-01-01',
      finishedPrecision: 'year',
      fractionCompleted: 1,
      durationSec: null,
      wordCountSource: { editionWordCount: 36_500, workWordCount: null, pageCount: null },
    })
    expect(rows).toHaveLength(365)
    expect(rows[0]).toEqual({ date: '2019-01-01', minutes: 0, words: 100, estimated: true })
    expect(rows.at(-1)?.date).toBe('2019-12-31')
  })
})

describe('finishCountsInRange (books finished in a period)', () => {
  const year2019 = { from: '2019-01-01', to: '2019-12-31' }
  it('counts a dated finish inside the range', () => {
    expect(finishCountsInRange('2019-03-14', 'day', year2019)).toBe(true)
    expect(finishCountsInRange('2019-03-01', 'month', year2019)).toBe(true)
    expect(finishCountsInRange('2020-01-01', 'day', year2019)).toBe(false)
  })
  it('never counts an unknown finish, whatever date it was stored with', () => {
    expect(finishCountsInRange('2019-03-14', 'unknown', year2019)).toBe(false)
  })
  it('counts a year-only finish in that whole year, but not in a part of it', () => {
    expect(finishCountsInRange('2019-01-01', 'year', year2019)).toBe(true)
    expect(finishCountsInRange('2019-01-01', 'year', { from: '2018-01-01', to: '2020-12-31' })).toBe(true)
    expect(finishCountsInRange('2019-01-01', 'year', { from: '2019-01-01', to: '2019-01-31' })).toBe(false)
    expect(finishCountsInRange('2019-01-01', 'year', { from: '2019-01-01', to: '2019-10-07' })).toBe(false)
    expect(finishCountsInRange('2019-01-01', 'year', { from: '2020-01-01', to: '2020-12-31' })).toBe(false)
  })
})

describe('MarkFinishedInput and pastReadDates (the one-tap "Mark as read")', () => {
  const workId = '0b9f2c4e-5d6a-4b7c-8d9e-0f1a2b3c4d5e'
  it('defaults to no edition and accepts every precision', () => {
    for (const finishedPrecision of ['day', 'month', 'year', 'unknown'] as const) {
      const parsed = MarkFinishedInput.parse({ workId, mode: 'listen', finishedOn: '2019-01-01', finishedPrecision })
      expect(parsed).toEqual({ workId, editionId: null, mode: 'listen', finishedOn: '2019-01-01', finishedPrecision, rating: null })
    }
  })
  it('refuses a malformed date or precision', () => {
    expect(MarkFinishedInput.safeParse({ workId, mode: 'read', finishedOn: '2019-13-01', finishedPrecision: 'day' }).success).toBe(false)
    expect(MarkFinishedInput.safeParse({ workId, mode: 'read', finishedOn: '2019-01-01', finishedPrecision: 'decade' }).success).toBe(false)
  })
  it('starts and finishes on the same date with the same precision, at the start of an imprecise range', () => {
    expect(pastReadDates('2019-06-15', 'year')).toEqual({ startedOn: '2019-01-01', startedPrecision: 'year', finishedOn: '2019-01-01', finishedPrecision: 'year' })
    expect(pastReadDates('2019-06-15', 'month')).toEqual({ startedOn: '2019-06-01', startedPrecision: 'month', finishedOn: '2019-06-01', finishedPrecision: 'month' })
    expect(pastReadDates('2019-06-15', 'day')).toEqual({ startedOn: '2019-06-15', startedPrecision: 'day', finishedOn: '2019-06-15', finishedPrecision: 'day' })
    expect(pastReadDates('2026-10-07', 'unknown')).toEqual({
      startedOn: '2026-10-07',
      startedPrecision: 'unknown',
      finishedOn: '2026-10-07',
      finishedPrecision: 'unknown',
    })
  })
  it('takes an optional rating, none by default', () => {
    expect(MarkFinishedInput.parse({ workId, mode: 'read', finishedOn: '2019-01-01', finishedPrecision: 'year' }).rating).toBeNull()
    expect(MarkFinishedInput.parse({ workId, mode: 'read', finishedOn: '2019-01-01', finishedPrecision: 'year', rating: 4.5 }).rating).toBe(4.5)
    expect(MarkFinishedInput.safeParse({ workId, mode: 'read', finishedOn: '2019-01-01', finishedPrecision: 'year', rating: 7 }).success).toBe(false)
  })

  it('a read marked finished on an exact date has an unknown start: it is not a one-day read', () => {
    expect(markedReadDates('2024-02-29', 'day')).toEqual({ startedOn: '2024-02-29', startedPrecision: 'unknown', finishedOn: '2024-02-29', finishedPrecision: 'day' })
    // month, year and unknown keep start = finish, like pastReadDates
    expect(markedReadDates('2019-06-15', 'year')).toEqual(pastReadDates('2019-06-15', 'year'))
    expect(markedReadDates('2019-06-15', 'month')).toEqual(pastReadDates('2019-06-15', 'month'))
    expect(markedReadDates('2026-10-07', 'unknown')).toEqual(pastReadDates('2026-10-07', 'unknown'))
  })

  it('an exact-date past read still spreads onto its finish day, but estimated', () => {
    const rows = spreadSessionStats({
      mode: 'read',
      ...markedReadDates('2024-02-29', 'day'),
      fractionCompleted: 1,
      durationSec: null,
      wordCountSource: { editionWordCount: 80_000, workWordCount: null, pageCount: null },
    })
    expect(rows).toEqual([{ date: '2024-02-29', minutes: 0, words: 80_000, estimated: true }])
  })

  it('a past read is a reread only after an earlier dated finish; an undated one has no known order', () => {
    const earlier = { outcome: 'finished', finishedOn: '2018-05-01', finishedPrecision: 'day' } as const
    const undated = { outcome: 'finished', finishedOn: '2026-10-01', finishedPrecision: 'unknown' } as const
    const abandoned = { outcome: 'abandoned', finishedOn: '2018-05-01', finishedPrecision: 'day' } as const
    expect(isRereadOfPastRead([earlier], '2019-01-01', 'year')).toBe(true)
    expect(isRereadOfPastRead([earlier], '2017-01-01', 'year')).toBe(false)
    expect(isRereadOfPastRead([abandoned], '2019-01-01', 'year')).toBe(false)
    expect(isRereadOfPastRead([undated], '2026-10-07', 'day')).toBe(false)
    expect(isRereadOfPastRead([earlier], '2026-10-07', 'unknown')).toBe(false)
  })
})

describe('futureDateProblem (the server refuses a date range that begins in the future)', () => {
  const server = '2026-10-07'
  it('allows today, the past, and up to the client-today tolerance ahead (time zones)', () => {
    expect(futureDateProblem('2026-10-07', 'day', server)).toBeNull()
    expect(futureDateProblem('2019-01-01', 'year', server)).toBeNull()
    expect(futureDateProblem('2026-10-09', 'day', server)).toBeNull()
    expect(futureDateProblem('2026-10-01', 'month', server)).toBeNull()
    expect(futureDateProblem('2026-01-01', 'year', server)).toBeNull()
  })
  it('refuses a range that begins after that, with a plain message', () => {
    expect(futureDateProblem('2026-10-10', 'day', server)).toBe('That date is in the future')
    expect(futureDateProblem('2026-11-01', 'month', server)).toBe('That date is in the future')
    expect(futureDateProblem('2027-01-01', 'year', server)).toBe('That date is in the future')
  })
  it('exempts an unknown date: it is only the day it was entered', () => {
    expect(futureDateProblem('2030-01-01', 'unknown', server)).toBeNull()
  })
})

describe('fallback duration', () => {
  it('flags a listen amount as estimated when the duration came from a work-level fallback', () => {
    expect(
      computeSessionAmount('listen', 1, 3600, { editionWordCount: null, workWordCount: null, pageCount: null }, true),
    ).toEqual({ minutes: 60, words: 0, estimated: true })
  })
  it('carries the fallback flag through spreadSessionStats', () => {
    const rows = spreadSessionStats({
      mode: 'listen',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
      finishedOn: '2026-01-02',
      finishedPrecision: 'day',
      fractionCompleted: 1,
      durationSec: 7200,
      durationEstimated: true,
      wordCountSource: { editionWordCount: null, workWordCount: null, pageCount: null },
    })
    expect(rows).toEqual([
      { date: '2026-01-01', minutes: 60, words: 0, estimated: true },
      { date: '2026-01-02', minutes: 60, words: 0, estimated: true },
    ])
  })
})

describe('editionFormatsForMode', () => {
  it('maps listening to audiobooks and reading to physical or ebook', () => {
    expect(editionFormatsForMode('listen')).toEqual(['audiobook'])
    expect(editionFormatsForMode('read')).toEqual(['physical', 'ebook'])
  })
})

describe('statusAfterCompletion', () => {
  it('keeps reading while another session of the work is in progress', () => {
    expect(statusAfterCompletion('finished', ['in_progress'])).toBe('reading')
    expect(statusAfterCompletion('abandoned', ['finished', 'in_progress'])).toBe('reading')
  })
  it('is read when finished, or when abandoning a reread of a finished book', () => {
    expect(statusAfterCompletion('finished', [])).toBe('read')
    expect(statusAfterCompletion('abandoned', ['finished'])).toBe('read')
  })
  it('is abandoned when abandoning a book never finished', () => {
    expect(statusAfterCompletion('abandoned', ['abandoned'])).toBe('abandoned')
  })
})

describe('statusForSessionOutcome', () => {
  it('maps a session outcome to the reading status it implies', () => {
    expect(statusForSessionOutcome('in_progress')).toBe('reading')
    expect(statusForSessionOutcome('finished')).toBe('read')
    expect(statusForSessionOutcome('abandoned')).toBe('abandoned')
  })
})
