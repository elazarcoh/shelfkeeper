import { isAllowedCoverUrl, normalizeText, type EditionPatch, type ExtractedPage, type MetadataSource, type SeriesRef, type WorkPatch } from '@mylib/domain'
import { seriesLabel } from '@/lib/format'
import type { RouterOutputs } from '@/lib/trpc'

type WorkDetail = RouterOutputs['catalog']['get']
type EditionDetail = WorkDetail['editions'][number]

export type MetaField = 'title' | 'authors' | 'series' | 'description' | 'publisher' | 'publishedOn' | 'pageCount' | 'isbn13' | 'isbn10' | 'language' | 'translators' | 'volume' | 'cover'

/** The whole book (the header's lookup) or one copy (its card's lookup: no work fields, but its volume). */
export type MetaScope = 'book' | 'edition'

/** One field the page would change: what the book says now, what the page says, and whether it starts ticked. */
export interface MetaRow {
  field: MetaField
  label: string
  /** the book (work) or the chosen copy (edition) */
  on: 'work' | 'edition'
  current: string
  next: string
  /** ticked only when the book has nothing there yet: a value the person already has is never replaced unasked */
  checked: boolean
}

export const metaFieldLabel: Record<MetaField, string> = {
  title: 'Title',
  authors: 'Authors',
  series: 'Series',
  description: 'Description',
  publisher: 'Publisher',
  publishedOn: 'Published',
  pageCount: 'Pages',
  isbn13: 'ISBN-13',
  isbn10: 'ISBN-10',
  language: 'Language',
  translators: 'Translators',
  volume: 'Volume',
  cover: 'Cover',
}

/** The order rows are shown in. */
export const FIELD_ORDER: MetaField[] = ['title', 'authors', 'series', 'description', 'cover', 'pageCount', 'publisher', 'publishedOn', 'isbn13', 'isbn10', 'language', 'translators', 'volume']

const same = (a: string, b: string) => normalizeText(a) === normalizeText(b)
const names = (list: readonly { name: string }[]) => list.map((p) => p.name)

/**
 * The work's series with the page's merged in: a series of the same name takes the page's number (keeping its own
 * when the page has none); a new one is added after the others. Null when the page names no series.
 */
export function mergedSeries(current: readonly SeriesRef[], page: ExtractedPage['series']): SeriesRef[] | null {
  if (page === null) return null
  const i = current.findIndex((s) => same(s.name, page.name))
  const copy = (s: SeriesRef): SeriesRef => ({ name: s.name, position: s.position, positionEnd: s.positionEnd })
  if (i === -1) return [...current.map(copy), { name: page.name, position: page.position, positionEnd: null }]
  return current.map((s, j) => {
    if (j !== i || page.position === null || page.position === s.position) return copy(s)
    // a new start makes the old end meaningless: #1–2 updated to #4 is #4, not #4–2 (#122)
    return { name: s.name, position: page.position, positionEnd: null }
  })
}

/** The copy the edition fields go to when the person hasn't picked one: the first physical copy, else the first. */
export function defaultEditionId(work: Pick<WorkDetail, 'editions'>): string | null {
  return (work.editions.find((e) => e.format === 'physical') ?? work.editions[0])?.id ?? null
}

/** The copy a page's edition fields belong to: the one whose ISBN the page has, else the default copy. */
export function copyForPage(work: Pick<WorkDetail, 'editions'>, page: Pick<ExtractedPage, 'isbn13' | 'isbn10'>): string | null {
  const match = work.editions.find((e) => (page.isbn13 !== null && e.isbn13 === page.isbn13) || (page.isbn10 !== null && e.isbn10 === page.isbn10))
  return match?.id ?? defaultEditionId(work)
}

/** Rows the book has nothing for (ticked) and rows that would replace a value (unticked). Rows that already match aren't rows. */
export function groupRows(rows: readonly MetaRow[]): { fresh: MetaRow[]; replace: MetaRow[] } {
  return { fresh: rows.filter((r) => r.current.trim() === ''), replace: rows.filter((r) => r.current.trim() !== '') }
}

/** The dialog's Keep button: counts the ticked rows; Hardcover with none can still just link the book. */
export function keepLabel(source: MetadataSource, tickedCount: number): { text: string; disabled: boolean } {
  if (tickedCount > 0) return { text: `Keep ${tickedCount}`, disabled: false }
  return source === 'hardcover' ? { text: 'Only link', disabled: false } : { text: 'Keep', disabled: true }
}

