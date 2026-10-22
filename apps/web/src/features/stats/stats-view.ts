import { resolveDateRange, unionRange, type DatePrecision, type EditionFormat, type GoalMetric } from '@mylib/domain'

export interface DailyPoint {
  date: string
  minutes: number
  words: number
  estimated: boolean
}

export interface MonthBucket {
  month: string
  hours: number
  estimatedHours: number
  words: number
  estimatedWords: number
}

const MONTHS_IN_YEAR = 12
const MS_PER_DAY = 86_400_000

export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
export const MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number)
  return [y ?? 0, m ?? 1, d ?? 1]
}

const utc = (date: string): number => Date.parse(`${date}T00:00:00Z`)
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()
const isLeap = (year: number): boolean => daysInMonth(year, 2) === 29
export const daysInYear = (year: number): number => (isLeap(year) ? 366 : 365)
/** 0-based day of the year of an ISO date. */
export const dayOfYear = (date: string): number => Math.round((utc(date) - Date.UTC(parts(date)[0], 0, 1)) / MS_PER_DAY)

/** "Mar 4" (with the year appended when `withYear`). */
export function shortDate(date: string, withYear = false): string {
  const [y, m, d] = parts(date)
  return `${MONTH_SHORT[m - 1]} ${d}${withYear ? `, ${y}` : ''}`
}

/** "Tue, Mar 4" */
export function weekdayDate(date: string): string {
  return `${WEEKDAY_SHORT[new Date(utc(date)).getUTCDay()]}, ${shortDate(date)}`
}

