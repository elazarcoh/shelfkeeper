import {
  allowedProgressKinds,
  atLeastHighWater,
  formatClock,
  MAX_PAGE,
  MAX_SECONDS,
  missingLength,
  bookFraction,
  progressPastEndProblem,
  resolveDateRange,
  volumeLabel,
  volumeSets,
  type DatePrecision,
  type EditionFormat,
  type ProgressKind,
  type ProgressPointView,
  type SessionProgressInfo,
} from '@mylib/domain'

/** The progress field's raw text, kept as typed until it is read. */
export interface ProgressDraft {
  kind: ProgressKind
  value: string
  /** the one-time "of how many pages / how long" answer */
  length: string
}

export type DraftErrors = { value?: string | undefined; length?: string | undefined }

export type ParsedDraft =
  | { ok: true; point: null }
  | { ok: true; point: { kind: ProgressKind; value: number; editionLength?: number } }
  | { ok: false; field: 'value' | 'length'; error: string }

export function initialDraft(info: SessionProgressInfo): ProgressDraft {
  const allowed = allowedProgressKinds(info.editionFormat)
  const last = info.latest?.kind
  const kind =
    last !== undefined && allowed.includes(last) ? last : info.editionFormat === 'ebook' && info.pageCount === null ? 'percent' : (allowed[0] ?? 'percent')
  return { kind, value: '', length: '' }
}

/** One volume the update can be entered against (#69). */
export interface VolumeOption {
  id: string
  volume: number
  label: string
  pageCount: number | null
  durationSec: number | null
}

interface CatalogEdition {
  id: string
  format: EditionFormat
  language: string | null
  volume: number | null
  volumeCount: number | null
  pageCount: number | null
  durationSec: number | null
}

/** The Volume field's data: the set's volumes, and the volume the session is on. */
export interface VolumeChoice {
  options: VolumeOption[]
  sessionEditionId: string
}

/** The volumes of the session edition's set, or null unless the catalog has two or more of them (no Volume field). */
export function volumeOptions(editions: readonly CatalogEdition[], sessionEditionId: string | null): VolumeOption[] | null {
  const set = volumeSets(editions).find((s) => s.members.some((m) => m.id === sessionEditionId))
  if (set === undefined || set.members.length < 2) return null
  return set.members.map((m) => ({
    id: m.id,
    volume: m.volume ?? 0,
    label: volumeLabel(m.volume, set.size) ?? '',
    pageCount: m.pageCount,
    durationSec: m.durationSec,
  }))
}

/** The Volume select's start: the session's current volume for a new update, the point's own when editing ('' when it has none in the set). */
export function initialVolume(options: readonly VolumeOption[], sessionEditionId: string | null, point?: Pick<ProgressPointView, 'editionId'>): string {
  const wanted = point === undefined ? sessionEditionId : point.editionId
  return wanted !== null && options.some((o) => o.id === wanted) ? wanted : ''
}

/** The session info as read in the chosen volume: its lengths and place, so the checks and the length prompt follow it. */
export function infoForVolume(info: SessionProgressInfo, options: readonly VolumeOption[], editionId: string): SessionProgressInfo {
  const option = options.find((o) => o.id === editionId)
  if (option === undefined) return info
  return {
    ...info,
    pageCount: option.pageCount,
    durationSec: option.durationSec,
    volume: info.volume === null ? null : { ...info.volume, volume: option.volume },
  }
}

/** "5:30" (h:mm) or "5:30:15" (h:mm:ss) → seconds; anything else → null. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(text.trim())
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)
}

// shared with the server's "past the end" message
export { formatClock }

export function draftFromPoint(point: ProgressPointView): ProgressDraft {
  return { kind: point.kind, value: point.kind === 'seconds' ? formatClock(point.value) : String(point.value), length: '' }
}

const VALUE_HELP: Record<ProgressKind, string> = {
  page: 'Enter a page number, like 120',
  seconds: 'Enter a time like 5:30 or 5:30:15',
  percent: 'Enter a percentage from 0 to 100',
}

function readValue(kind: ProgressKind, text: string): number | null {
  switch (kind) {
    case 'page':
      // a page starts at 1
      return /^[1-9]\d*$/.test(text) && Number(text) <= MAX_PAGE ? Number(text) : null
    case 'seconds': {
      const sec = parseClock(text)
      return sec !== null && sec <= MAX_SECONDS ? sec : null
    }
    case 'percent': {
      const m = /^(\d{1,3}(?:\.\d+)?)\s*%?$/.exec(text)
      return m && Number(m[1]) <= 100 ? Number(m[1]) : null
    }
  }
}

/** Which length the form must ask for once (only for a session with an edition). */
export function lengthPrompt(draft: ProgressDraft, info: SessionProgressInfo): 'pageCount' | 'durationSec' | null {
  return info.editionFormat === null ? null : missingLength(draft.kind, info)
}

