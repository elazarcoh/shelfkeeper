import { z } from 'zod'
import { err, ok, type Result } from './result'
import type { MatchBasis } from './proposals'
import { PageCapture } from './providers/page-capture'
import { ExternalItem, withVolumeOverride } from './sources'
import { normalizeLanguage } from './languages'
import { normalizeText } from './text'
import { seriesPosition } from './numerals'
import { type CandidateVolume } from './volumes'
import { importedTitleOf, parseVolumeText, volumeFromTitles } from './volume-marker'

export const SHELF_MAX_ROWS = 100
export const SHELF_MAX_ANSWER = 200_000
/** an identifier match, or a title/author score at least this high, is "the same book" in the review (plan deviation 5) */
export const SHELF_STRONG_SCORE = 0.7

/** Bump whenever SHELF_PROMPT changes: an AI that saved an older copy of it (SHELF_SETUP_PROMPT) says so in its answers. */
export const SHELF_FORMAT = 1

export const SHELF_PROMPT = `You are cataloguing physical books from a photo of a bookshelf, a stack of books, or a single book. Most books are in Hebrew.

For every book whose spine or front cover is visible, return one JSON object, in reading order: top shelf first, and on each shelf from left to right as seen in the photo.

Read the text exactly as printed, in its original language and spelling (Hebrew stays Hebrew). Do not fill fields from memory: if something is not printed on the book, use null. The only exception is "original_title_hint", where you may name the original work if you recognise it.

Fields:
- "position": 1, 2, 3… in the order above
- "shelf": 1 for the top shelf (1 if there is only one)
- "spine_text": everything printed on the spine (or the front cover), exactly as printed, in reading order
- "title": the book's own title only, as printed. A series or character name that is a separate label goes in "series" ("ארטמיס פאול – המושבה האבודה" → title "המושבה האבודה", series "ארטמיס פאול"); a name that is part of the title stays ("הארי פוטר ואבן החכמים")
- "subtitle": as printed, or null
- "authors": array of names as printed
- "translator": as printed, or null
- "publisher": name or logo text as printed, or null
- "series": series name as printed, or null
- "series_number": the book's number in its series as printed (e.g. "1", "ב"), or null. Not a volume of one book: that goes in "volume"
- "volume": when this book is one volume of a book printed in several ("כרך א'", "חלק 2", "Vol. 1"), the volume as printed, or null ("דרך המלכים כרך א" → title "דרך המלכים", volume "א")
- "volume_count": how many volumes the book has, if printed ("מתוך 3", "of 3"), or null
- "language": "he", "en", …
- "original_title_hint": the original title in its original language if you recognise the work, or null
- "confidence": "high", "medium" or "low"
- "notes": what was unclear, or null

Include partly visible books with confidence "low". Start your answer with the line "My Library shelf answer, format ${SHELF_FORMAT}", then one \`\`\`json code block containing the array, and nothing else.`

/** Sent once: the AI saves SHELF_PROMPT as a skill of its own, so later a photo alone is enough. */
export const SHELF_SETUP_PROMPT = `Please create a reusable skill for me, using your own feature for saved skills, instructions or custom assistants. Name it "My Library — shelf photo".

Use it whenever I send a photo of books (a bookshelf, a stack, or a single book) without other instructions. Its instructions are everything between the two marker lines below, word for word:

----- BEGIN SKILL -----
${SHELF_PROMPT}
----- END SKILL -----

When it's saved, confirm it and tell me in one or two sentences how to use it next time. If you can't save skills yourself, give me the instructions above as one block to copy, and short steps to save them in this app.`

/** The format number from the answer's "My Library shelf answer, format N" line, or null when the AI left it out. */
export function shelfAnswerFormat(text: string): number | null {
  const m = /my library shelf answer,?\s*format\s*(\d+)/i.exec(text.slice(0, SHELF_MAX_ANSWER))
  return m?.[1] === undefined ? null : Number(m[1])
}

const Text = (max: number) =>
  z
    .unknown()
    .optional()
    .transform((v) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : ''))
    .transform((s) => (s === '' ? null : s))
