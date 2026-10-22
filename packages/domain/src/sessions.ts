import { z } from 'zod'
import { DatePrecision, SessionMode, type EditionFormat, type ReadingStatus, type SessionOutcome } from './enums'
import { RatingValue } from './tracking'

export const StartSessionInput = z.object({
  workId: z.uuid(),
  editionId: z.uuid().nullable().default(null),
  mode: SessionMode,
  startedOn: z.iso.date(),
  startedPrecision: DatePrecision.default('day'),
})
export type StartSessionInput = z.output<typeof StartSessionInput>

export const CompleteSessionInput = z.object({
  outcome: z.enum(['finished', 'abandoned']),
  finishedOn: z.iso.date(),
  finishedPrecision: DatePrecision.default('day'),
  /** only meaningful when abandoned; ignored (treated as 1) when finished */
  fractionCompleted: z.number().min(0).max(1).nullable().default(null),
})
export type CompleteSessionInput = z.output<typeof CompleteSessionInput>

/** "Finished volume k, on to k+1": `editionId` is the volume the client believes the session is on (double-tap guard). */
export const NextVolumeInput = z.object({
  sessionId: z.uuid(),
  editionId: z.uuid(),
  today: z.iso.date(),
  /** the day the volume was finished (#70); `today` when omitted */
  on: z.iso.date().optional(),
})
export type NextVolumeInput = z.output<typeof NextVolumeInput>

const DEFAULT_ABANDONED_FRACTION = 0.5

/** "Not sure" (no fraction) on an abandon is half the book, or the session's high-water mark when that is higher (#7). */
export function resolveFractionCompleted(outcome: 'finished' | 'abandoned', provided: number | null, highest: number | null = null): number {
  if (outcome === 'finished') return 1
  return provided ?? Math.max(DEFAULT_ABANDONED_FRACTION, highest ?? 0)
}

/** A session is a reread when the user has already finished this work before (spec §4.4: "derived at write time"). */
export function deriveIsReread(priorOutcomes: readonly SessionOutcome[]): boolean {
  return priorOutcomes.includes('finished')
}

/** The reading status a session outcome implies on its own. */
export function statusForSessionOutcome(outcome: SessionOutcome): ReadingStatus {
  switch (outcome) {
    case 'in_progress':
      return 'reading'
    case 'finished':
      return 'read'
    case 'abandoned':
      return 'abandoned'
  }
}

/**
 * The user's status for a work after completing one session, given the outcomes of their other sessions of it:
 * still reading while another is in progress; abandoning a reread of a finished book keeps it read.
 */
export function statusAfterCompletion(outcome: 'finished' | 'abandoned', otherOutcomes: readonly SessionOutcome[]): ReadingStatus {
  if (otherOutcomes.includes('in_progress')) return 'reading'
  if (outcome === 'finished' || otherOutcomes.includes('finished')) return 'read'
  return 'abandoned'
}

export interface WordCountSource {
  editionWordCount: number | null
  /** the best known word count across the work's other editions */
  workWordCount: number | null
  pageCount: number | null
}

export const WORDS_PER_PAGE = 275

export interface ResolvedWordCount {
  words: number
  estimated: boolean
}

/** Fallback chain from spec §4.4: edition -> work-level best known -> pages (estimated) -> none. */
export function resolveWordCount(source: WordCountSource): ResolvedWordCount | null {
  if (source.editionWordCount !== null) return { words: source.editionWordCount, estimated: false }
  if (source.workWordCount !== null) return { words: source.workWordCount, estimated: false }
  if (source.pageCount !== null) return { words: source.pageCount * WORDS_PER_PAGE, estimated: true }
  return null
}

export interface SessionAmount {
  minutes: number
  words: number
  estimated: boolean
}

/** The edition formats a session of this mode can be read from (listen -> audiobook; read -> physical or ebook). */
export function editionFormatsForMode(mode: SessionMode): EditionFormat[] {
  return mode === 'listen' ? ['audiobook'] : ['physical', 'ebook']
}

/**
 * listen -> minutes from duration; read -> words from the fallback chain. Never throws on missing data.
 * `durationEstimated` marks a duration that did not come from the session's own edition (work-level fallback).
 */
