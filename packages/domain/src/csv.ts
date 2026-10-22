import { z } from 'zod'
import { EditionInput } from './catalog'
import { cleanIsbn, isValidIsbn10, isValidIsbn13 } from './isbn'
import { err, ok, type Result } from './result'
import { PhotoExtras, PhotoLink } from './shelf'
import { parseSeriesPosition, type SeriesPosition } from './series-position'
import { ExternalItem } from './sources'
import { importedTitleOf, ItemVolume, parseVolumeText, volumeFromTitles } from './volume-marker'

export const CSV_MAX_ROWS = 2000
export const CSV_MAX_COLUMNS = 60
export const CSV_MAX_CELL = 2000

/** Counts occurrences of `ch` in `text` outside quoted sections, so a delimiter inside a quoted cell isn't mistaken for the real one. */
function countOutsideQuotes(text: string, ch: string): number {
  let n = 0
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i)
    if (quoted) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') i++
        else quoted = false
      }
    } else if (c === '"') quoted = true
    else if (c === ch) n++
  }
  return n
}

/** RFC 4180, plus: a UTF-8 BOM is dropped, the delimiter (comma, semicolon or tab) comes from the header line, blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  return parseCsvWithLines(text).map((r) => r.cells)
}

/** parseCsv, with the file line (1-based) each record starts on — blank lines and multi-line quoted cells counted. */
export function parseCsvWithLines(text: string): { cells: string[]; line: number }[] {
  const source = text.startsWith('﻿') ? text.slice(1) : text
  const firstLine = source.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = [',', ';', '\t'].reduce((best, d) => (countOutsideQuotes(firstLine, d) > countOutsideQuotes(firstLine, best) ? d : best), ',')
  const rows: { cells: string[]; line: number }[] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i)
    if (quoted) {
      // a line break inside a quoted cell is still a line of the file (CRLF counts once)
      if (ch === '\n' || (ch === '\r' && source.charAt(i + 1) !== '\n')) line++
      if (ch !== '"') cell += ch
      else if (source.charAt(i + 1) === '"') {
        cell += '"'
        i++
      } else quoted = false
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source.charAt(i + 1) === '\n') i++
      row.push(cell)
      rows.push({ cells: row, line: rowLine })
      row = []
      cell = ''
      line++
      rowLine = line
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push({ cells: row, line: rowLine })
  }
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ''))
}

export const csvFields = ['title', 'authors', 'isbn', 'series', 'seriesPosition', 'publisher', 'publishedOn', 'pageCount', 'language', 'tags', 'finishedOn', 'rating', 'shelf', 'volume'] as const
export type CsvField = (typeof csvFields)[number]

const Column = z.number().int().min(0).max(CSV_MAX_COLUMNS - 1)
const OptionalColumn = Column.nullable().default(null)

export const CsvMapping = z.object({
  columns: z.object({
    title: Column,
    authors: OptionalColumn,
    isbn: OptionalColumn,
    series: OptionalColumn,
    seriesPosition: OptionalColumn,
    publisher: OptionalColumn,
    publishedOn: OptionalColumn,
    pageCount: OptionalColumn,
    language: OptionalColumn,
    tags: OptionalColumn,
    finishedOn: OptionalColumn,
    rating: OptionalColumn,
    shelf: OptionalColumn,
    volume: OptionalColumn,
  }),
  /** how to read 01/02/2023-style dates; ISO dates are always year-first */
  dateOrder: z.enum(['ymd', 'dmy', 'mdy']).default('ymd'),
  ratingScale: z.union([z.literal(5), z.literal(10)]).default(5),
})
export type CsvMapping = z.output<typeof CsvMapping>
export type CsvDateOrder = CsvMapping['dateOrder']

