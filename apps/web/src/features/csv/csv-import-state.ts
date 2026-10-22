import {
  CSV_MAX_CELL,
  CSV_MAX_COLUMNS,
  CSV_MAX_ROWS,
  CsvMapping,
  csvFields,
  guessCsvMapping,
  mapCsvRow,
  parseCsvWithLines,
  type CsvDateOrder,
  type CsvField,
  type CsvOwnership,
  type CsvRow,
  type Result,
} from '@mylib/domain'

export interface CsvDraft {
  fileName: string
  header: string[]
  rows: string[][]
  /** each row's file line, for "Row N" (blank lines and multi-line cells make it differ from its index) */
  lines: number[]
  /** cells (header or data) longer than CSV_MAX_CELL, silently shortened — the page warns about this before import */
  truncatedCells: number
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/** well under the server's 8 MB request limit (MAX_BODY_BYTES), which would otherwise answer a bare 413 */
export const CSV_MAX_FILE_BYTES = 4 * 1024 * 1024

export function draftFromText(fileName: string, text: string): Parsed<CsvDraft> {
  if (new TextEncoder().encode(text).byteLength > CSV_MAX_FILE_BYTES) return { ok: false, message: 'The file is larger than 4 MB — split it into smaller files' }
  const records = parseCsvWithLines(text)
  const truncatedCells = records.reduce((n, r) => n + r.cells.filter((cell) => cell.length > CSV_MAX_CELL).length, 0)
  const all = records.map((r) => r.cells.map((cell) => cell.slice(0, CSV_MAX_CELL)))
  const [header, ...rows] = all
  const lines = records.slice(1).map((r) => r.line)
  if (header === undefined || rows.length === 0) return { ok: false, message: 'The file needs a header row and at least one book' }
  if (header.length > CSV_MAX_COLUMNS) return { ok: false, message: `At most ${CSV_MAX_COLUMNS} columns` }
  if (rows.length > CSV_MAX_ROWS) return { ok: false, message: `At most ${CSV_MAX_ROWS} books per file — split it into smaller files` }
  return { ok: true, value: { fileName, header, rows: rows.map((r) => r.slice(0, CSV_MAX_COLUMNS)), lines, truncatedCells } }
}

export const csvFieldLabel: Record<CsvField, string> = {
  title: 'Title',
  authors: 'Authors',
  isbn: 'ISBN',
  series: 'Series',
  seriesPosition: 'Series position',
  publisher: 'Publisher',
  publishedOn: 'Publication date',
  pageCount: 'Pages',
  language: 'Language',
  tags: 'Tags / shelves',
  finishedOn: 'Date I read it',
  rating: 'My rating',
  shelf: 'Shelf / status',
  volume: 'Volume',
}

export interface MappingForm {
  /** '' = not in the file, otherwise the column index */
  columns: Record<CsvField, string>
  dateOrder: CsvDateOrder
  ratingScale: '5' | '10'
  ownership: CsvOwnership
}

export function mappingFormFrom(header: readonly string[]): MappingForm {
  const guess = guessCsvMapping(header)
  const columns = Object.fromEntries(csvFields.map((f) => [f, guess === null || guess.columns[f] === null ? '' : String(guess.columns[f])])) as Record<CsvField, string>
  return { columns, dateOrder: 'ymd', ratingScale: '5', ownership: 'owned' }
}

export function toMapping(form: MappingForm): Parsed<CsvMapping> {
  if (form.columns.title === '') return { ok: false, message: 'Choose the column that holds the title' }
  const columns = Object.fromEntries(csvFields.map((f) => [f, form.columns[f] === '' ? null : Number(form.columns[f])]))
  const parsed = CsvMapping.safeParse({ columns, dateOrder: form.dateOrder, ratingScale: Number(form.ratingScale) })
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the mapping' }
}

const lineOf = (draft: CsvDraft, i: number) => draft.lines[i] ?? i + 2

/** Row numbers are real file lines (the same numbers the server reports, since the import sends `lines`). */
export function previewRows(draft: CsvDraft, mapping: CsvMapping, limit: number): { row: number; result: Result<CsvRow, string> }[] {
  return draft.rows.slice(0, limit).map((cells, i) => ({ row: lineOf(draft, i), result: mapCsvRow(cells, lineOf(draft, i), mapping) }))
}

export function summarize(draft: CsvDraft, mapping: CsvMapping): { valid: number; invalid: number; withRead: number; withRating: number } {
  const results = draft.rows.map((cells, i) => mapCsvRow(cells, lineOf(draft, i), mapping))
  const ok = results.flatMap((r) => (r.ok ? [r.value] : []))
  return { valid: ok.length, invalid: results.length - ok.length, withRead: ok.filter((r) => r.read !== null).length, withRating: ok.filter((r) => r.rating !== null).length }
}

type UuidSource = { randomUUID?: () => string; getRandomValues: <T extends Uint8Array>(bytes: T) => T }

/**
 * A fresh id for one file pick, sent with the import so a retry never imports the file twice.
 * crypto.randomUUID only exists in secure contexts; a household server on plain http has only
 * getRandomValues, so build the v4 uuid from that when needed.
 */
export function newImportId(source: UuidSource = crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID()
  const b = source.getRandomValues(new Uint8Array(16))
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Half a megabyte under the server's 8 MB MAX_BODY_BYTES (apps/server/src/app.ts), which otherwise
 * answers a bare, unfriendly 413: the margin covers the request's tRPC envelope around the payload.
 */
export const CSV_MAX_IMPORT_BYTES = 7.5 * 1024 * 1024

/** Measures the JSON-serialized size of a csv.import payload so an oversized one is caught client-side, with a friendly message, before it hits the server's body-size limit. */
export function importPayloadTooLarge(input: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(input)).length > CSV_MAX_IMPORT_BYTES
}