/** `askLength` false (editing an existing point): the length answer is neither shown nor sent. */
export function readDraft(draft: ProgressDraft, info: SessionProgressInfo, askLength = true): ParsedDraft {
  const text = draft.value.trim()
  if (text === '') return { ok: true, point: null }
  const value = readValue(draft.kind, text)
  if (value === null) return { ok: false, field: 'value', error: VALUE_HELP[draft.kind] }
  // the server's check too: past a known length, the high-water mark would book the whole book on one day
  const pastEnd = progressPastEndProblem(draft.kind, value, info)
  if (pastEnd !== null) return { ok: false, field: 'value', error: pastEnd }
  const prompt = askLength ? lengthPrompt(draft, info) : null
  const lengthText = draft.length.trim()
  if (prompt === null || lengthText === '') return { ok: true, point: { kind: draft.kind, value } }
  const editionLength =
    prompt === 'pageCount' ? (/^\d+$/.test(lengthText) && Number(lengthText) > 0 && Number(lengthText) <= MAX_PAGE ? Number(lengthText) : null) : parseClock(lengthText)
  if (editionLength === null || editionLength <= 0) {
    return { ok: false, field: 'length', error: prompt === 'pageCount' ? 'Enter the number of pages, like 320' : 'Enter a length like 9:45' }
  }
  // the server's limit (AddProgressInput), checked here so its raw validation text never reaches the reader
  if (editionLength > MAX_SECONDS) return { ok: false, field: 'length', error: `That is too long. The longest is ${formatClock(MAX_SECONDS)}` }
  if (value > editionLength) {
    const said = prompt === 'pageCount' ? `it has ${editionLength.toLocaleString('en-US')} pages` : `it is ${formatClock(editionLength)} long`
    return { ok: false, field: 'value', error: `That is past the end: you said ${said}. Check both numbers.` }
  }
  return { ok: true, point: { kind: draft.kind, value, editionLength } }
}

export function draftErrorsFor(parsed: ParsedDraft): DraftErrors {
  if (parsed.ok) return {}
  return parsed.field === 'value' ? { value: parsed.error } : { length: parsed.error }
}

export function pointLabel(kind: ProgressKind, value: number): string {
  switch (kind) {
    case 'page':
      return `p. ${value}`
    case 'seconds':
      return formatClock(value)
    case 'percent':
      return `${Number(value.toFixed(1))}%`
  }
}