/** Header names we recognise (lower-cased, trimmed); the person confirms or changes every guess. */
const headerGuesses: Record<CsvField, readonly string[]> = {
  title: ['title', 'book title', 'name', 'כותרת', 'שם הספר', 'שם'],
  authors: ['author', 'authors', 'author l-f', 'writer', 'מחבר', 'מחברים', 'סופר'],
  isbn: ['isbn13', 'isbn-13', 'isbn', 'ean', 'מסת"ב', 'מסת״ב'],
  series: ['series', 'סדרה'],
  seriesPosition: ['series position', 'series number', 'series index', '#', 'מספר בסדרה'],
  publisher: ['publisher', 'הוצאה', 'הוצאה לאור'],
  publishedOn: ['published', 'publication date', 'date published', 'תאריך הוצאה'],
  pageCount: ['number of pages', 'pages', 'page count', 'עמודים', 'מספר עמודים'],
  language: ['language', 'שפה'],
  tags: ['bookshelves', 'tags', 'shelves', 'genres', 'תגיות', "ז'אנר", 'ז׳אנר'],
  finishedOn: ['date read', 'read date', 'finished', 'date finished', 'finished on', 'תאריך קריאה', 'סיימתי'],
  rating: ['my rating', 'rating', 'stars', 'דירוג', 'ציון'],
  shelf: ['exclusive shelf', 'shelf', 'status', 'read status'],
  volume: ['volume', 'vol', 'כרך', 'חלק'],
}

/** A first guess at the mapping from header names, or null when no column looks like a title. */
export function guessCsvMapping(header: readonly string[]): CsvMapping | null {
  const names = header.map((h) => h.trim().toLowerCase())
  const columns: Record<string, number | null> = {}
  for (const field of csvFields) {
    // earlier guesses win (ISBN13 before ISBN)
    let found: number | null = null
    for (const guess of headerGuesses[field]) {
      const i = names.indexOf(guess)
      // a match past the column limit can't be mapped (CsvMapping caps column indices at CSV_MAX_COLUMNS - 1); skip it
      if (i !== -1 && i < CSV_MAX_COLUMNS) {
        found = i
        break
      }
    }
    columns[field] = found
  }
  if (columns.title === null || columns.title === undefined) return null
  const parsed = CsvMapping.safeParse({ columns })
  return parsed.success ? parsed.data : null
}

const validDay = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

export function parseCsvDate(text: string, order: CsvDateOrder): { date: string; precision: 'day' | 'month' | 'year' } | null {
  const t = text.trim()
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(t)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return validDay(y, mo, d) ? { date: iso(y, mo, d), precision: 'day' } : null
  }
  m = /^(\d{4})[-/.](\d{1,2})$/.exec(t)
  if (m) {
    const [y, mo] = [Number(m[1]), Number(m[2])]
    return mo >= 1 && mo <= 12 ? { date: iso(y, mo, 1), precision: 'month' } : null
  }
  m = /^(\d{4})$/.exec(t)
  if (m) return { date: iso(Number(m[1]), 1, 1), precision: 'year' }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t)
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
    // year-first files can still hold day/month dates: only an unambiguous one is read
    const dayFirst = order === 'dmy' || (order === 'ymd' && a > 12 && b <= 12)
    const monthFirst = order === 'mdy' || (order === 'ymd' && b > 12 && a <= 12)
    if (!dayFirst && !monthFirst) return null
    const [d, mo] = dayFirst ? [a, b] : [b, a]
    return validDay(y, mo, d) ? { date: iso(y, mo, d), precision: 'day' } : null
  }
  return null
}

/** To the app's half-star 0.5–5 scale; 0 (Goodreads' "not rated"), blank and junk are no rating. */
export function parseCsvRating(text: string, scale: 5 | 10): number | null {
  const n = Number(text.trim().replace(',', '.'))
  if (text.trim() === '' || !Number.isFinite(n) || n <= 0) return null
  const five = scale === 10 ? n / 2 : n
  return Math.min(5, Math.max(0.5, Math.round(five * 2) / 2))
}

