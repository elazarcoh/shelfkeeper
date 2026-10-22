import { z } from 'zod'
import { ProgressKind, type DatePrecision, type EditionFormat, type SessionMode } from './enums'
import {
  addDaysIso,
  CLIENT_TODAY_TOLERANCE_DAYS,
  computeSessionAmount,
  datesInRange,
  isDatedPrecision,
  resolveDateRange,
  type DailyAmount,
  type DateRange,
  type WordCountSource,
} from './sessions'
import type { VolumeContext } from './volume-progress'

/** Same bounds as an edition's pageCount / durationSec (catalog.ts). */
export const MAX_PAGE = 100_000
export const MAX_SECONDS = 1_000_000

function valueProblem(kind: ProgressKind, value: number): string | null {
  switch (kind) {
    case 'page':
      return Number.isInteger(value) && value <= MAX_PAGE ? null : 'A page is a whole number up to 100,000'
    case 'seconds':
      if (!Number.isInteger(value)) return 'Use whole seconds'
      return value <= MAX_SECONDS ? null : 'That time is too long'
    case 'percent':
      return value <= 100 ? null : 'A percentage is between 0 and 100'
  }
}

function checkValue(p: { kind: ProgressKind; value: number }, ctx: z.RefinementCtx): void {
  const problem = valueProblem(p.kind, p.value)
  if (problem !== null) ctx.addIssue({ code: 'custom', path: ['value'], message: problem })
}

export const AddProgressInput = z
  .object({
    sessionId: z.uuid(),
    /** the client's local date: the date checks use it, and `on` defaults to it */
    today: z.iso.date(),
    on: z.iso.date().optional(),
    kind: ProgressKind,
    value: z.number().min(0),
    /** the one-time "of how many pages / how long" answer: pages for `page`, seconds for `seconds` */
    editionLength: z.number().int().positive().max(MAX_SECONDS).optional(),
    /** another volume of the session's book (#69); absent: the session's current edition */
    editionId: z.uuid().optional(),
  })
  .superRefine((p, ctx) => {
    checkValue(p, ctx)
    if (p.kind === 'percent' && p.editionLength !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['editionLength'], message: 'A percentage needs no page count or length' })
    }
    if (p.kind === 'page' && p.editionLength !== undefined && p.editionLength > MAX_PAGE) {
      ctx.addIssue({ code: 'custom', path: ['editionLength'], message: 'A book has at most 100,000 pages' })
    }
  })
export type AddProgressInput = z.output<typeof AddProgressInput>

export const UpdateProgressInput = z
  .object({
    pointId: z.uuid(),
    today: z.iso.date(),
    on: z.iso.date(),
    kind: ProgressKind,
    value: z.number().min(0),
    /** move the point to another volume of the session's book (#69); absent: it keeps its own */
    editionId: z.uuid().optional(),
  })
  .superRefine(checkValue)
export type UpdateProgressInput = z.output<typeof UpdateProgressInput>

export const ProgressPointRef = z.object({ pointId: z.uuid() })
export type ProgressPointRef = z.output<typeof ProgressPointRef>

/** Spec §2: physical → page; ebook → page | percent; audiobook → seconds | percent (#31: players often show only a %); no edition → percent. */
export function allowedProgressKinds(format: EditionFormat | null): ProgressKind[] {
  switch (format) {
    case 'physical':
      return ['page']
    case 'ebook':
      return ['page', 'percent']
    case 'audiobook':
      return ['seconds', 'percent']
    case null:
      return ['percent']
  }
}

export function progressKindProblem(kind: ProgressKind, format: EditionFormat | null): string | null {
  if (allowedProgressKinds(format).includes(kind)) return null
  switch (format) {
    case 'physical':
      return 'Progress in a printed book is a page number'
    case 'ebook':
      return 'Progress in an ebook is a page or a percentage'
    case 'audiobook':
      return 'Progress in an audiobook is a time or a percentage'
    case null:
      return 'Without an edition, progress is a percentage'
  }
}

