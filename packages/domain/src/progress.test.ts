import { describe, expect, it } from 'vitest'
import {
  abandonFractionProblem,
  AddProgressInput,
  allowedProgressKinds,
  clientTodayProblem,
  highestFraction,
  pastAbandonProblem,
  formatClock,
  missingLength,
  progressPastEndProblem,
  progressDateProblem,
  progressFraction,
  progressKindProblem,
  progressStatsSpan,
  spreadProgressStats,
  UpdateProgressInput,
  type ProgressSessionForStats,
} from './progress'
import { addDaysIso, datesInRange, resolveDateRange, type DailyAmount } from './sessions'

const SESSION = '71111111-1111-4111-8111-000000000001'

const read = (more: Partial<ProgressSessionForStats> = {}): ProgressSessionForStats => ({
  mode: 'read',
  startedOn: '2026-03-01',
  startedPrecision: 'day',
  end: null,
  checkpoints: [],
  durationSec: null,
  wordCountSource: { editionWordCount: 100_000, workWordCount: null, pageCount: null },
  ...more,
})
const words = (rows: DailyAmount[]) => Object.fromEntries(rows.map((r) => [r.date.slice(5), Math.round(r.words)]))
const sum = (rows: DailyAmount[], key: 'words' | 'minutes') => rows.reduce((n, r) => n + r[key], 0)

