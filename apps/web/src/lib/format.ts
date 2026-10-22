import { formatSeriesPosition, type Availability, type EditionFormat, type HoldingAction, type HoldingEventType, type ReadingStatus, type SourceKind } from '@mylib/domain'

export const formatLabel: Record<EditionFormat, string> = { physical: 'Physical', ebook: 'Ebook', audiobook: 'Audiobook' }

export const sourceKindLabel: Record<SourceKind, string> = {
  audiobookshelf: 'Audiobookshelf',
  calibre: 'Calibre',
  readarr: 'Readarr',
  chaptarr: 'Chaptarr',
  csv: 'CSV',
  manual: 'Manual',
  shelf: 'Shelf photo',
}

export const availabilityLabel: Record<Availability, string> = {
  owned: 'Owned',
  borrowed: 'Borrowed now',
  formerly_owned: 'Formerly owned',
  not_owned: 'Read, not owned',
  wanted: 'Wanted',
}

export const holdingActionLabel: Record<HoldingAction, string> = {
  no_longer_have: 'No longer have it',
  got_back: 'Got it back',
  returned: 'Returned',
  borrowed_again: 'Borrowed again',
  bought: 'Bought it',
}

export const holdingEventLabel: Record<HoldingEventType, string> = {
  acquired: 'Acquired',
  removed: 'No longer had it',
  restored: 'Got it back',
  borrowed: 'Borrowed',
  returned: 'Returned',
}

/** Badge text for one edition's current holding state (null when simply owned). */
export function holdingStateLabel(e: { ownership: 'owned' | 'borrowed'; inPossession: boolean }): string | null {
  if (e.ownership === 'owned') return e.inPossession ? null : 'Formerly owned'
  return e.inPossession ? 'Borrowed' : 'Returned'
}

/** `days` from today, as a local calendar date YYYY-MM-DD (for date inputs). Built from local date parts, not UTC, so it doesn't shift a day in evening hours in UTC+ zones. */
export function addDaysLocal(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local calendar date as YYYY-MM-DD (for date inputs). */
export function todayLocal(): string {
  return addDaysLocal(0)
}

export const statusLabel: Record<ReadingStatus, string> = {
  none: 'No status',
  want_to_read: 'Want to read',
  reading: 'Reading',
  read: 'Read',
  abandoned: 'Abandoned',
}

export function formatDuration(totalSec: number): string {
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.round((totalSec % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

export const seriesLabel = (s: { name: string; position: number | null; positionEnd?: number | null }): string =>
  s.position === null ? s.name : `${s.name} #${formatSeriesPosition(s.position, s.positionEnd ?? null)}`

export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString()
}

export function formatWords(n: number): string {
  return `${formatNumber(n)} words`
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })

/** A stored language code as a name ("he" → "Hebrew"); anything Intl does not recognise is shown as entered. */
export function languageName(code: string): string {
  try {
    return languageNames.of(code.trim()) ?? code
  } catch {
    // not a well-formed language tag (free text such as "Hebrew, English")
    return code
  }
}

/** A book's languages, from its editions in edition order (#124): "Hebrew, English"; null when no edition has one. */
export function bookLanguages(editions: readonly { language: string | null }[]): string | null {
  const seen = new Map<string, string>()
  for (const e of editions) {
    const code = e.language?.trim() ?? ''
    if (code !== '' && !seen.has(code.toLowerCase())) seen.set(code.toLowerCase(), code)
  }
  return seen.size === 0 ? null : [...seen.values()].map(languageName).join(', ')
}

/** Who wishes for a book, me first: "On your and Dad’s wishlists". Null when nobody does. */
export function wishedByLabel(wishedBy: { userId: string; name: string }[], meId: string): string | null {
  if (wishedBy.length === 0) return null
  const mine = wishedBy.filter((w) => w.userId === meId).map(() => 'your')
  const names = [...mine, ...wishedBy.filter((w) => w.userId !== meId).map((w) => `${w.name}’s`)]
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `On ${list} ${names.length === 1 ? 'wishlist' : 'wishlists'}`
}
