import type { EditionFormat, EditionInput, EditionOwnership } from '@mylib/domain'
import { emptyToNull, parseLines, toNumberOrNull } from '@/lib/form'
import { todayLocal } from '@/lib/format'
import type { RouterOutputs } from '@/lib/trpc'

export type EditionDetail = RouterOutputs['catalog']['get']['editions'][number]

export interface EditionFormState {
  format: EditionFormat
  /** initial holding — only used when creating an edition */
  ownership: EditionOwnership
  holdingOn: string
  holdingNote: string
  title: string
  subtitle: string
  isbn13: string
  isbn10: string
  asin: string
  publisher: string
  publishedOn: string
  pageCount: string
  wordCount: string
  hours: string
  minutes: string
  language: string
  shelfLocation: string
  volume: string
  volumeCount: string
  narrators: string
  translators: string
}

export const emptyEditionForm = (format: EditionFormat = 'physical'): EditionFormState => ({
  format,
  ownership: 'owned',
  holdingOn: '',
  holdingNote: '',
  title: '',
  subtitle: '',
  isbn13: '',
  isbn10: '',
  asin: '',
  publisher: '',
  publishedOn: '',
  pageCount: '',
  wordCount: '',
  hours: '',
  minutes: '',
  language: '',
  shelfLocation: '',
  volume: '',
  volumeCount: '',
  narrators: '',
  translators: '',
})

/** Which inputs make sense for each format; hidden fields are sent as empty. */
export const showsField = {
  asin: (f: EditionFormat) => f !== 'physical',
  pages: (f: EditionFormat) => f !== 'audiobook',
  duration: (f: EditionFormat) => f === 'audiobook',
  narrators: (f: EditionFormat) => f === 'audiobook',
  shelfLocation: (f: EditionFormat) => f === 'physical',
}

const str = (v: string | number | null): string => (v === null ? '' : String(v))

export function editionFormFromDetail(e: EditionDetail): EditionFormState {
  return {
    format: e.format,
    ownership: e.ownership,
    holdingOn: '',
    holdingNote: '',
    title: str(e.title),
    subtitle: str(e.subtitle),
    isbn13: str(e.isbn13),
    isbn10: str(e.isbn10),
    asin: str(e.asin),
    publisher: str(e.publisher),
    publishedOn: str(e.publishedOn),
    pageCount: str(e.pageCount),
    wordCount: str(e.wordCount),
    hours: e.durationSec === null ? '' : String(Math.floor(e.durationSec / 3600)),
    minutes: e.durationSec === null ? '' : String(Math.round((e.durationSec % 3600) / 60)),
    language: str(e.language),
    shelfLocation: str(e.shelfLocation),
    volume: str(e.volume),
    volumeCount: str(e.volumeCount),
    narrators: e.narrators.map((n) => n.name).join('\n'),
    translators: e.translators.map((n) => n.name).join('\n'),
  }
}

/** A form filled in from edition values (an Inbox item's, #121); the holding date stays blank = today. */
export function editionFormFromInput(e: EditionInput): EditionFormState {
  return {
    format: e.format,
    ownership: e.ownership,
    holdingOn: '',
    holdingNote: str(e.holdingNote),
    title: str(e.title),
    subtitle: str(e.subtitle),
    isbn13: str(e.isbn13),
    isbn10: str(e.isbn10),
    asin: str(e.asin),
    publisher: str(e.publisher),
    publishedOn: str(e.publishedOn),
    pageCount: str(e.pageCount),
    wordCount: str(e.wordCount),
    hours: e.durationSec === null ? '' : String(Math.floor(e.durationSec / 3600)),
    minutes: e.durationSec === null ? '' : String(Math.round((e.durationSec % 3600) / 60)),
    language: str(e.language),
    shelfLocation: str(e.shelfLocation),
    volume: str(e.volume),
    volumeCount: str(e.volumeCount),
    narrators: e.narrators.join('\n'),
    translators: e.translators.join('\n'),
  }
}

export function durationToSeconds(hours: string, minutes: string): number | null {
  if (hours.trim() === '' && minutes.trim() === '') return null
  const h = hours.trim() === '' ? 0 : Number(hours)
  const m = minutes.trim() === '' ? 0 : Number(minutes)
  return Math.round((h * 60 + m) * 60)
}

export function editionFormToInput(s: EditionFormState) {
  const f = s.format
  return {
    format: f,
    title: emptyToNull(s.title),
    subtitle: emptyToNull(s.subtitle),
    isbn13: emptyToNull(s.isbn13),
    isbn10: emptyToNull(s.isbn10),
    asin: showsField.asin(f) ? emptyToNull(s.asin) : null,
    publisher: emptyToNull(s.publisher),
    publishedOn: emptyToNull(s.publishedOn),
    pageCount: showsField.pages(f) ? toNumberOrNull(s.pageCount) : null,
    wordCount: showsField.pages(f) ? toNumberOrNull(s.wordCount) : null,
    durationSec: showsField.duration(f) ? durationToSeconds(s.hours, s.minutes) : null,
    language: emptyToNull(s.language),
    shelfLocation: showsField.shelfLocation(f) ? emptyToNull(s.shelfLocation) : null,
    volume: toNumberOrNull(s.volume),
    // a count without a volume is dropped rather than rejected: the count field is disabled until a volume is set
    volumeCount: toNumberOrNull(s.volume) === null ? null : toNumberOrNull(s.volumeCount),
    narrators: showsField.narrators(f) ? parseLines(s.narrators) : [],
    translators: parseLines(s.translators),
    // initial holding; EditionPatch strips these keys, so edits never change ownership
    ownership: s.ownership,
    holdingOn: emptyToNull(s.holdingOn) ?? todayLocal(),
    holdingNote: emptyToNull(s.holdingNote),
  }
}