export function computeSessionAmount(
  mode: SessionMode,
  fractionCompleted: number,
  durationSec: number | null,
  wordCountSource: WordCountSource,
  durationEstimated = false,
): SessionAmount {
  if (mode === 'listen') {
    if (durationSec === null) return { minutes: 0, words: 0, estimated: false }
    return { minutes: (durationSec * fractionCompleted) / 60, words: 0, estimated: durationEstimated }
  }
  const resolved = resolveWordCount(wordCountSource)
  if (resolved === null) return { minutes: 0, words: 0, estimated: false }
  return { minutes: 0, words: resolved.words * fractionCompleted, estimated: resolved.estimated }
}

export interface DateRange {
  from: string
  to: string
  estimated: boolean
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Resolves an imprecise date to the calendar range it could mean (spec §4.4). */
export function resolveDateRange(on: string, precision: DatePrecision): DateRange {
  const [yearStr, monthStr] = on.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  switch (precision) {
    case 'day':
      return { from: on, to: on, estimated: false }
    case 'unknown':
      return { from: on, to: on, estimated: true }
    case 'month': {
      const last = String(daysInMonth(year, month)).padStart(2, '0')
      return { from: `${yearStr}-${monthStr}-01`, to: `${yearStr}-${monthStr}-${last}`, estimated: true }
    }
    case 'year':
      return { from: `${yearStr}-01-01`, to: `${yearStr}-12-31`, estimated: true }
  }
}

/**
 * Whether a date of this precision can be placed on the calendar. `unknown` ("long ago / don't remember") cannot: it
 * is stored with the day it was entered, but that day says nothing about when the read happened.
 */
export function isDatedPrecision(precision: DatePrecision): boolean {
  return precision !== 'unknown'
}

export interface SessionDates {
  startedOn: string
  startedPrecision: DatePrecision
  finishedOn: string
  finishedPrecision: DatePrecision
}

/**
 * The days a completed session's amounts spread over: the union of its start and finish ranges. Null when its finish
 * date is unknown: such a read counts as read (status, filters, series) but never in a dated stat (daily_stat, the
 * heatmap, monthly charts, yearly totals, goals). An unknown start with a known finish keeps the union, as before.
 */
export function sessionStatsRange(session: SessionDates): DateRange | null {
  if (!isDatedPrecision(session.finishedPrecision)) return null
  return unionRange(resolveDateRange(session.startedOn, session.startedPrecision), resolveDateRange(session.finishedOn, session.finishedPrecision))
}

/**
 * Whether a finish counts among the books finished in `range` (yearly totals, goals, the Stats shelf): its date is
 * known and inside the range. A year-only finish counts only in a range that covers that whole year, so it never lands
 * in a month or in "so far this year" comparisons. An unknown finish never counts. Mirrored in SQL by the stats repo.
 */
export function finishCountsInRange(finishedOn: string, precision: DatePrecision, range: { from: string; to: string }): boolean {
  if (!isDatedPrecision(precision)) return false
  if (precision === 'year') {
    const year = resolveDateRange(finishedOn, 'year')
    return range.from <= year.from && year.to <= range.to
  }
  return range.from <= finishedOn && finishedOn <= range.to
}

/** A finished read recorded after the fact ("Mark as read", spec: one session, start = finish). */
export const MarkFinishedInput = z.object({
  workId: z.uuid(),
  editionId: z.uuid().nullable().default(null),
  mode: SessionMode,
  /** month/year: any day in it; unknown: the client's today (it is never used as a date) */
  finishedOn: z.iso.date(),
  finishedPrecision: DatePrecision,
  /** the optional quick rating, saved with the read in one transaction (null leaves any rating alone) */
  rating: RatingValue.nullable().default(null),
})
export type MarkFinishedInput = z.output<typeof MarkFinishedInput>

/** A past read's dates: it starts and finishes on the same date with the same precision, the start of an imprecise range. */
export function pastReadDates(finishedOn: string, precision: DatePrecision): SessionDates {
  const on = precision === 'month' || precision === 'year' ? resolveDateRange(finishedOn, precision).from : finishedOn
  return { startedOn: on, startedPrecision: precision, finishedOn: on, finishedPrecision: precision }
}

/**
 * "Mark as read"'s dates: pastReadDates, except that a read finished on an exact day has an unknown start. Nobody
 * reads a book in the one day they remember finishing it: as a day → day read it would win "Quickest read: 1 day"
 * and put the whole book on that day as exact data. With an unknown start its words still land on the finish day,
 * estimated. (The CSV import keeps pastReadDates.)
 */
export function markedReadDates(finishedOn: string, precision: DatePrecision): SessionDates {
  const dates = pastReadDates(finishedOn, precision)
  return precision === 'day' ? { ...dates, startedPrecision: 'unknown' } : dates
}

/** How far a client's local "today" may sit from the server's UTC date (time zones span about ±1 day). */
export const CLIENT_TODAY_TOLERANCE_DAYS = 2

/**
 * A start or finish whose range begins after the server's UTC date plus the client-today tolerance (time zones) is in
 * the future. An unknown date is exempt: it is only the day it was entered, never used as a date.
 */
export function futureDateProblem(on: string, precision: DatePrecision, serverUtcDate: string): string | null {
  if (!isDatedPrecision(precision)) return null
  const latest = addDaysIso(serverUtcDate, CLIENT_TODAY_TOLERANCE_DAYS)
  return resolveDateRange(on, precision).from > latest ? 'That date is in the future' : null
}

interface PriorFinish {
  outcome: SessionOutcome
  finishedOn: string | null
  finishedPrecision: DatePrecision | null
}

/**
 * A past read is a reread only when the user has a finish known to be earlier: a dated finish whose range ends before
 * this read's begins. An undated read (either one) has no known order, so it is never taken to follow another.
 */
export function isRereadOfPastRead(prior: readonly PriorFinish[], finishedOn: string, precision: DatePrecision): boolean {
  if (!isDatedPrecision(precision)) return false
  const from = resolveDateRange(finishedOn, precision).from
  return prior.some(
    (p) =>
      p.outcome === 'finished' &&
      p.finishedOn !== null &&
      p.finishedPrecision !== null &&
      isDatedPrecision(p.finishedPrecision) &&
      resolveDateRange(p.finishedOn, p.finishedPrecision).to < from,
  )
}

/** The union of a started-range and a finished-range: earliest start to latest finish (spec: "spreading covers the union range"). */
export function unionRange(started: DateRange, finished: DateRange): DateRange {
  return {
    from: started.from < finished.from ? started.from : finished.from,
    to: started.to > finished.to ? started.to : finished.to,
    estimated: started.estimated || finished.estimated,
  }
}

const MS_PER_DAY = 86_400_000

function parseUtcDate(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

function daysBetweenInclusive(range: DateRange): number {
  return Math.round((parseUtcDate(range.to) - parseUtcDate(range.from)) / MS_PER_DAY) + 1
}

function enumerateDates(range: DateRange): string[] {
  const n = daysBetweenInclusive(range)
  const start = parseUtcDate(range.from)
  return Array.from({ length: n }, (_, i) => new Date(start + i * MS_PER_DAY).toISOString().slice(0, 10))
}

/** Every calendar date from `from` through `to`, inclusive (YYYY-MM-DD, UTC arithmetic). Empty when `to` < `from`. */
export function datesInRange(from: string, to: string): string[] {
  if (to < from) return []
  return enumerateDates({ from, to, estimated: false })
}

/** `date` moved by `days` calendar days (YYYY-MM-DD). */
export function addDaysIso(date: string, days: number): string {
  return new Date(parseUtcDate(date) + days * MS_PER_DAY).toISOString().slice(0, 10)
}

export interface DailyAmount {
  date: string
  minutes: number
  words: number
  estimated: boolean
}

export interface SessionForStats {
  mode: SessionMode
  startedOn: string
  startedPrecision: DatePrecision
  finishedOn: string
  finishedPrecision: DatePrecision
  fractionCompleted: number
  durationSec: number | null
  /** true when durationSec is the work's best-known duration rather than the session's own edition's */
  durationEstimated?: boolean
  wordCountSource: WordCountSource
}

/** The per-day rows a finished/abandoned session contributes to daily_stat: none when its finish date is unknown. Never throws. */
export function spreadSessionStats(session: SessionForStats): DailyAmount[] {
  const range = sessionStatsRange(session)
  if (range === null) return []
  const amount = computeSessionAmount(
    session.mode,
    session.fractionCompleted,
    session.durationSec,
    session.wordCountSource,
    session.durationEstimated ?? false,
  )
  const days = enumerateDates(range)
  const estimated = range.estimated || amount.estimated
  return days.map((date) => ({ date, minutes: amount.minutes / days.length, words: amount.words / days.length, estimated }))
}