const Names = z
  .unknown()
  .optional()
  .transform((v): unknown[] => (Array.isArray(v) ? (v as unknown[]) : typeof v === 'string' ? [v] : []))
  .transform((list) => list.flatMap((n) => (typeof n === 'string' && n.trim() !== '' ? [n.replace(/\s+/g, ' ').trim().slice(0, 300)] : [])).slice(0, 20))

/** One book as the person confirms it in the review (and as the server receives it). */
export const ShelfRow = z.object({
  title: z.string().trim().min(1).max(500),
  subtitle: z.string().trim().max(500).nullable(),
  authors: z.array(z.string().trim().min(1).max(300)).max(20),
  translators: z.array(z.string().trim().min(1).max(300)).max(10),
  publisher: z.string().trim().max(300).nullable(),
  series: z.string().trim().max(300).nullable(),
  seriesNumber: z.string().trim().max(50).nullable(),
  volume: z.number().int().min(1).max(999).nullable().default(null),
  volumeCount: z.number().int().min(1).max(999).nullable().default(null),
  /** the person corrected the volume: `volume`/`volumeCount` are their choice, and null means "not a volume" */
  volumeSet: z.boolean().default(false),
  language: z.string().trim().max(35).nullable().transform(normalizeLanguage),
  spineText: z.string().trim().max(1000).nullable(),
  originalTitle: z.string().trim().max(500).nullable(),
  confidence: z.enum(['high', 'medium', 'low']).nullable(),
  notes: z.string().trim().max(1000).nullable(),
})
export type ShelfRow = z.output<typeof ShelfRow>

/** What the AI sends, read leniently: a wrong field becomes null, never a rejected row. */
const AnswerRow = z.object({
  title: Text(500),
  subtitle: Text(500),
  authors: Names,
  translator: Names,
  publisher: Text(300),
  series: Text(300),
  series_number: Text(50),
  volume: Text(50),
  volume_count: Text(10),
  language: Text(35).transform(normalizeLanguage),
  spine_text: Text(1000),
  original_title_hint: Text(500),
  confidence: z.unknown().optional().transform((v) => (v === 'high' || v === 'medium' || v === 'low' ? v : null)),
  notes: Text(1000),
})

const NO_LIST = "Couldn't find the list in that answer — paste the whole reply"

export function jsonArrayIn(text: string): unknown[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced?.[1] ?? text
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  // AIs sometimes leave trailing commas; smart quotes around the block are outside [ … ] already
  const json = body.slice(start, end + 1).replace(/,\s*([\]}])/g, '$1')
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export function parseShelfAnswer(text: string): Result<{ rows: ShelfRow[]; unreadable: { position: number; reason: string }[]; truncated: boolean }, string> {
  const list = jsonArrayIn(text.slice(0, SHELF_MAX_ANSWER))
  if (list === null) return err(NO_LIST)
  const rows: ShelfRow[] = []
  const unreadable: { position: number; reason: string }[] = []
  for (const [i, value] of list.entries()) {
    if (rows.length === SHELF_MAX_ROWS) return ok({ rows, unreadable, truncated: true })
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      unreadable.push({ position: i + 1, reason: 'not a book' })
      continue
    }
    const a = AnswerRow.parse(value)
    if (a.title === null) {
      unreadable.push({ position: i + 1, reason: 'no title' })
      continue
    }
    const vol = parseVolumeText(a.volume)
    const count = parseVolumeText(a.volume_count)?.number ?? vol?.count ?? null
    rows.push({
      title: a.title,
      subtitle: a.subtitle,
      authors: a.authors,
      translators: a.translator.slice(0, 10),
      publisher: a.publisher,
      series: a.series,
      seriesNumber: a.series_number,
      volume: vol?.number ?? null,
      volumeCount: vol !== null && count !== null && count >= vol.number ? count : null,
      volumeSet: false,
      language: a.language,
      spineText: a.spine_text,
      originalTitle: a.original_title_hint,
      confidence: a.confidence,
      notes: a.notes,
    })
  }
  return ok({ rows, unreadable, truncated: false })
}