/** Goodreads puts the series in the title: "The Final Empire (Mistborn, #1)". */
export function splitSeriesFromTitle(title: string): { title: string; series: ({ name: string } & SeriesPosition)[] } {
  const m = /^(.*\S)\s*\(([^()]+?),?\s*#(\d+(?:\.\d+)?(?:\s*[-–—]\s*\d+(?:\.\d+)?)?)\)$/.exec(title.trim())
  const at = m?.[3] === undefined ? null : parseSeriesPosition(m[3])
  return m?.[1] && m[2] && at ? { title: m[1], series: [{ name: m[2].trim(), ...at }] } : { title: title.trim(), series: [] }
}

export interface CsvRead {
  finishedOn: string
  finishedPrecision: 'day' | 'month' | 'year'
}
export const csvShelves = ['read', 'reading', 'want'] as const
export const CsvShelf = z.enum(csvShelves)
export type CsvShelf = z.infer<typeof CsvShelf>

const shelfValues: Record<string, CsvShelf> = {
  read: 'read',
  'currently-reading': 'reading',
  reading: 'reading',
  'to-read': 'want',
  'want to read': 'want',
  wishlist: 'want',
}
/** Goodreads' status shelves: they say where the person is with the book, not what it is about */
const statusShelves: ReadonlySet<string> = new Set(['read', 'currently-reading', 'to-read'])

export function parseCsvShelf(text: string): CsvShelf | null {
  return shelfValues[text.trim().toLowerCase()] ?? null
}

export interface CsvRow {
  item: ExternalItem
  read: CsvRead | null
  rating: number | null
  /** the person's shelf for the book (Goodreads' "Exclusive Shelf"), or null when the file doesn't say */
  shelf: CsvShelf | null
}

const splitList = (text: string, separators: RegExp) =>
  text
    .split(separators)
    .map((s) => s.trim())
    .filter((s) => s !== '')

/** Goodreads wraps identifiers as ="0439023483" so spreadsheets keep the leading zeros. */
const cleanCell = (text: string | undefined) => {
  const t = (text ?? '').trim()
  const m = /^="(.*)"$/.exec(t)
  return (m?.[1] ?? t).trim()
}

/** One CSV row -> a physical ExternalItem plus the importer's read and rating (spec §5 CSV). */
export function mapCsvRow(cells: readonly string[], rowNumber: number, mapping: CsvMapping): Result<CsvRow, string> {
  const c = mapping.columns
  const cell = (col: number | null) => (col === null ? '' : cleanCell(cells[col]))
  const rawTitle = cell(c.title)
  if (rawTitle === '') return err(`Row ${rowNumber}: no title`)
  const fromTitle = c.series === null ? splitSeriesFromTitle(rawTitle) : { title: rawTitle, series: [] }
  const marked = volumeFromTitles(fromTitle.title, null)
  const volume = parseVolumeText(cell(c.volume) || null) ?? marked.volume
  const seriesName = cell(c.series)
  const at = parseSeriesPosition(cell(c.seriesPosition)) ?? { position: null, positionEnd: null }
  const series = seriesName !== '' ? [{ name: seriesName, ...at }] : fromTitle.series
  const isbn = cleanIsbn(cell(c.isbn))
  const published = parseCsvDate(cell(c.publishedOn), mapping.dateOrder)
  const pages = Number.parseInt(cell(c.pageCount), 10)
  const finished = parseCsvDate(cell(c.finishedOn), mapping.dateOrder)

  const item = ExternalItem.safeParse({
    externalId: `row:${rowNumber}`,
    format: 'physical',
    title: marked.title,
    importedTitle: importedTitleOf(fromTitle.title, null, marked),
    volume,
    authors: splitList(cell(c.authors), /\s*[;|&]\s*/),
    series,
    identifiers: { isbn13: isValidIsbn13(isbn) ? isbn : null, isbn10: isValidIsbn10(isbn) ? isbn : null, asin: null, others: {} },
    publisher: cell(c.publisher),
    publishedOn: published?.precision === 'day' ? published.date : null,
    pageCount: Number.isFinite(pages) ? pages : null,
    language: cell(c.language),
    tags: splitList(cell(c.tags), /\s*[,;|]\s*/).filter((t) => !statusShelves.has(t.toLowerCase())),
  })
  if (!item.success) return err(`Row ${rowNumber}: ${item.error.issues[0]?.message ?? 'invalid'}`)
  return ok({
    item: item.data,
    read: finished === null ? null : { finishedOn: finished.date, finishedPrecision: finished.precision },
    rating: parseCsvRating(cell(c.rating), mapping.ratingScale),
    shelf: parseCsvShelf(cell(c.shelf)),
  })
}

export const csvOwnerships = ['owned', 'read_not_owned', 'borrowed'] as const
export const CsvOwnership = z.enum(csvOwnerships)
export type CsvOwnership = z.infer<typeof CsvOwnership>

const Cell = z.string().max(CSV_MAX_CELL)
export const CsvImportInput = z.object({
  fileName: z.string().trim().min(1).max(255),
  header: z.array(Cell).min(1).max(CSV_MAX_COLUMNS),
  rows: z.array(z.array(Cell).max(CSV_MAX_COLUMNS)).min(1).max(CSV_MAX_ROWS),
  mapping: CsvMapping,
  /** for every row: "I own these" or "I read these but don't own them" (plan deviation 11) */
  ownership: CsvOwnership,
  /** made by the client when the file is picked: sending the same import again (a retry) never imports it twice */
  importId: z.uuid(),
  /** each row's file line (parseCsvWithLines), for "Row N" and the row's id; absent = header on line 1, no blank lines */
  // the row's id `row:<line>` is cast to int in SQL; a real file (≤ 4 MB) never gets near this bound
  lines: z.array(z.number().int().min(2).max(10_000_000)).max(CSV_MAX_ROWS).optional(),
})
  .refine((input) => input.lines === undefined || input.lines.length === input.rows.length, { message: 'One line number per row', path: ['lines'] })
  .refine((input) => input.lines === undefined || input.lines.every((n, i, all) => i === 0 || n > (all[i - 1] ?? 0)), { message: 'Line numbers must increase', path: ['lines'] })
export type CsvImportInput = z.output<typeof CsvImportInput>

/** A user-scoped `new_work` proposal from one CSV row (plan deviation 9). */
export const CsvRowPayload = z.object({
  sourceId: z.uuid(),
  sourceItemId: z.uuid(),
  item: ExternalItem,
  read: z.object({ finishedOn: z.iso.date(), finishedPrecision: z.enum(['day', 'month', 'year']) }).nullable(),
  rating: z.number().min(0.5).max(5).multipleOf(0.5).nullable(),
  /** absent on proposals stored before shelves were read */
  shelf: CsvShelf.nullable().default(null),
  /** set on rows of a shelf-photo batch (source kind `shelf`); absent on CSV rows */
  photo: PhotoExtras.optional(),
  /** a CSV row linked to a book page: the row as imported (Unlink restores it) and the page; shelf rows keep theirs in `photo` */
  linked: z.object({ original: ExternalItem, link: PhotoLink }).nullable().default(null),
  ownership: CsvOwnership,
  /** the person's correction of the volume (#66): absent means none, null means "not a volume" */
  volumeOverride: ItemVolume.nullable().optional(),
  /** #161: a cover photo taken in the Inbox (an asset id), waiting to become the new copy's cover on Accept */
  coverAssetId: z.uuid().nullable().optional(),
})
export type CsvRowPayload = z.output<typeof CsvRowPayload>

export const CsvResolution = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create_work') }),
  z.object({ action: z.literal('link_new_edition'), workId: z.uuid(), edition: EditionInput.optional() }),
  z.object({ action: z.literal('link_edition'), editionId: z.uuid() }),
  /** the book is in the catalog and this row isn't a new copy: only record my read and rating on it */
  z.object({ action: z.literal('track_only'), workId: z.uuid() }),
  z.object({ action: z.literal('ignore') }),
])
export type CsvResolution = z.output<typeof CsvResolution>