export const percentText = (fraction: number): string => `${Math.round(fraction * 100)}%`

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`)

/** "today", a weekday within the past week, else "Sep 20" (with the year when it differs). */
export function dayLabel(on: string, today: string): string {
  if (on === today) return 'today'
  const days = Math.round((utc(today) - utc(on)) / 86_400_000)
  if (days > 0 && days < 7) return WEEKDAY[new Date(utc(on)).getUTCDay()] ?? on
  return shortDate(on, today)
}

/** "Sep 20", or "Sep 20, 2024" when it is not this year. */
function shortDate(on: string, today: string): string {
  const d = new Date(utc(on))
  const short = `${MONTH[d.getUTCMonth()] ?? ''} ${d.getUTCDate()}`
  return on.slice(0, 4) === today.slice(0, 4) ? short : `${short}, ${on.slice(0, 4)}`
}

/**
 * The kinds the field offers: the edition's, plus (editing) the point's own kind, even when its edition changed or is
 * gone since: the server keeps an unchanged kind without re-checking it (RP11).
 */
export function offeredKinds(format: EditionFormat | null, own?: ProgressKind): ProgressKind[] {
  const allowed = allowedProgressKinds(format)
  return own === undefined || allowed.includes(own) ? allowed : [own, ...allowed]
}

/**
 * "p. 120 on Oct 6" (with the year when it is not this year): names a point for its Edit and Remove buttons (RP3).
 * The row's own month-day order, but always a date: "today" or a weekday would be ambiguous out of context.
 */
export function pointName(point: Pick<ProgressPointView, 'kind' | 'value' | 'on'>, today: string): string {
  return `${pointLabel(point.kind, point.value)} on ${shortDate(point.on, today)}`
}

/** A session's dates: the days a point can be dated on (a SessionView fits as is). */
export interface SessionDates {
  startedOn: string
  startedPrecision: DatePrecision
  finishedOn: string | null
  finishedPrecision: DatePrecision | null
}

/** The date field's range, as the server checks it: the start's earliest day through today, and for a finished read no later than its end. */
export function progressDayBounds(s: SessionDates, today: string): { min: string; max: string } {
  const min = resolveDateRange(s.startedOn, s.startedPrecision).from
  const end = s.finishedOn === null ? null : resolveDateRange(s.finishedOn, s.finishedPrecision ?? 'day').to
  return { min, max: end !== null && end < today ? end : today }
}

/** "last: p. 180, Tue" */
export function describeLatest(point: ProgressPointView, today: string): string {
  return `last: ${pointLabel(point.kind, point.value)}, ${dayLabel(point.on, today)}`
}

/** "Still going", or "Still going · p. 560" once a value is entered. */
export function stillGoingLabel(parsed: ParsedDraft): string {
  return parsed.ok && parsed.point !== null ? `Still going · ${pointLabel(parsed.point.kind, parsed.point.value)}` : 'Still going'
}

/**
 * The Abandoned card's choice. 'default' means untouched: it follows "where I stopped" as it is when Save is clicked
 * (a point added on the book page after the card mounted counts), so it is "where I stopped" when there is one and
 * "Not sure" otherwise, exactly as before progress existed.
 */
export type AbandonChoice = 'default' | 'stopped' | 'unsure' | number

type PointInput = { kind: ProgressKind; value: number; editionLength?: number }

/** A typed point's fraction, from the edition's length or the one-time answer typed with it. */
function typedFraction(typed: PointInput, info: SessionProgressInfo): number | null {
  const answer = typed.editionLength
  const length = {
    pageCount: typed.kind === 'page' && answer !== undefined ? answer : info.pageCount,
    durationSec: typed.kind === 'seconds' && answer !== undefined ? answer : info.durationSec,
  }
  return bookFraction(typed.kind, typed.value, length, info.volume)
}

/**
 * A soft, non-blocking note when a new value is below the session's latest point (same kind: by value; otherwise by
 * fraction, when both have one). A correction is fine; the note only says it was noticed.
 */
export function lowerThanLatestNote(parsed: ParsedDraft, info: SessionProgressInfo): string | null {
  const latest = info.latest
  if (!parsed.ok || parsed.point === null || latest === null) return null
  const typed = parsed.point
  let lower: boolean
  // in a volume set the values may be in different volumes: only book fractions compare
  if (typed.kind === latest.kind && info.volume === null) lower = typed.value < latest.value
  else {
    const fraction = typedFraction(typed, info)
    lower = fraction !== null && latest.fraction !== null && fraction < latest.fraction
  }
  return lower ? `Lower than your last update (${pointLabel(latest.kind, latest.value)}). If that one was a typo, edit it on the book page.` : null
}

/** "Where I stopped": the value typed in the check-in field, else the session's saved latest point. */
export interface StoppedPoint {
  kind: ProgressKind
  value: number
  fraction: number | null
  /** the typed point (with its one-time length) to save before abandoning; null for the saved latest point */
  save: PointInput | null
}

/**
 * A readable typed value wins (it is saved, even without a length, and gives the abandon its fraction when the edition's
 * length or the one-time answer allows). Otherwise the saved latest point, offered only when it has a fraction.
 */
export function whereIStopped(parsed: ParsedDraft, info: SessionProgressInfo): StoppedPoint | null {
  if (parsed.ok && parsed.point !== null) {
    const typed = parsed.point
    return { kind: typed.kind, value: typed.value, fraction: typedFraction(typed, info), save: typed }
  }
  const latest = info.latest
  if (latest === null || latest.fraction === null) return null
  return { kind: latest.kind, value: latest.value, fraction: latest.fraction, save: null }
}

/**
 * #7 (option C): an abandon can't say less than the session's highest point (`highest`), so a choice below it is off.
 * #8: a typed value without a fraction (no length) says nothing about how far, so it is not a choice either.
 */
export function abandonChoiceAllowed(choice: 'stopped' | number, stopped: StoppedPoint | null, highest: number | null): boolean {
  if (choice !== 'stopped') return atLeastHighWater(choice, highest)
  return stopped !== null && stopped.fraction !== null && atLeastHighWater(stopped.fraction, highest)
}

/** The button that shows as selected; without a usable "where I stopped" (or a choice since ruled out) it is "Not sure". */
export function selectedAbandonChoice(choice: AbandonChoice, stopped: StoppedPoint | null, highest: number | null): 'stopped' | 'unsure' | number {
  const wanted = choice === 'default' ? 'stopped' : choice
  if (wanted === 'unsure') return 'unsure'
  return abandonChoiceAllowed(wanted, stopped, highest) ? wanted : 'unsure'
}

/**
 * What Save sends: the fractionCompleted (null for "Not sure"), and the typed point to save first. That is "where I
 * stopped"'s point when it is chosen, and a typed point without a fraction whatever is chosen (#8: it is still a real
 * update, it just can't be the abandon's fraction).
 */
export function resolveAbandon(
  choice: AbandonChoice,
  stopped: StoppedPoint | null,
  highest: number | null,
): { fractionCompleted: number | null; save: PointInput | null } {
  const selected = selectedAbandonChoice(choice, stopped, highest)
  if (selected === 'stopped' && stopped !== null) return { fractionCompleted: stopped.fraction, save: stopped.save }
  const save = stopped !== null && stopped.fraction === null ? stopped.save : null
  return { fractionCompleted: typeof selected === 'number' ? selected : null, save }
}

/** The line under the abandon choices: why "where I stopped" is missing (#8), or why low choices are off (#7). */
export function abandonNote(stopped: StoppedPoint | null, highest: number | null, lowestChoice: number): string | null {
  if (stopped !== null && stopped.fraction === null) {
    return `${pointLabel(stopped.kind, stopped.value)} is saved as an update, but without the book's length it can't say how far you got. Pick one.`
  }
  const belowHigh = !atLeastHighWater(lowestChoice, highest) || (stopped !== null && !abandonChoiceAllowed('stopped', stopped, highest))
  if (highest === null || !belowHigh) return null
  return `You already got to ${percentText(highest)}. To pick less, first edit that update on the book page.`
}