export interface EditionLength {
  pageCount: number | null
  durationSec: number | null
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** A length is usable only when it is a positive number; null or a stored 0 counts as missing. */
const usableLength = (n: number | null): n is number => n !== null && n > 0

/** Derived, never stored (spec §2): page ÷ pageCount, seconds ÷ durationSec, percent ÷ 100, capped to [0, 1]. */
export function progressFraction(kind: ProgressKind, value: number, length: EditionLength): number | null {
  switch (kind) {
    case 'percent':
      return clamp01(value / 100)
    case 'page':
      return usableLength(length.pageCount) ? clamp01(value / length.pageCount) : null
    case 'seconds':
      return usableLength(length.durationSec) ? clamp01(value / length.durationSec) : null
  }
}

/** Seconds as "h:mm:ss", like "9:45:00". */
export function formatClock(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.round(sec % 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * A page past the edition's page count, or a time past its length, when that length is known (the last page and the
 * full length are fine; a percentage has its own cap of 100). Refused because the high-water mark would otherwise turn
 * one typo into the whole book read on one day. A reader whose copy really is longer fixes the length on the book page.
 */
export function progressPastEndProblem(kind: ProgressKind, value: number, length: EditionLength): string | null {
  if (kind === 'page' && usableLength(length.pageCount) && value > length.pageCount) {
    return `This edition has ${length.pageCount.toLocaleString('en-US')} pages. If yours has more, update the page count on the book page.`
  }
  if (kind === 'seconds' && usableLength(length.durationSec) && value > length.durationSec) {
    return `This edition is ${formatClock(length.durationSec)} long. If yours is longer, update the length on the book page.`
  }
  return null
}

/** A session's high-water mark: the highest fraction among its points, or null when none has one. */
export function highestFraction(points: readonly { kind: ProgressKind; value: number }[], length: EditionLength): number | null {
  let highest: number | null = null
  for (const p of points) {
    const fraction = progressFraction(p.kind, p.value, length)
    if (fraction !== null && (highest === null || fraction > highest)) highest = fraction
  }
  return highest
}

// a fraction computed on the client from the same numbers compares equal; this only absorbs float noise
const FRACTION_EPSILON = 1e-9

/** False when `fraction` is below the high-water mark (#7, option C: an abandon never says less than was read). */
export function atLeastHighWater(fraction: number, highest: number | null): boolean {
  return highest === null || fraction >= highest - FRACTION_EPSILON
}

/**
 * #7 (option C): an abandoned session's fraction can't be below its highest point, so the session and the stats (which
 * keep the high-water mark) say the same. A mistaken high point is fixed by editing or removing it first.
 */
export function abandonFractionProblem(fraction: number, highest: number | null): string | null {
  if (atLeastHighWater(fraction, highest) || highest === null) return null
  return `You already got to ${Math.round(highest * 100)}% of this book. Pick at least that, or first edit that progress update on the book page.`
}

/** #7: on a set-aside read, a corrected point can't go past the fraction it was set aside at. */
export function pastAbandonProblem(fraction: number | null, abandonedAt: number): string | null {
  if (fraction === null || fraction <= abandonedAt + FRACTION_EPSILON) return null
  return `You set this book aside at ${Math.round(abandonedAt * 100)}%, so an update can't be past that.`
}

/** The edition field the entry form asks for (once) before a point of this kind can have a fraction. */
export function missingLength(kind: ProgressKind, length: EditionLength): 'pageCount' | 'durationSec' | null {
  if (kind === 'page' && !usableLength(length.pageCount)) return 'pageCount'
  if (kind === 'seconds' && !usableLength(length.durationSec)) return 'durationSec'
  return null
}

/** Spec §3: `on` is ≥ the start's earliest day and ≤ today; for a completed session also ≤ the end of its finish range. */
export function progressDateProblem(on: string, today: string, started: DateRange, finished: DateRange | null): string | null {
  if (on > today) return 'That date is in the future'
  if (on < started.from) return 'That date is before you started this book'
  // neutral: a completed session may have been finished or abandoned
  if (finished !== null && on > finished.to) return 'That date is after this read ended'
  return null
}

/**
 * The server never computes today (the client's local date is the truth), but it refuses a client "today" more than
 * two days from its own UTC date, so a wrong device clock cannot date points far in the future or past.
 */
export function clientTodayProblem(clientToday: string, serverUtcDate: string): string | null {
  const earliest = addDaysIso(serverUtcDate, -CLIENT_TODAY_TOLERANCE_DAYS)
  const latest = addDaysIso(serverUtcDate, CLIENT_TODAY_TOLERANCE_DAYS)
  return clientToday < earliest || clientToday > latest ? "Your device's date looks wrong. Check its date and try again" : null
}

export interface ProgressPointView {
  id: string
  sessionId: string
  on: string
  kind: ProgressKind
  value: number
  /** the edition the point was logged on; null when it is unknown (a point from before editions were recorded) */
  editionId: string | null
  /** that edition's volume number, null outside a volume set */
  volume: number | null
  /** the share of the whole book (#66); null while the edition has no length for this kind */
  fraction: number | null
}

/** What the check-in card and the book page need to offer and describe progress for one session. */
export interface SessionProgressInfo {
  editionFormat: EditionFormat | null
  pageCount: number | null
  durationSec: number | null
  latest: ProgressPointView | null
  pointCount: number
  /** the high-water mark: the highest book fraction among the session's points (#7: an abandon can't go below it) */
  highest: number | null
  /** the current edition's place in its volume set; `waiting`: on volume k < N, volume k+1 not in the catalog, latest point at the end of volume k */
  volume: (VolumeContext & { waiting: boolean }) | null
}

/** Home "Currently reading": a work's latest fraction among this user's in-progress sessions. */
export interface CurrentProgress {
  workId: string
  sessionId: string
  on: string
  fraction: number
}

export interface ProgressCheckpoint {
  on: string
  fraction: number
}

export interface ProgressSessionForStats {
  mode: SessionMode
  startedOn: string
  startedPrecision: DatePrecision
  /** null while in progress */
  end: { on: string; precision: DatePrecision; fraction: number } | null
  /** only points that have a fraction; any order */
  checkpoints: readonly ProgressCheckpoint[]
  durationSec: number | null
  durationEstimated?: boolean | undefined
  wordCountSource: WordCountSource
}

const later = (a: string, b: string) => (a > b ? a : b)

function orderedCheckpoints(s: ProgressSessionForStats, startDay: string): ProgressCheckpoint[] {
  return s.checkpoints
    .map((c) => ({ on: later(c.on, startDay), fraction: clamp01(c.fraction) }))
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0))
}