export function toExternalItem(row: ShelfRow, n: number): ExternalItem {
  const marked = volumeFromTitles(row.title, row.subtitle)
  // an AI that still put "כרך ב'" in the series number, with no series: that is the volume
  const fromSeriesNumber = row.series === null && row.seriesNumber !== null && /^\s*(?:כרך|חלק|vol|volume|part)/iu.test(row.seriesNumber) ? parseVolumeText(row.seriesNumber) : null
  const guessed = row.volume !== null ? { number: row.volume, count: row.volumeCount ?? marked.volume?.count ?? null } : (marked.volume ?? fromSeriesNumber)
  const volume = row.volumeSet ? (row.volume === null ? null : { number: row.volume, count: row.volumeCount }) : guessed
  const item = ExternalItem.parse({
    externalId: `photo:${n}`,
    format: 'physical',
    title: marked.title,
    subtitle: marked.subtitle,
    importedTitle: importedTitleOf(row.title, row.subtitle, marked),
    authors: row.authors,
    translators: row.translators,
    series: row.series === null ? [] : [{ name: row.series, position: seriesPosition(row.seriesNumber) }],
    publisher: row.publisher,
    language: row.language,
    volume,
  })
  // the person said "not a volume": the title as printed stays
  return row.volumeSet && volume === null ? withVolumeOverride(item, null) : item
}

const DASH_SPLIT = /\s[-–—]\s|:|\|/

/** What to search for, best first; a known ISBN (a copy being looked up) comes before every title search. */
export function searchQueries(row: Pick<ShelfRow, 'title' | 'subtitle' | 'series' | 'authors' | 'spineText'> & { isbn?: string | null }): string[] {
  const out: string[] = []
  const add = (q: string | null | undefined) => {
    const clean = (q ?? '').replace(/\s+/g, ' ').trim()
    if (clean.length >= 2 && !out.includes(clean)) out.push(clean)
  }
  add(row.isbn)
  let core = row.title
  // a series label printed apart from the title ("סדרה – כותרת") is dropped; one that is part of the title stays
  if (DASH_SPLIT.test(core)) core = core.split(DASH_SPLIT).pop() ?? core
  core = core.replace(/^[\s\-–—:,.]+|[\s\-–—:,.]+$/g, '')
  add(core)
  for (const part of row.title.split(DASH_SPLIT)) add(part)
  add(row.subtitle)
  add(row.title)
  if (row.authors[0] !== undefined) add(`${core} ${row.authors[0]}`)
  add(row.spineText)
  return out.slice(0, 5)
}

/** What a lookup box starts with: the ISBN when known, else the core title and first author. */
export function prefillQuery(seed: Parameters<typeof searchQueries>[0]): string {
  const clean = (seed.isbn ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length >= 2) return clean
  const queries = searchQueries(seed)
  const author = seed.authors[0]
  return (author === undefined ? undefined : queries.find((q) => q.endsWith(` ${author}`))) ?? queries[0] ?? ''
}

export type ShelfBookKey = { title: string; originalTitle: string | null; seriesNumber: string | null; volume?: number | null }

export function sameShelfBook(a: ShelfBookKey, b: ShelfBookKey): boolean {
  if ((a.volume ?? null) !== (b.volume ?? null)) return false
  const positionA = seriesPosition(a.seriesNumber)
  const positionB = seriesPosition(b.seriesNumber)
  if (positionA !== positionB) return false
  // two volumes marked in words this cannot read ("כרך ראשון", "כרך שני") are still different volumes when the words differ
  if (positionA === null && a.seriesNumber !== null && b.seriesNumber !== null) {
    const [textA, textB] = [normalizeText(a.seriesNumber), normalizeText(b.seriesNumber)]
    if (textA !== '' && textB !== '' && textA !== textB) return false
  }
  if (normalizeText(a.title) === normalizeText(b.title)) return true
  return a.originalTitle !== null && b.originalTitle !== null && normalizeText(a.originalTitle) === normalizeText(b.originalTitle)
}

