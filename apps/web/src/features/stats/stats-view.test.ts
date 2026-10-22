import { describe, expect, it } from 'vitest'
import {
  biggestMonth,
  booksByMonth,
  bucketByMonth,
  buildHeatmap,
  comparisonRange,
  computeHighlights,
  finishLabel,
  formatCompact,
  formatHours,
  goalAmountText,
  niceTicks,
  packTimeline,
  periodLabel,
  periodNoun,
  readDatesLabel,
  timelineRows,
  timelineSpans,
  weekdayDate,
  yearNav,
  type FinishedBookLike,
} from './stats-view'

describe('bucketByMonth', () => {
  it('sums minutes into hours and words per month, tracking the estimated portions separately', () => {
    const daily = [
      { date: '2026-01-05', minutes: 60, words: 1000, estimated: false },
      { date: '2026-01-20', minutes: 30, words: 500, estimated: true },
      { date: '2026-02-01', minutes: 120, words: 0, estimated: false },
      { date: '2025-12-31', minutes: 999, words: 0, estimated: false }, // different year, ignored
    ]
    const months = bucketByMonth(daily, 2026)
    expect(months).toHaveLength(12)
    expect(months[0]).toEqual({ month: '2026-01', hours: 1.5, estimatedHours: 0.5, words: 1500, estimatedWords: 500 })
    expect(months[1]).toEqual({ month: '2026-02', hours: 2, estimatedHours: 0, words: 0, estimatedWords: 0 })
    expect(months[11]).toEqual({ month: '2026-12', hours: 0, estimatedHours: 0, words: 0, estimatedWords: 0 })
  })
})

describe('buildHeatmap', () => {
  it('covers every day of the year at level 0 when there is no activity', () => {
    const days = buildHeatmap([], 2026)
    expect(days).toHaveLength(365)
    expect(days.every((d) => d.level === 0 && !d.future)).toBe(true)
    expect(days[0]?.date).toBe('2026-01-01')
    expect(days.at(-1)?.date).toBe('2026-12-31')
  })

  it('gives a day with activity a level above zero and sums its read and listen rows', () => {
    const days = buildHeatmap(
      [
        { date: '2026-06-15', minutes: 60, words: 0, estimated: false },
        { date: '2026-06-15', minutes: 0, words: 3000, estimated: false },
      ],
      2026,
    )
    const day = days.find((d) => d.date === '2026-06-15')
    expect(day?.level).toBeGreaterThan(0)
    expect(day).toMatchObject({ minutes: 60, words: 3000 })
  })

  it('marks the days after today as future', () => {
    const days = buildHeatmap([], 2026, '2026-10-05')
    expect(days.find((d) => d.date === '2026-10-05')?.future).toBe(false)
    expect(days.find((d) => d.date === '2026-10-06')?.future).toBe(true)
  })
})

describe('periodLabel', () => {
  it('names a calendar year by its number', () => {
    expect(periodLabel('2026-01-01', '2026-12-31')).toBe('2026')
  })
  it('names a calendar month by month and year', () => {
    expect(periodLabel('2026-10-01', '2026-10-31')).toBe('October 2026')
    expect(periodLabel('2028-02-01', '2028-02-29')).toBe('February 2028')
  })
  it('falls back to a date range otherwise', () => {
    expect(periodLabel('2026-10-01', '2026-10-15')).toBe('Oct 1–15, 2026')
    expect(periodLabel('2026-03-15', '2026-06-30')).toBe('Mar 15 – Jun 30, 2026')
    expect(periodLabel('2026-12-01', '2027-01-31')).toBe('Dec 1, 2026 – Jan 31, 2027')
    expect(periodLabel('2026-01-01', '2026-12-30')).toBe('Jan 1 – Dec 30, 2026')
  })
  it('has a matching noun for pacing text', () => {
    expect(periodNoun('2026-01-01', '2026-12-31')).toBe('the year')
    expect(periodNoun('2026-10-01', '2026-10-31')).toBe('October')
    expect(periodNoun('2026-03-15', '2026-06-30')).toBe('the period')
  })
})

describe('goalAmountText', () => {
  it('reads as "n of target unit"', () => {
    expect(goalAmountText('books', 2, 4)).toBe('2 of 4 books')
    expect(goalAmountText('pages', 3482.4, 8000)).toBe('3,482 of 8,000 pages')
  })
})

describe('yearNav', () => {
  it('never offers a year after the current one', () => {
    expect(yearNav(2026, 2026)).toEqual({ prev: 2025, next: null })
    expect(yearNav(2024, 2026)).toEqual({ prev: 2023, next: 2025 })
  })
})

describe('comparisonRange', () => {
  it('compares a past year with the whole year before it', () => {
    expect(comparisonRange(2025, '2026-10-05')).toEqual({ from: '2024-01-01', to: '2024-12-31', partial: false })
  })
  it('compares the current year with the same stretch of last year', () => {
    expect(comparisonRange(2026, '2026-10-05')).toEqual({ from: '2025-01-01', to: '2025-10-05', partial: true })
    expect(comparisonRange(2028, '2028-02-29')).toEqual({ from: '2027-01-01', to: '2027-02-28', partial: true })
  })
})