/** Every field where the page knows something the book doesn't say the same way. */
export function metadataRows(work: WorkDetail, edition: EditionDetail | null, page: ExtractedPage, scope: MetaScope = 'book'): MetaRow[] {
  const rows: MetaRow[] = []
  const add = (field: MetaField, on: MetaRow['on'], current: string, next: string) => {
    if (next.trim() === '' || same(current, next)) return
    rows.push({ field, label: metaFieldLabel[field], on, current, next, checked: current.trim() === '' })
  }
  if (scope === 'book') {
    add('title', 'work', work.primaryTitle, page.title)
    add('authors', 'work', work.authors.map((a) => a.creditedName).join(', '), page.authors.join(', '))
    const series = mergedSeries(work.series, page.series)
    if (series !== null) add('series', 'work', work.series.map(seriesLabel).join(', '), series.map(seriesLabel).join(', '))
    add('description', 'work', work.description ?? '', page.description ?? '')
  }
  if (edition === null) return rows
  add('publisher', 'edition', edition.publisher ?? '', page.publisher ?? '')
  // an audiobook's length is not a page count
  if (edition.format !== 'audiobook') add('pageCount', 'edition', edition.pageCount === null ? '' : String(edition.pageCount), page.pageCount === null ? '' : String(page.pageCount))
  add('publishedOn', 'edition', edition.publishedOn ?? '', page.publishedOn ?? '')
  add('isbn13', 'edition', edition.isbn13 ?? '', page.isbn13 ?? '')
  add('isbn10', 'edition', edition.isbn10 ?? '', page.isbn10 ?? '')
  add('language', 'edition', edition.language ?? '', page.language ?? '')
  add('translators', 'edition', names(edition.translators).join(', '), page.translators.join(', '))
  // only numbers a copy that has no volume yet (moving one between volumes is the edit dialog's job); the count
  // comes from the copy's set, as on import
  if (scope === 'edition' && edition.volume === null && page.volume !== null) add('volume', 'edition', '', String(page.volume.number))
  if (page.coverUrl !== null && isAllowedCoverUrl(page.coverUrl)) {
    rows.push({ field: 'cover', label: metaFieldLabel.cover, on: 'edition', current: edition.coverAssetId === null ? '' : 'This copy has a cover', next: page.coverUrl, checked: edition.coverAssetId === null })
  }
  return rows.sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field))
}

/** What to save for the ticked rows: a work patch, an edition patch, and the cover to download (each null when nothing). */
export function patchesFor(
  work: WorkDetail,
  page: ExtractedPage,
  rows: readonly MetaRow[],
  ticked: ReadonlySet<MetaField>,
): { work: WorkPatch | null; edition: EditionPatch | null; coverUrl: string | null } {
  const on = (field: MetaField) => ticked.has(field) && rows.some((r) => r.field === field)
  const w: WorkPatch = {}
  if (on('title')) w.title = page.title
  if (on('authors')) w.authors = page.authors
  if (on('series')) w.series = mergedSeries(work.series, page.series) ?? undefined
  if (on('description')) w.description = page.description
  const e: EditionPatch = {}
  if (on('publisher')) e.publisher = page.publisher
  if (on('publishedOn')) e.publishedOn = page.publishedOn
  if (on('pageCount')) e.pageCount = page.pageCount
  if (on('isbn13')) e.isbn13 = page.isbn13
  if (on('isbn10')) e.isbn10 = page.isbn10
  if (on('language')) e.language = page.language
  if (on('translators')) e.translators = page.translators
  if (on('volume') && page.volume !== null) e.volume = page.volume.number
  return {
    work: Object.keys(w).length > 0 ? w : null,
    edition: Object.keys(e).length > 0 ? e : null,
    coverUrl: on('cover') ? page.coverUrl : null,
  }
}

/** The line under step 2's title for a Hardcover page: what Keep will do to the book's Hardcover link. */
export function hardcoverLinkLine(current: { hardcoverId: number } | null, pageProviderId: string): string {
  if (current === null) return 'Will link this book to Hardcover'
  return String(current.hardcoverId) === pageProviderId ? 'Linked to this Hardcover book' : "Will change this book's Hardcover link"
}