/** The session's end when its date is known; an end on an unknown date has no day to put its rest on (points only). */
function datedEnd(s: ProgressSessionForStats): ProgressSessionForStats['end'] {
  return s.end !== null && isDatedPrecision(s.end.precision) ? s.end : null
}

/** The days a session with checkpoints contributes to: its earliest start day through its last point or finish range end. */
export function progressStatsSpan(s: ProgressSessionForStats): { from: string; to: string } | null {
  if (s.checkpoints.length === 0) return null
  const from = resolveDateRange(s.startedOn, s.startedPrecision).from
  let to = s.checkpoints.reduce((max, c) => later(max, c.on), from)
  const end = datedEnd(s)
  if (end !== null) to = later(to, resolveDateRange(end.on, end.precision).to)
  return { from, to }
}

/**
 * Spec §4: checkpoints (start, 0), each point, and the end (finish → 1, abandon → its fraction, nothing while in
 * progress). Each segment counts only the progress past the highest fraction reached so far,
 * `max(0, f − highSoFar) × total`, so a lower point (a typo, re-reading) adds nothing until progress passes the earlier
 * high and a session never totals more than the whole book. That amount spreads evenly over (d₁, d₂]; the first over
 * [start, d₁]; a pair whose later date is not after the earlier one puts its amount on the earlier checkpoint's day.
 * An end on an unknown date adds nothing: the session counts its points' days only. Never throws.
 */
export function spreadProgressStats(s: ProgressSessionForStats): DailyAmount[] {
  if (s.checkpoints.length === 0) return []
  const total = computeSessionAmount(s.mode, 1, s.durationSec, s.wordCountSource, s.durationEstimated ?? false)
  const started = resolveDateRange(s.startedOn, s.startedPrecision)
  const end = datedEnd(s)
  const finished = end === null ? null : resolveDateRange(end.on, end.precision)
  // session-level, like spreadSessionStats: imprecise dates or a page-estimated word count
  const estimated = total.estimated || started.estimated || (finished?.estimated ?? false)

  const marks = orderedCheckpoints(s, started.from)
  if (end !== null && finished !== null) marks.push({ on: finished.to, fraction: clamp01(end.fraction) })

  const byDate = new Map<string, { minutes: number; words: number }>()
  let previous: ProgressCheckpoint | null = null
  let high = 0
  for (const mark of marks) {
    const share = Math.max(0, mark.fraction - high)
    if (share > 0) {
      const days =
        previous === null
          ? datesInRange(started.from, mark.on)
          : mark.on > previous.on
            ? datesInRange(addDaysIso(previous.on, 1), mark.on)
            : [previous.on]
      for (const date of days) {
        const current = byDate.get(date) ?? { minutes: 0, words: 0 }
        byDate.set(date, {
          minutes: current.minutes + (total.minutes * share) / days.length,
          words: current.words + (total.words * share) / days.length,
        })
      }
      high = mark.fraction
    }
    previous = mark
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, v]) => ({ date, minutes: v.minutes, words: v.words, estimated }))
}