describe('axis formatting', () => {
  it('niceTicks covers the max with clean steps', () => {
    expect(niceTicks(9)).toEqual([0, 5, 10])
    expect(niceTicks(10)).toEqual([0, 5, 10])
    expect(niceTicks(4)).toEqual([0, 2, 4])
    expect(niceTicks(957_415)).toEqual([0, 500_000, 1_000_000])
    expect(niceTicks(1.3)).toEqual([0, 0.5, 1, 1.5])
    expect(niceTicks(0)).toEqual([0, 1])
    expect(niceTicks(1, 3, true)).toEqual([0, 1])
    expect(niceTicks(4, 3, true)).toEqual([0, 2, 4])
    for (const max of [1, 3, 7, 23, 140, 12_345]) {
      const ticks = niceTicks(max)
      expect(ticks[0]).toBe(0)
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(max)
      expect(ticks.length).toBeLessThanOrEqual(5)
    }
  })
  it('formatCompact abbreviates thousands and millions', () => {
    expect(formatCompact(950)).toBe('950')
    expect(formatCompact(12_940)).toBe('13K')
    expect(formatCompact(1_250)).toBe('1.3K')
    expect(formatCompact(957_415)).toBe('957K')
    expect(formatCompact(1_250_000)).toBe('1.3M')
    expect(formatCompact(999_999)).toBe('1M')
    expect(formatCompact(-2_000)).toBe('-2K')
  })
  it('formatHours keeps one decimal below ten', () => {
    expect(formatHours(0)).toBe('0')
    expect(formatHours(0.25)).toBe('0.3')
    expect(formatHours(2)).toBe('2')
    expect(formatHours(12.6)).toBe('13')
  })
  it('weekdayDate names the day', () => {
    expect(weekdayDate('2026-10-05')).toBe('Mon, Oct 5')
  })
})

const book = (over: Partial<FinishedBookLike>): FinishedBookLike => ({
  sessionId: over.sessionId ?? Math.random().toString(),
  workId: 'w',
  title: 'T',
  authors: [],
  coverAssetId: null,
  rating: null,
  format: 'physical',
  mode: 'read',
  startedOn: '2026-03-01',
  startedPrecision: 'day',
  finishedOn: '2026-03-05',
  finishedPrecision: 'day',
  isReread: false,
  pageCount: null,
  durationSec: null,
  ...over,
})

describe('booksByMonth and biggestMonth', () => {
  it('counts books per month by format and picks the month with the most books', () => {
    const books = [
      book({ finishedOn: '2026-03-05', format: 'ebook' }),
      book({ finishedOn: '2026-03-20', format: 'physical' }),
      book({ finishedOn: '2026-07-01', format: 'audiobook' }),
      book({ finishedOn: '2025-03-01' }), // other year
    ]
    const counts = booksByMonth(books, 2026)
    expect(counts[2]).toEqual({ physical: 1, ebook: 1, audiobook: 0, unspecified: 0 })
    expect(counts[6]?.audiobook).toBe(1)
    const months = bucketByMonth([{ date: '2026-07-10', minutes: 900, words: 0, estimated: false }], 2026)
    expect(biggestMonth(months, counts)).toBe(2)
    expect(biggestMonth(bucketByMonth([], 2026), booksByMonth([], 2026))).toBeNull()
  })

  it('leaves out a finish known only by its year: it has no month to go in', () => {
    const counts = booksByMonth([book({ finishedOn: '2026-01-01', finishedPrecision: 'year', format: 'audiobook' })], 2026)
    expect(counts.every((m) => m.audiobook === 0)).toBe(true)
  })
})

describe('finishLabel', () => {
  it('says the finish as precisely as it is known', () => {
    expect(finishLabel('2026-03-04', 'day')).toBe('Mar 4')
    expect(finishLabel('2026-03-01', 'month')).toBe('Mar')
    expect(finishLabel('2026-01-01', 'year')).toBe('2026')
    expect(finishLabel('2026-10-07', 'unknown')).toBe('Date unknown')
  })
})

describe('readDatesLabel', () => {
  it('is "start – finish", the start with its year when it began in an earlier one', () => {
    expect(readDatesLabel(book({ startedOn: '2026-03-01', finishedOn: '2026-03-05' }), false)).toBe('Mar 1 – Mar 5')
    expect(readDatesLabel(book({ startedOn: '2025-12-20', finishedOn: '2026-01-05' }), true)).toBe('Dec 20, 2025 – Jan 5')
    expect(readDatesLabel(book({ startedOn: '2026-02-01', startedPrecision: 'month', finishedOn: '2026-03-05' }), false)).toBe('Feb – Mar 5')
  })
  it('says a past read in a month or a year once', () => {
    const inYear = book({ startedOn: '2026-01-01', startedPrecision: 'year', finishedOn: '2026-01-01', finishedPrecision: 'year' })
    expect(readDatesLabel(inYear, false)).toBe('2026')
    const inMonth = book({ startedOn: '2026-04-01', startedPrecision: 'month', finishedOn: '2026-04-01', finishedPrecision: 'month' })
    expect(readDatesLabel(inMonth, false)).toBe('Apr')
  })
})

