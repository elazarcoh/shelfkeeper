import type { SessionMode } from '@mylib/domain'
import type { DateChoiceValue } from './date-choice'

/** How far back the year pickers reach. */
export const YEARS_BACK = 60

/** This year and the ones before it, newest first (the year picker's options), never before `minDate`'s year. */
export function recentYears(today: string, count = YEARS_BACK, minDate?: string): number[] {
  const current = Number(today.slice(0, 4))
  const earliest = minDate === undefined ? -Infinity : Number(minDate.slice(0, 4))
  return Array.from({ length: count }, (_, i) => current - i).filter((y) => y >= earliest)
}

/** A whole year: precision `year`, stored on its first day. */
export function yearOf(year: number): DateChoiceValue {
  return { date: `${String(year).padStart(4, '0')}-01-01`, precision: 'year' }
}

/** Whether a day may be picked: not before `minDate` (a finish never before its start), any day without one. */
export function dayAllowed(date: string, minDate: string | undefined): boolean {
  return minDate === undefined || date >= minDate
}

/** What a finish on an unknown date means, said wherever one can be picked (the mark-as-read sheet, the check-in). */
export function undatedFinishNote(mode: SessionMode): string {
  return `It counts as ${mode === 'listen' ? 'listened' : 'read'}, but not in any year’s stats or goals.`
}