export function bucketByMonth(daily: readonly DailyPoint[], year: number): MonthBucket[] {
  const buckets: MonthBucket[] = Array.from({ length: MONTHS_IN_YEAR }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, '0')}`,
    hours: 0,
    estimatedHours: 0,
    words: 0,
    estimatedWords: 0,
  }))
  for (const d of daily) {
    if (!d.date.startsWith(`${year}-`)) continue
    const bucket = buckets[Number(d.date.slice(5, 7)) - 1]
    if (!bucket) continue
    const hours = d.minutes / 60
    bucket.hours += hours
    bucket.words += d.words
    if (d.estimated) {
      bucket.estimatedHours += hours
      bucket.estimatedWords += d.words
    }
  }
  return buckets
}

export interface HeatmapDay {
  date: string
  level: 0 | 1 | 2 | 3 | 4
  minutes: number
  words: number
  /** after `today`: drawn as an empty slot, not as "no reading" */
  future: boolean
}

function activityScore(d: DailyPoint): number {
  return d.minutes + d.words / 200
}

/** Every day of `year`, with a 0–4 activity level relative to that year's own busiest days. */
export function buildHeatmap(daily: readonly DailyPoint[], year: number, today?: string): HeatmapDay[] {
  // one day can have a read row and a listen row: sum them
  const byDate = new Map<string, { score: number; minutes: number; words: number }>()
  for (const d of daily) {
    if (!d.date.startsWith(`${year}-`)) continue
    const day = byDate.get(d.date) ?? { score: 0, minutes: 0, words: 0 }
    byDate.set(d.date, { score: day.score + activityScore(d), minutes: day.minutes + d.minutes, words: day.words + d.words })
  }
  const scores = [...byDate.values()].map((d) => d.score).filter((s) => s > 0).sort((a, b) => a - b)
  const thresholdAt = (p: number): number => scores[Math.floor(p * (scores.length - 1))] ?? 0
  const [q1, q2, q3] = [thresholdAt(0.25), thresholdAt(0.5), thresholdAt(0.75)]

  function levelFor(score: number): HeatmapDay['level'] {
    if (score <= 0) return 0
    if (score <= q1) return 1
    if (score <= q2) return 2
    if (score <= q3) return 3
    return 4
  }

  const days: HeatmapDay[] = []
  const start = Date.UTC(year, 0, 1)
  const end = Date.UTC(year, 11, 31)
  for (let t = start; t <= end; t += MS_PER_DAY) {
    const date = new Date(t).toISOString().slice(0, 10)
    const day = byDate.get(date)
    days.push({
      date,
      level: levelFor(day?.score ?? 0),
      minutes: day?.minutes ?? 0,
      words: day?.words ?? 0,
      future: today !== undefined && date > today,
    })
  }
  return days
}

/** A goal period in words: "2026" for a calendar year, "October 2026" for a calendar month, else a date range. */
export function periodLabel(start: string, end: string): string {
  const [sy, sm, sd] = parts(start)
  const [ey, em, ed] = parts(end)
  if (sy === ey && sm === 1 && sd === 1 && em === 12 && ed === 31) return String(sy)
  if (sy === ey && sm === em && sd === 1 && ed === daysInMonth(ey, em)) return `${MONTH_LONG[sm - 1]} ${sy}`
  if (sy === ey && sm === em) return `${MONTH_SHORT[sm - 1]} ${sd}–${ed}, ${sy}`
  if (sy === ey) return `${shortDate(start)} – ${shortDate(end)}, ${sy}`
  return `${shortDate(start, true)} – ${shortDate(end, true)}`
}

/** What a goal period is called in pacing text: "the year", "October", or "the period". */
export function periodNoun(start: string, end: string): string {
  const label = periodLabel(start, end)
  if (/^\d{4}$/.test(label)) return 'the year'
  const month = MONTH_LONG.find((m) => label === `${m} ${parts(start)[0]}`)
  return month ?? 'the period'
}

const metricUnit: Record<GoalMetric, string> = { books: 'books', hours: 'hours', words: 'words', pages: 'pages' }

/** "2 of 4 books" — the goal's progress in its own unit. */
export function goalAmountText(metric: GoalMetric, total: number, target: number): string {
  const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
  return `${fmt(total)} of ${fmt(target)} ${metricUnit[metric]}`
}

/** Year navigation: the previous year is always reachable; there is no "next" past the current year. */
export function yearNav(year: number, currentYear: number): { prev: number; next: number | null } {
  return { prev: year - 1, next: year < currentYear ? year + 1 : null }
}

/**
 * The same stretch of the previous year, to compare with: the whole previous year for a past year,
 * Jan 1 – the same month/day for the current year (so a part-year isn't compared with a whole one).
 */
export function comparisonRange(year: number, today: string): { from: string; to: string; partial: boolean } {
  const prev = year - 1
  const [ty, tm, td] = parts(today)
  if (year !== ty) return { from: `${prev}-01-01`, to: `${prev}-12-31`, partial: false }
  const day = Math.min(td, daysInMonth(prev, tm)) // Feb 29 → Feb 28
  return { from: `${prev}-01-01`, to: `${prev}-${String(tm).padStart(2, '0')}-${String(day).padStart(2, '0')}`, partial: true }
}

/** Gridline values from 0 to a clean top at or above `max` (1-2-2.5-5 steps), `count` intervals at most; whole steps for counts. */
export function niceTicks(max: number, count = 3, integer = false): number[] {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude
  const step = integer ? Math.max(1, Math.ceil(nice)) : nice
  const ticks: number[] = []
  for (let v = 0; v < max + step / 2 && ticks.length <= count + 1; v += step) ticks.push(Number(v.toPrecision(12)))
  if ((ticks.at(-1) ?? 0) < max) ticks.push(Number((ticks.length * step).toPrecision(12)))
  return ticks
}

/** 950 → "950", 12_940 → "12.9K", 957_415 → "957K", 1_250_000 → "1.3M". */
export function formatCompact(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  const scaled = (value: number, suffix: string) => {
    const digits = value < 10 ? 1 : 0
    return `${sign}${Number(value.toFixed(digits)).toLocaleString('en-US')}${suffix}`
  }
  if (abs >= 999_500) return scaled(abs / 1_000_000, 'M')
  if (abs >= 1000) return scaled(abs / 1000, 'K')
  return `${sign}${Math.round(abs).toLocaleString('en-US')}`
}

/** Hours with one decimal below 10 (0.5, 2.3), whole above (12, 140). */
export function formatHours(h: number): string {
  if (h === 0) return '0'
  return h < 10 ? String(Number(h.toFixed(1))) : Math.round(h).toLocaleString('en-US')
}

export type StatFormat = EditionFormat | 'unspecified'
export const statFormats = ['physical', 'ebook', 'audiobook', 'unspecified'] as const satisfies readonly StatFormat[]

export interface FinishedBookLike {
  sessionId: string
  workId: string
  title: string
  authors: string[]
  coverAssetId: string | null
  rating: number | null
  format: StatFormat
  mode: 'read' | 'listen'
  startedOn: string
  startedPrecision: DatePrecision
  finishedOn: string
  finishedPrecision: DatePrecision
  isReread: boolean
  pageCount: number | null
  durationSec: number | null
}

/** A finish as precisely as it is known: "Mar 4", "Mar" (a month), "2026" (a year), or "Date unknown". */
export function finishLabel(date: string, precision: DatePrecision): string {
  switch (precision) {
    case 'day':
      return shortDate(date)
    case 'month':
      return MONTH_SHORT[parts(date)[1] - 1] ?? ''
    case 'year':
      return String(parts(date)[0])
    case 'unknown':
      return 'Date unknown'
  }
}

/** A start as precisely as it is known, with its year when `withYear` (it began in an earlier year). */
function startLabel(date: string, precision: DatePrecision, withYear: boolean): string {
  if (precision === 'day') return shortDate(date, withYear)
  if (precision === 'month' && withYear) return `${finishLabel(date, 'month')} ${parts(date)[0]}`
  return precision === 'unknown' ? '?' : finishLabel(date, precision)
}

/** A finished book's reading dates, "Mar 1 – Mar 5"; a past read in a month or a year ("Apr", "2026") is said once. */
export function readDatesLabel(book: FinishedBookLike, continued: boolean): string {
  const finish = finishLabel(book.finishedOn, book.finishedPrecision)
  if (book.finishedPrecision !== 'day' && book.startedPrecision === book.finishedPrecision && book.startedOn === book.finishedOn) return finish
  return `${startLabel(book.startedOn, book.startedPrecision, continued)} – ${finish}`
}

/** Books finished per month of `year`, split by format. A finish known only by its year has no month and is left out. */
export function booksByMonth(books: readonly FinishedBookLike[], year: number): Record<StatFormat, number>[] {
  const months = Array.from({ length: MONTHS_IN_YEAR }, () => ({ physical: 0, ebook: 0, audiobook: 0, unspecified: 0 }))
  for (const b of books) {
    if (b.finishedPrecision === 'year') continue
    const [y, m] = parts(b.finishedOn)
    const month = months[m - 1]
    if (y === year && month) month[b.format] += 1
  }
  return months
}

/** The month with the most books finished (reading volume breaks ties), or null when the year is empty. */
export function biggestMonth(months: readonly MonthBucket[], books: readonly Record<StatFormat, number>[]): number | null {
  let best: number | null = null
  let bestKey: [number, number] = [0, 0]
  months.forEach((m, i) => {
    const counts = books[i]
    const n = counts ? statFormats.reduce((sum, f) => sum + counts[f], 0) : 0
    const volume = m.hours * 60 + m.words / 200
    if (n === 0 && volume === 0) return
    if (best === null || n > bestKey[0] || (n === bestKey[0] && volume > bestKey[1])) {
      best = i
      bestKey = [n, volume]
    }
  })
  return best
}

export interface Highlights {
  longest: { book: FinishedBookLike; text: string } | null
  quickest: { book: FinishedBookLike; days: number } | null
  topAuthor: { name: string; count: number } | null
  first: FinishedBookLike | null
  rereads: number
  rating: { average: number; count: number; bins: number[] } | null
}

const WORDS_PER_PAGE = 275
const WORDS_PER_AUDIO_HOUR = 9300 // ~155 wpm narration: only to rank a long audiobook against a long print book

/** Personal facts for the year from the books finished in it. Each is null/0 when there's nothing honest to say. */
export function computeHighlights(books: readonly FinishedBookLike[]): Highlights {
  let longest: Highlights['longest'] = null
  let longestWords = 0
  let quickest: Highlights['quickest'] = null
  const authorCounts = new Map<string, number>()
  const ratedWorks = new Map<string, number>()
  for (const b of books) {
    const words =
      b.mode === 'listen' && b.durationSec !== null
        ? (b.durationSec / 3600) * WORDS_PER_AUDIO_HOUR
        : b.pageCount !== null
          ? b.pageCount * WORDS_PER_PAGE
          : 0
    if (words > longestWords) {
      longestWords = words
      const text =
        b.mode === 'listen' && b.durationSec !== null
          ? `${formatHours(b.durationSec / 3600)} hours of audio`
          : `${(b.pageCount ?? 0).toLocaleString('en-US')} pages`
      longest = { book: b, text }
    }
    if (b.startedPrecision === 'day' && b.finishedPrecision === 'day') {
      const days = Math.round((utc(b.finishedOn) - utc(b.startedOn)) / MS_PER_DAY) + 1
      if (days >= 1 && (quickest === null || days < quickest.days)) quickest = { book: b, days }
    }
    for (const a of new Set(b.authors)) authorCounts.set(a, (authorCounts.get(a) ?? 0) + 1)
    if (b.rating !== null) ratedWorks.set(b.workId, b.rating)
  }
  let topAuthor: Highlights['topAuthor'] = null
  for (const [name, count] of authorCounts) {
    if (count >= 2 && (topAuthor === null || count > topAuthor.count)) topAuthor = { name, count }
  }
  const ratings = [...ratedWorks.values()]
  const bins = [0, 0, 0, 0, 0] // 1★ (≤1.5) … 5★
  for (const r of ratings) {
    const i = Math.min(4, Math.max(0, Math.floor(r) - 1))
    bins[i] = (bins[i] ?? 0) + 1
  }
  return {
    longest,
    quickest,
    topAuthor,
    // a year-only finish is stored on Jan 1, which says nothing about being first
    first: books.reduce<FinishedBookLike | null>((a, b) => (b.finishedPrecision !== 'year' && (a === null || b.finishedOn < a.finishedOn) ? b : a), null),
    rereads: books.filter((b) => b.isReread).length,
    rating: ratings.length === 0 ? null : { average: ratings.reduce((s, r) => s + r, 0) / ratings.length, count: ratings.length, bins },
  }
}

export interface TimelineBar {
  book: FinishedBookLike
  /** fractions of the year, 0–1 */
  start: number
  end: number
  /** dates were imprecise (month/year/unknown): the span is approximate */
  estimated: boolean
  /** started before the year */
  continued: boolean
  lane: number
  labelSide: 'end' | 'start'
}

/** Each finished book as a bar across the span of days its session covers, clamped to `year`. */
export function timelineSpans(books: readonly FinishedBookLike[], year: number): Omit<TimelineBar, 'lane' | 'labelSide'>[] {
  const total = daysInYear(year)
  return books.flatMap((book) => {
    const range = unionRange(resolveDateRange(book.startedOn, book.startedPrecision), resolveDateRange(book.finishedOn, book.finishedPrecision))
    const from = range.from < `${year}-01-01` ? `${year}-01-01` : range.from
    const to = range.to > `${year}-12-31` ? `${year}-12-31` : range.to
    if (from > to) return []
    return [{ book, start: dayOfYear(from) / total, end: (dayOfYear(to) + 1) / total, estimated: range.estimated, continued: range.from < from }]
  })
}

/** Phones: one row per book instead of the packed lanes, latest finish first. */
export function timelineRows(books: readonly FinishedBookLike[], year: number): Omit<TimelineBar, 'lane' | 'labelSide'>[] {
  return timelineSpans(books, year).sort((a, b) => b.end - a.end || b.start - a.start)
}

/**
 * Packs bars into the fewest lanes so that no two bars — nor their labels — overlap. `labelWidth(bar)` is the
 * label's width as a fraction of the plot; a label goes after the bar, or before it when it would run off the end.
 */
export function packTimeline(
  spans: readonly Omit<TimelineBar, 'lane' | 'labelSide'>[],
  labelWidth: (bar: Omit<TimelineBar, 'lane' | 'labelSide'>) => number,
  gap = 0.01,
): { bars: TimelineBar[]; lanes: number } {
  const laneEnds: number[] = []
  const placed = [...spans]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((s): TimelineBar => {
      const label = labelWidth(s)
      const labelSide = s.end + gap + label <= 1 ? 'end' : 'start'
      const from = labelSide === 'start' ? s.start - gap - label : s.start
      const to = labelSide === 'end' ? s.end + gap + label : s.end
      let lane = laneEnds.findIndex((end) => end + gap <= from)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(to)
      } else {
        laneEnds[lane] = to
      }
      return { ...s, lane, labelSide }
    })
  return { bars: placed, lanes: laneEnds.length }
}
