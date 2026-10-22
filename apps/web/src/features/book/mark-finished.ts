import { editionFormatsForMode, sessionModes, type DatePrecision, type EditionFormat, type SessionMode, type SessionOutcome } from '@mylib/domain'

/**
 * The modes "Mark as … " is offered for: those the book's editions can be read in (audiobook → listened; physical or
 * ebook → read; both when both exist), "read" for a book with no edition yet, and never a mode already in progress.
 */
export function markableModes(editions: readonly { format: EditionFormat }[], inProgress: ReadonlySet<SessionMode>): SessionMode[] {
  const readable = (mode: SessionMode) => editions.some((e) => editionFormatsForMode(mode).includes(e.format))
  const modes: SessionMode[] = editions.length === 0 ? ['read'] : sessionModes.filter(readable)
  return modes.filter((m) => !inProgress.has(m))
}

export function markLabel(mode: SessionMode): string {
  return mode === 'listen' ? 'Mark as listened…' : 'Mark as read…'
}

/** The sheet's "When did you finish?" choices. */
export type PastFinishChoice = 'unknown' | 'year' | 'month' | 'day'

export interface PastFinishFields {
  /** "2019" */
  year: string
  /** "2019-03", as an <input type="month"> holds it */
  month: string
  /** "2019-03-14" */
  day: string
}

export type PastFinish = { ok: true; finishedOn: string; finishedPrecision: DatePrecision } | { ok: false; message: string }

/** The finish a choice means. `today` is the client's local date: an unknown date is stored with it, but never used as one. */
export function pastFinish(choice: PastFinishChoice, fields: PastFinishFields, today: string): PastFinish {
  switch (choice) {
    case 'unknown':
      return { ok: true, finishedOn: today, finishedPrecision: 'unknown' }
    case 'year': {
      if (!/^\d{4}$/.test(fields.year)) return { ok: false, message: 'Pick the year you finished' }
      if (fields.year > today.slice(0, 4)) return { ok: false, message: 'That year is in the future' }
      return { ok: true, finishedOn: `${fields.year}-01-01`, finishedPrecision: 'year' }
    }
    case 'month': {
      if (!/^\d{4}-\d{2}$/.test(fields.month)) return { ok: false, message: 'Pick the month you finished' }
      if (fields.month > today.slice(0, 7)) return { ok: false, message: 'That month is in the future' }
      return { ok: true, finishedOn: `${fields.month}-01`, finishedPrecision: 'month' }
    }
    case 'day': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.day)) return { ok: false, message: 'Pick the day you finished' }
      if (fields.day > today) return { ok: false, message: 'That date is in the future' }
      return { ok: true, finishedOn: fields.day, finishedPrecision: 'day' }
    }
  }
}

const outcomeLabel: Record<SessionOutcome, string> = { finished: 'Finished', abandoned: 'Set aside', in_progress: 'In progress' }

/** A date as precise as it is known: "2019-03-14", "2019-03", "2019", or "?" when unknown. */
function atPrecision(on: string, precision: DatePrecision): string {
  switch (precision) {
    case 'day':
      return on
    case 'month':
      return on.slice(0, 7)
    case 'year':
      return on.slice(0, 4)
    case 'unknown':
      return '?'
  }
}

interface PastSessionLike {
  outcome: SessionOutcome
  startedOn: string
  startedPrecision: DatePrecision
  finishedOn: string | null
  finishedPrecision: DatePrecision | null
}

/**
 * A book page session row: its dates as precise as they are known, and its outcome. A finish on an unknown date shows
 * no dates at all ("Finished, date unknown"): the date stored with it is only the day it was entered.
 */
export function describePastSession(s: PastSessionLike): { dates: string | null; outcome: string } {
  const outcome = outcomeLabel[s.outcome]
  if (s.finishedOn === null || s.finishedPrecision === null) return { dates: `${atPrecision(s.startedOn, s.startedPrecision)} → ?`, outcome }
  if (s.finishedPrecision === 'unknown') {
    // a known start stays: "Started 2024-03 · finished, date unknown"
    if (s.startedPrecision === 'unknown') return { dates: null, outcome: `${outcome}, date unknown` }
    return { dates: null, outcome: `Started ${atPrecision(s.startedOn, s.startedPrecision)} · ${outcome.toLowerCase()}, date unknown` }
  }
  const finish = atPrecision(s.finishedOn, s.finishedPrecision)
  // a past read in a month or a year starts and finishes on the same imprecise date: say it once
  if (s.finishedPrecision !== 'day' && s.startedPrecision === s.finishedPrecision && s.startedOn === s.finishedOn) return { dates: finish, outcome }
  return { dates: `${atPrecision(s.startedOn, s.startedPrecision)} → ${finish}`, outcome }
}