export const PhotoLink = z.object({
  provider: z.enum(['simania', 'openlibrary', 'hardcover', 'nli']),
  // a Simania item id, an Open Library work key, a Hardcover book id or a National Library record id
  providerId: z.string().regex(/^(?:\d{1,20}|OL\d{1,12}W)$/),
  url: z.url().max(2000),
  year: z.string().max(10).nullable(),
  title: z.string().max(500),
})
export type PhotoLink = z.output<typeof PhotoLink>

/** A shelf row's extra fields, stored on its proposal next to the CSV-shaped payload (plan: Architecture). */
export const PhotoExtras = z.object({
  ai: z.object({
    spineText: z.string().nullable(),
    originalTitle: z.string().nullable(),
    seriesNumber: z.string().nullable(),
    confidence: z.enum(['high', 'medium', 'low']).nullable(),
    notes: z.string().nullable(),
  }),
  borrowedFrom: z.string().max(200).nullable(),
  /** the item as the review confirmed it, before any page was linked (Unlink restores it) */
  original: ExternalItem,
  link: PhotoLink.nullable(),
  /** the review's "physical copy of X": the card offers that first */
  preset: z.object({ workId: z.uuid() }).nullable(),
})
export type PhotoExtras = z.output<typeof PhotoExtras>

export type ShelfStatus =
  | { kind: 'new' }
  | { kind: 'copy_of' | 'have' | 'maybe'; workId: string; title: string }
  | { kind: 'new_volume'; workId: string; title: string; volume: CandidateVolume }
  | { kind: 'in_inbox'; proposalId: string; title: string }
  | { kind: 'repeat'; of: number }

export function shelfStatus(input: {
  repeatOf: number | null
  inInbox: { proposalId: string; title: string } | null
  top: { workId: string; title: string; score: number; basis: MatchBasis; hasPhysicalInHand: boolean; volume: CandidateVolume | null } | null
}): ShelfStatus {
  if (input.repeatOf !== null) return { kind: 'repeat', of: input.repeatOf }
  if (input.inInbox !== null) return { kind: 'in_inbox', ...input.inInbox }
  const top = input.top
  if (top === null) return { kind: 'new' }
  const strong = top.basis === 'identifier' || top.score >= SHELF_STRONG_SCORE
  if (!strong) return { kind: 'maybe', workId: top.workId, title: top.title }
  if (top.volume !== null) return { kind: 'new_volume', workId: top.workId, title: top.title, volume: top.volume }
  return { kind: top.hasPhysicalInHand ? 'have' : 'copy_of', workId: top.workId, title: top.title }
}

export const ShelfImportRow = z.object({
  row: ShelfRow,
  preset: z.object({ workId: z.uuid() }).nullable().default(null),
  capture: PageCapture.nullable().default(null),
})
export type ShelfImportRow = z.output<typeof ShelfImportRow>

export const ShelfImportInput = z.object({
  batchId: z.uuid(),
  label: z.string().trim().min(1).max(100),
  ownership: z.enum(['owned', 'borrowed']),
  borrowedFrom: z.string().trim().max(200).nullable().default(null),
  rows: z.array(ShelfImportRow).min(1).max(SHELF_MAX_ROWS),
})
export type ShelfImportInput = z.output<typeof ShelfImportInput>

export const ShelfAddOneInput = z
  .object({
    batchId: z.uuid(),
    label: z.string().trim().min(1).max(100),
    ownership: z.enum(['owned', 'borrowed']),
    borrowedFrom: z.string().trim().max(200).nullable().default(null),
    row: ShelfRow.nullable().default(null),
    capture: PageCapture.nullable().default(null),
    target: z.discriminatedUnion('action', [z.object({ action: z.literal('create_work') }), z.object({ action: z.literal('link_new_edition'), workId: z.uuid() })]),
    today: z.iso.date(),
  })
  .refine((i) => i.row !== null || i.capture !== null, 'Send a book or a page')
export type ShelfAddOneInput = z.output<typeof ShelfAddOneInput>

export const ShelfPreviewInput = z.object({ rows: z.array(ShelfRow.extend({ capture: PageCapture.nullable().default(null) })).min(1).max(SHELF_MAX_ROWS) })
export type ShelfPreviewInput = z.output<typeof ShelfPreviewInput>
