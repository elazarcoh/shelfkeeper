import { editionFieldNames, type EditionField, type EditionInput } from './catalog'
import type { ExternalItem } from './sources'

/** The Add edition form's values for an Inbox item (#121): what the item says, nothing the person added yet. */
export function editionInputFromItem(item: ExternalItem): EditionInput {
  return {
    format: item.format,
    title: null,
    subtitle: null,
    isbn13: item.identifiers.isbn13,
    isbn10: item.identifiers.isbn10,
    asin: item.identifiers.asin,
    publisher: item.publisher,
    publishedOn: item.publishedOn,
    pageCount: item.pageCount,
    wordCount: item.wordCount,
    durationSec: item.durationSec,
    language: item.language,
    shelfLocation: null,
    volume: item.volume?.number ?? null,
    volumeCount: item.volume?.count ?? null,
    narrators: [...item.narrators],
    translators: [...item.translators],
    ownership: 'owned',
    holdingOn: null,
    holdingNote: null,
  }
}

const same = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b

// the form edits whole minutes, so a duration only differs when it moves by a minute or more
const sameDuration = (a: number | null, b: number | null): boolean => (a === null || b === null ? a === b : Math.round(a / 60) === Math.round(b / 60))

/** The edition fields the person changed in the form; they get locked against later syncs. Holding keys aren't fields. */
export function changedEditionFields(base: EditionInput, submitted: EditionInput): EditionField[] {
  return editionFieldNames.filter((f) => !(f === 'durationSec' ? sameDuration(base.durationSec, submitted.durationSec) : same(base[f], submitted[f])))
}