describe('date helpers', () => {
  it('lists every date inclusive, and nothing when the range is reversed', () => {
    expect(datesInRange('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
    expect(datesInRange('2026-03-02', '2026-03-02')).toEqual(['2026-03-02'])
    expect(datesInRange('2026-03-03', '2026-03-02')).toEqual([])
  })
  it('moves a date by whole days across month and year ends', () => {
    expect(addDaysIso('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('progress kinds by format', () => {
  it('allows pages for print, pages or percent for ebooks, time or percent for audiobooks, percent without an edition', () => {
    expect(allowedProgressKinds('physical')).toEqual(['page'])
    expect(allowedProgressKinds('ebook')).toEqual(['page', 'percent'])
    expect(allowedProgressKinds('audiobook')).toEqual(['seconds', 'percent'])
    expect(allowedProgressKinds(null)).toEqual(['percent'])
  })
  it('explains a kind that does not fit, in plain words', () => {
    expect(progressKindProblem('page', 'physical')).toBeNull()
    expect(progressKindProblem('seconds', 'physical')).toMatch(/page number/)
    expect(progressKindProblem('page', 'audiobook')).toMatch(/time or a percentage/)
    expect(progressKindProblem('percent', 'audiobook')).toBeNull()
    expect(progressKindProblem('page', null)).toMatch(/percentage/)
    expect(progressKindProblem('page', 'ebook')).toBeNull()
    expect(progressKindProblem('percent', 'ebook')).toBeNull()
    expect(progressKindProblem('seconds', 'ebook')).toMatch(/page or a percentage/)
  })
})

describe('progressFraction', () => {
  it('derives the fraction from the edition length, capped to [0, 1]', () => {
    expect(progressFraction('page', 120, { pageCount: 300, durationSec: null })).toBeCloseTo(0.4)
    expect(progressFraction('page', 420, { pageCount: 400, durationSec: null })).toBe(1)
    expect(progressFraction('seconds', 1800, { pageCount: null, durationSec: 3600 })).toBe(0.5)
    expect(progressFraction('percent', 45, { pageCount: null, durationSec: null })).toBe(0.45)
  })
  it('page 0 is the start and percent 100 is the whole book', () => {
    expect(progressFraction('page', 0, { pageCount: 300, durationSec: null })).toBe(0)
    expect(progressFraction('percent', 100, { pageCount: null, durationSec: null })).toBe(1)
  })
  it('treats a stored length of 0 as missing, in both the fraction and the prompt', () => {
    expect(progressFraction('page', 10, { pageCount: 0, durationSec: null })).toBeNull()
    expect(missingLength('page', { pageCount: 0, durationSec: null })).toBe('pageCount')
    expect(progressFraction('seconds', 10, { pageCount: null, durationSec: 0 })).toBeNull()
    expect(missingLength('seconds', { pageCount: null, durationSec: 0 })).toBe('durationSec')
  })
  it('has no fraction when the needed length is missing', () => {
    expect(progressFraction('page', 120, { pageCount: null, durationSec: 3600 })).toBeNull()
    expect(progressFraction('seconds', 60, { pageCount: 300, durationSec: null })).toBeNull()
    expect(missingLength('page', { pageCount: null, durationSec: null })).toBe('pageCount')
    expect(missingLength('seconds', { pageCount: null, durationSec: null })).toBe('durationSec')
    expect(missingLength('percent', { pageCount: null, durationSec: null })).toBeNull()
    expect(missingLength('page', { pageCount: 300, durationSec: null })).toBeNull()
  })
})

describe('progressDateProblem', () => {
  const started = resolveDateRange('2026-03-01', 'month')
  it('accepts the start day through today', () => {
    expect(progressDateProblem('2026-03-01', '2026-03-20', started, null)).toBeNull()
    expect(progressDateProblem('2026-03-20', '2026-03-20', started, null)).toBeNull()
  })
  it('refuses the future, before the (earliest) start, and after the read ended (finished or abandoned alike)', () => {
    expect(progressDateProblem('2026-03-21', '2026-03-20', started, null)).toMatch(/future/)
    expect(progressDateProblem('2026-02-28', '2026-03-20', started, null)).toMatch(/before you started/)
    const ended = progressDateProblem('2026-03-12', '2026-03-20', started, resolveDateRange('2026-03-10', 'day'))
    expect(ended).toBe('That date is after this read ended')
    expect(ended).not.toMatch(/finished/)
  })
})

describe('progressPastEndProblem (a value past the end of the book)', () => {
  const pages = { pageCount: 300, durationSec: null }
  const audio = { pageCount: null, durationSec: 35_100 }
  it('refuses a page past the page count and a time past the length, pointing at the book page', () => {
    expect(progressPastEndProblem('page', 1200, pages)).toBe('This edition has 300 pages. If yours has more, update the page count on the book page.')
    expect(progressPastEndProblem('seconds', 35_101, audio)).toBe('This edition is 9:45:00 long. If yours is longer, update the length on the book page.')
    expect(progressPastEndProblem('page', 100_000, { pageCount: 1_200, durationSec: null })).toMatch(/^This edition has 1,200 pages\./)
  })
  it('allows the last page and the full length', () => {
    expect(progressPastEndProblem('page', 300, pages)).toBeNull()
    expect(progressPastEndProblem('seconds', 35_100, audio)).toBeNull()
  })
  it('changes nothing while the length is unknown (missing or a stored 0), and leaves percentages to their own cap', () => {
    expect(progressPastEndProblem('page', 5_000, { pageCount: null, durationSec: 35_100 })).toBeNull()
    expect(progressPastEndProblem('page', 5_000, { pageCount: 0, durationSec: null })).toBeNull()
    expect(progressPastEndProblem('seconds', 99_999, { pageCount: 300, durationSec: null })).toBeNull()
    expect(progressPastEndProblem('percent', 100, pages)).toBeNull()
  })
})

describe('formatClock', () => {
  it('writes seconds as h:mm:ss', () => {
    expect(formatClock(35_100)).toBe('9:45:00')
    expect(formatClock(3_725)).toBe('1:02:05')
  })
})

describe('clientTodayProblem (RP6)', () => {
  it('accepts a client today within 2 days of the server UTC date, either way', () => {
    for (const today of ['2026-03-18', '2026-03-19', '2026-03-20', '2026-03-21', '2026-03-22']) {
      expect(clientTodayProblem(today, '2026-03-20')).toBeNull()
    }
  })
  it('refuses a client today further away, in plain words', () => {
    expect(clientTodayProblem('2026-03-23', '2026-03-20')).toMatch(/date/)
    expect(clientTodayProblem('2026-03-17', '2026-03-20')).toMatch(/date/)
    expect(clientTodayProblem('2027-03-20', '2026-03-20')).not.toBeNull()
  })
  it('works across a month end', () => {
    expect(clientTodayProblem('2026-03-01', '2026-02-27')).toBeNull()
    expect(clientTodayProblem('2026-03-02', '2026-02-27')).not.toBeNull()
  })
})

describe('progress inputs', () => {
  const base = { sessionId: SESSION, today: '2026-03-20' }
  it('accepts whole pages, whole seconds and percentages up to 100', () => {
    expect(AddProgressInput.safeParse({ ...base, kind: 'page', value: 560 }).success).toBe(true)
    expect(AddProgressInput.safeParse({ ...base, kind: 'seconds', value: 19_800 }).success).toBe(true)
    expect(AddProgressInput.safeParse({ ...base, kind: 'percent', value: 37.5 }).success).toBe(true)
  })
  it('refuses fractional pages, percentages over 100, negatives and an oversized page count', () => {
    expect(AddProgressInput.safeParse({ ...base, kind: 'page', value: 1.5 }).success).toBe(false)
    expect(AddProgressInput.safeParse({ ...base, kind: 'percent', value: 101 }).success).toBe(false)
    expect(AddProgressInput.safeParse({ ...base, kind: 'page', value: -1 }).success).toBe(false)
    expect(AddProgressInput.safeParse({ ...base, kind: 'page', value: 10, editionLength: 200_000 }).success).toBe(false)
  })
  it('accepts page 0 and percent 100', () => {
    expect(AddProgressInput.safeParse({ ...base, kind: 'page', value: 0 }).success).toBe(true)
    expect(AddProgressInput.safeParse({ ...base, kind: 'percent', value: 100 }).success).toBe(true)
  })
  it('refuses impossible or malformed dates', () => {
    expect(AddProgressInput.safeParse({ ...base, today: '2026-02-30', kind: 'page', value: 1 }).success).toBe(false)
    expect(AddProgressInput.safeParse({ ...base, on: '2026-02-30', kind: 'page', value: 1 }).success).toBe(false)
    expect(AddProgressInput.safeParse({ ...base, on: 'x', kind: 'page', value: 1 }).success).toBe(false)
    expect(UpdateProgressInput.safeParse({ pointId: SESSION, today: '2026-03-20', on: '2026-02-30', kind: 'page', value: 1 }).success).toBe(false)
  })
  it('refuses a time that is not whole seconds, or over the maximum, each with its own message', () => {
    const fractional = AddProgressInput.safeParse({ ...base, kind: 'seconds', value: 12.5 })
    expect(fractional.success).toBe(false)
    expect(fractional.error?.issues[0]?.message).toMatch(/whole seconds/)
    const tooLong = AddProgressInput.safeParse({ ...base, kind: 'seconds', value: 1_000_001 })
    expect(tooLong.success).toBe(false)
    expect(tooLong.error?.issues[0]?.message).toMatch(/too long/)
    expect(AddProgressInput.safeParse({ ...base, kind: 'seconds', value: 1_000_000 }).success).toBe(true)
  })
  it('refuses an edition length that is not whole', () => {
    expect(AddProgressInput.safeParse({ ...base, kind: 'page', value: 10, editionLength: 300.5 }).success).toBe(false)
    expect(AddProgressInput.safeParse({ ...base, kind: 'seconds', value: 10, editionLength: 3600.5 }).success).toBe(false)
    expect(AddProgressInput.safeParse({ ...base, kind: 'page', value: 10, editionLength: 300 }).success).toBe(true)
  })
  it('refuses an edition length with a percentage, which needs none', () => {
    const r = AddProgressInput.safeParse({ ...base, kind: 'percent', value: 10, editionLength: 300 })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]).toMatchObject({ path: ['editionLength'] })
    expect(r.error?.issues[0]?.message).toMatch(/percentage/)
  })
  it('an update carries the same value rules', () => {
    const upd = { pointId: SESSION, today: '2026-03-20', on: '2026-03-19' }
    expect(UpdateProgressInput.safeParse({ ...upd, kind: 'percent', value: 100 }).success).toBe(true)
    expect(UpdateProgressInput.safeParse({ ...upd, kind: 'percent', value: 100.5 }).success).toBe(false)
  })
})

describe('spreadProgressStats (reading progress spec §4)', () => {
  it('spreads each segment over the days after the earlier checkpoint through the later one', () => {
    const rows = spreadProgressStats(
      read({
        checkpoints: [
          { on: '2026-03-03', fraction: 0.3 },
          { on: '2026-03-05', fraction: 0.5 },
        ],
        end: { on: '2026-03-06', precision: 'day', fraction: 1 },
      }),
    )
    expect(words(rows)).toEqual({ '03-01': 10_000, '03-02': 10_000, '03-03': 10_000, '03-04': 10_000, '03-05': 10_000, '03-06': 50_000 })
    expect(sum(rows, 'words')).toBeCloseTo(100_000, 6)
    expect(rows.every((r) => !r.estimated)).toBe(true)
  })

  // RP5: segments count only progress past the highest fraction so far, so a session never totals more than the book.
  it('a backwards value adds nothing, and the finish counts only what lies past the earlier high', () => {
    const rows = spreadProgressStats(
      read({
        checkpoints: [
          { on: '2026-03-03', fraction: 0.5 },
          { on: '2026-03-04', fraction: 0.4 },
        ],
        end: { on: '2026-03-05', precision: 'day', fraction: 1 },
      }),
    )
    expect(words(rows)).toEqual({ '03-01': 16_667, '03-02': 16_667, '03-03': 16_667, '03-05': 50_000 })
    expect(sum(rows, 'words')).toBeCloseTo(100_000, 6)
  })

  it('backwards then forward counts only the part beyond the earlier high', () => {
    const rows = spreadProgressStats(
      read({
        checkpoints: [
          { on: '2026-03-02', fraction: 0.5 },
          { on: '2026-03-03', fraction: 0.2 },
          { on: '2026-03-04', fraction: 0.4 },
          { on: '2026-03-06', fraction: 0.7 },
        ],
      }),
    )
    // 0.5 over Mar 1-2; the dip to 0.2 and the climb back to 0.4 add nothing; 0.5 → 0.7 spreads over Mar 5-6
    expect(words(rows)).toEqual({ '03-01': 25_000, '03-02': 25_000, '03-05': 10_000, '03-06': 10_000 })
    expect(sum(rows, 'words')).toBeCloseTo(70_000, 6)
  })

  it('a finish on the same day as a backwards point puts only the rest past the high on that day', () => {
    const rows = spreadProgressStats(
      read({
        checkpoints: [
          { on: '2026-03-02', fraction: 0.8 },
          { on: '2026-03-04', fraction: 0.1 },
        ],
        end: { on: '2026-03-04', precision: 'day', fraction: 1 },
      }),
    )
    expect(words(rows)).toEqual({ '03-01': 40_000, '03-02': 40_000, '03-04': 20_000 })
    expect(sum(rows, 'words')).toBeCloseTo(100_000, 6)
  })

  it('a point on the start day puts its amount on that day', () => {
    expect(words(spreadProgressStats(read({ checkpoints: [{ on: '2026-03-01', fraction: 0.2 }] })))).toEqual({ '03-01': 20_000 })
  })

  it('a finish on the day of the last point puts the rest on that day', () => {
    const rows = spreadProgressStats(read({ checkpoints: [{ on: '2026-03-03', fraction: 0.5 }], end: { on: '2026-03-03', precision: 'day', fraction: 1 } }))
    expect(words(rows)).toEqual({ '03-01': 16_667, '03-02': 16_667, '03-03': 66_667 })
  })

  it('an imprecise finish spreads the last segment over the rest of its range, estimated', () => {
    const rows = spreadProgressStats(read({ checkpoints: [{ on: '2026-03-10', fraction: 0.5 }], end: { on: '2026-04-01', precision: 'month', fraction: 1 } }))
    expect(rows).toHaveLength(61) // 10 days in March up to the point, then Mar 11 .. Apr 30
    expect(rows[0]).toMatchObject({ date: '2026-03-01', words: 5_000 })
    expect(rows.at(-1)?.date).toBe('2026-04-30')
    expect(sum(rows, 'words')).toBeCloseTo(100_000, 6)
    expect(rows.every((r) => r.estimated)).toBe(true)
  })

  it('an in-progress session counts only up to its latest point', () => {
    const rows = spreadProgressStats(read({ checkpoints: [{ on: '2026-03-04', fraction: 0.4 }] }))
    expect(words(rows)).toEqual({ '03-01': 10_000, '03-02': 10_000, '03-03': 10_000, '03-04': 10_000 })
  })

  it('abandoning at the latest point adds nothing more; abandoning further spreads the difference', () => {
    const at = spreadProgressStats(read({ checkpoints: [{ on: '2026-03-04', fraction: 0.4 }], end: { on: '2026-03-08', precision: 'day', fraction: 0.4 } }))
    expect(Object.keys(words(at))).toEqual(['03-01', '03-02', '03-03', '03-04'])
    const further = spreadProgressStats(read({ checkpoints: [{ on: '2026-03-04', fraction: 0.4 }], end: { on: '2026-03-08', precision: 'day', fraction: 0.6 } }))
    expect(words(further)).toMatchObject({ '03-05': 5_000, '03-08': 5_000 })
  })

  it('listening spreads minutes from the duration', () => {
    const rows = spreadProgressStats(read({ mode: 'listen', durationSec: 36_000, checkpoints: [{ on: '2026-03-02', fraction: 0.5 }] }))
    expect(rows.map((r) => r.minutes)).toEqual([150, 150])
  })

  it('is estimated when the words come from pages or a date is imprecise, exact for a real word count', () => {
    const fromPages = read({ wordCountSource: { editionWordCount: null, workWordCount: null, pageCount: 300 }, checkpoints: [{ on: '2026-03-02', fraction: 0.5 }] })
    expect(spreadProgressStats(fromPages).every((r) => r.estimated)).toBe(true)
    const imprecise = read({ startedPrecision: 'month', checkpoints: [{ on: '2026-03-02', fraction: 0.5 }] })
    expect(spreadProgressStats(imprecise).every((r) => r.estimated)).toBe(true)
  })

  it('a page past the end never counts more than the whole book', () => {
    const rows = spreadProgressStats(read({ checkpoints: [{ on: '2026-03-02', fraction: 1.4 }], end: { on: '2026-03-03', precision: 'day', fraction: 1 } }))
    expect(sum(rows, 'words')).toBeCloseTo(100_000, 6)
  })

  it('without checkpoints there is nothing to spread and no span', () => {
    expect(spreadProgressStats(read())).toEqual([])
    expect(progressStatsSpan(read())).toBeNull()
  })

  it('a finish on an unknown date counts its points\' days only, and spans to the latest point', () => {
    const session = read({ checkpoints: [{ on: '2026-03-04', fraction: 0.4 }], end: { on: '2026-10-07', precision: 'unknown', fraction: 1 } })
    expect(words(spreadProgressStats(session))).toEqual({ '03-01': 10_000, '03-02': 10_000, '03-03': 10_000, '03-04': 10_000 })
    expect(spreadProgressStats(session).every((r) => !r.estimated)).toBe(true)
    expect(progressStatsSpan(session)).toEqual({ from: '2026-03-01', to: '2026-03-04' })
  })

  it('spans from the earliest start day to the latest point or the end of the finish range', () => {
    expect(progressStatsSpan(read({ checkpoints: [{ on: '2026-03-04', fraction: 0.4 }] }))).toEqual({ from: '2026-03-01', to: '2026-03-04' })
    expect(
      progressStatsSpan(read({ checkpoints: [{ on: '2026-03-04', fraction: 0.4 }], end: { on: '2026-04-01', precision: 'month', fraction: 1 } })),
    ).toEqual({ from: '2026-03-01', to: '2026-04-30' })
  })
})

describe('the high-water mark and the abandon fraction (#7)', () => {
  const length = { pageCount: 300, durationSec: null }

  it('is the highest fraction among the points; points without one count for nothing', () => {
    expect(highestFraction([], length)).toBeNull()
    expect(highestFraction([{ kind: 'page', value: 180 }, { kind: 'page', value: 90 }, { kind: 'seconds', value: 60 }], length)).toBe(0.6)
    expect(highestFraction([{ kind: 'page', value: 180 }], { pageCount: null, durationSec: null })).toBeNull()
    expect(highestFraction([{ kind: 'percent', value: 70 }, { kind: 'page', value: 180 }], length)).toBe(0.7)
  })

  it('refuses an abandon below it, not one at it (float noise included) or above', () => {
    expect(abandonFractionProblem(0.25, 0.6)).toMatch(/^You already got to 60% of this book/)
    expect(abandonFractionProblem(0.6 - 1e-12, 0.6)).toBeNull()
    expect(abandonFractionProblem(0.75, 0.6)).toBeNull()
    expect(abandonFractionProblem(0, null)).toBeNull()
  })

  it('refuses a corrected point past the set-aside fraction', () => {
    expect(pastAbandonProblem(0.6, 0.5)).toBe("You set this book aside at 50%, so an update can't be past that.")
    expect(pastAbandonProblem(0.5, 0.5)).toBeNull()
    expect(pastAbandonProblem(null, 0.5)).toBeNull()
  })
})