describe('computeHighlights', () => {
  it('finds the longest and quickest reads, a repeat author, rereads and the rating spread', () => {
    const books = [
      book({ sessionId: 'a', workId: 'a', title: 'Short', authors: ['Ann'], pageCount: 120, startedOn: '2026-01-01', finishedOn: '2026-01-02', rating: 4 }),
      book({ sessionId: 'b', workId: 'b', title: 'Long', authors: ['Ann', 'Bo'], pageCount: 900, finishedOn: '2026-02-01', rating: 5 }),
      book({ sessionId: 'c', workId: 'c', title: 'Audio', mode: 'listen', durationSec: 10 * 3600, authors: ['Bo'], finishedOn: '2026-04-01', isReread: true }),
      book({ sessionId: 'd', workId: 'd', title: 'Vague', startedPrecision: 'month', finishedOn: '2026-05-02', rating: 2.5 }),
    ]
    const h = computeHighlights(books)
    expect(h.longest?.book.title).toBe('Long')
    expect(h.longest?.text).toBe('900 pages')
    expect(h.quickest).toMatchObject({ days: 2 })
    expect(h.quickest?.book.title).toBe('Short')
    expect(h.topAuthor).toEqual({ name: 'Ann', count: 2 })
    expect(h.first?.title).toBe('Short')
    expect(h.rereads).toBe(1)
    expect(h.rating?.count).toBe(3)
    expect(h.rating?.average).toBeCloseTo((4 + 5 + 2.5) / 3)
    expect(h.rating?.bins).toEqual([0, 1, 0, 1, 1])
  })

  it('a finish known only by its year is never "the first finish of the year"', () => {
    const yearOnly = book({ sessionId: 'y', title: 'Some time in 2026', startedOn: '2026-01-01', startedPrecision: 'year', finishedOn: '2026-01-01', finishedPrecision: 'year' })
    expect(computeHighlights([yearOnly, book({ sessionId: 'd', title: 'Dated', finishedOn: '2026-03-01' })]).first?.title).toBe('Dated')
    expect(computeHighlights([yearOnly]).first).toBeNull()
  })

  it('says nothing it cannot back up', () => {
    const h = computeHighlights([book({ authors: ['Solo'], startedPrecision: 'unknown' })])
    expect(h.longest).toBeNull()
    expect(h.quickest).toBeNull()
    expect(h.topAuthor).toBeNull()
    expect(h.rating).toBeNull()
    expect(computeHighlights([]).first).toBeNull()
  })
})

describe('timeline', () => {
  it('spans a book across its (resolved) dates, clamped to the year', () => {
    const [precise, vague, carried] = timelineSpans(
      [
        book({ startedOn: '2026-01-01', finishedOn: '2026-01-01' }),
        book({ startedOn: '2026-03-01', startedPrecision: 'month', finishedOn: '2026-03-10' }),
        book({ startedOn: '2025-12-20', finishedOn: '2026-01-10' }),
      ],
      2026,
    )
    expect(precise).toMatchObject({ start: 0, estimated: false, continued: false })
    expect(precise?.end).toBeCloseTo(1 / 365)
    expect(vague?.estimated).toBe(true)
    expect(vague?.end).toBeCloseTo(90 / 365) // the whole of March
    expect(carried).toMatchObject({ start: 0, continued: true })
  })

  it('packs overlapping bars (and their labels) into separate lanes, reusing free lanes', () => {
    const spans = [
      { start: 0, end: 0.1 },
      { start: 0.05, end: 0.2 },
      { start: 0.5, end: 0.6 },
      { start: 0.95, end: 1 },
    ].map((s) => ({ ...s, book: book({}), estimated: false, continued: false }))
    const { bars, lanes } = packTimeline(spans, () => 0.1, 0)
    expect(lanes).toBe(2)
    expect(bars.map((b) => b.lane)).toEqual([0, 1, 0, 0])
    expect(bars.at(-1)?.labelSide).toBe('start') // no room after the year's end
  })
})

describe('timelineRows', () => {
  it('lists the year’s books for the phone timeline, latest finish first', () => {
    const rows = timelineRows(
      [
        book({ title: 'A', startedOn: '2026-01-01', finishedOn: '2026-01-20' }),
        book({ title: 'B', startedOn: '2026-03-01', finishedOn: '2026-04-10' }),
        book({ title: 'C', startedOn: '2025-12-20', finishedOn: '2026-02-01' }),
      ],
      2026,
    )
    expect(rows.map((r) => r.book.title)).toEqual(['B', 'C', 'A'])
    expect(rows[1]).toMatchObject({ start: 0, continued: true })
  })
})
