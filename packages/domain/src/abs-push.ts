import { z } from 'zod'
import { cleanIsbn } from './isbn'
import { normalizeLanguage } from './languages'
import { formatSeriesPosition } from './series-position'

/** The field tickboxes of Admin → Health → Out of sync with Audiobookshelf, in page order (#115). */
export const absPushFields = ['title', 'subtitle', 'authors', 'narrators', 'series', 'publishedDate', 'publisher', 'language', 'identifiers'] as const
export type AbsPushField = (typeof absPushFields)[number]
export const absPushFieldLabel: Record<AbsPushField, string> = {
  title: 'Title',
  subtitle: 'Subtitle',
  authors: 'Authors',
  narrators: 'Narrators',
  series: 'Series',
  publishedDate: 'Published date',
  publisher: 'Publisher',
  language: 'Language',
  identifiers: 'ISBN/ASIN',
}

export interface AbsSeriesRef {
  name: string
  sequence: string | null
}
/** The metadata ABS holds (or would be sent) for one book. */
export interface AbsRecord {
  title: string | null
  subtitle: string | null
  authors: string[]
  narrators: string[]
  series: AbsSeriesRef[]
  publishedDate: string | null
  publisher: string | null
  language: string | null
  isbn: string | null
  asin: string | null
}

/** What the db repo loads per ABS item. */
export interface AbsEditionSource {
  title: string
  subtitle: string | null
  volume: number | null
  authors: string[]
  narrators: string[]
  series: { name: string; position: number | null; positionEnd: number | null }[]
  publishedOn: string | null
  publisher: string | null
  language: string | null
  isbn13: string | null
  isbn10: string | null
  asin: string | null
}

const text = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}
const names = (list: readonly string[]): string[] => list.map((n) => n.trim()).filter((n) => n !== '')

/** ASCII hyphen for a range: that is what ABS shows and what parseSeriesPosition reads back. */
const sequenceOf = (position: number | null, positionEnd: number | null): string | null =>
  position === null ? null : formatSeriesPosition(position, positionEnd).replace('–', '-')

/** What My Library would write to ABS for this book. Empty values stay empty: they are never sent. */
export function outgoingAbsRecord(e: AbsEditionSource): AbsRecord {
  const title = text(e.title)
  const series: AbsSeriesRef[] = e.series.map((s) => ({ name: s.name.trim(), sequence: sequenceOf(s.position, s.positionEnd) }))
  let outTitle = title
  if (e.volume !== null && title !== null) {
    outTitle = `${title}, Part ${String(e.volume)}`
    series.push({ name: title, sequence: String(e.volume) })
  }
  return {
    title: outTitle,
    subtitle: text(e.subtitle),
    authors: names(e.authors),
    narrators: names(e.narrators),
    series: series.filter((s) => s.name !== ''),
    publishedDate: text(e.publishedOn),
    publisher: text(e.publisher),
    language: text(e.language),
    isbn: text(e.isbn13) ?? text(e.isbn10),
    asin: text(e.asin),
  }
}

const nullableText = z.string().nullable().optional()
// The metadata part of connectors' AbsItem, with the same defaults (domain cannot import connectors).
const RawAbsItem = z.object({
  media: z.object({
    metadata: z.object({
      title: nullableText,
      subtitle: nullableText,
      authors: z.array(z.object({ name: z.string() })).default([]),
      narrators: z.array(z.string()).default([]),
      series: z.array(z.object({ name: z.string(), sequence: nullableText })).default([]),
      publishedDate: nullableText,
      publisher: nullableText,
      isbn: nullableText,
      asin: nullableText,
      language: nullableText,
    }),
  }),
})

/** The record ABS holds, from source_item.raw; null when raw is not an ABS item. */
export function currentAbsRecord(raw: unknown): AbsRecord | null {
  const parsed = RawAbsItem.safeParse(raw)
  if (!parsed.success) return null
  const m = parsed.data.media.metadata
  return {
    title: text(m.title),
    subtitle: text(m.subtitle),
    authors: names(m.authors.map((a) => a.name)),
    narrators: names(m.narrators),
    series: m.series.map((s) => ({ name: s.name.trim(), sequence: text(s.sequence) })).filter((s) => s.name !== ''),
    publishedDate: text(m.publishedDate),
    publisher: text(m.publisher),
    language: text(m.language),
    isbn: text(m.isbn),
    asin: text(m.asin),
  }
}

export interface AbsFieldDiff {
  field: AbsPushField
  from: string
  to: string
  hash: string
}

/** "1" and "1.0" are the same position; anything unreadable compares as written. */
const seqKey = (s: string | null): string => {
  const t = (s ?? '').trim()
  if (t === '') return ''
  const n = Number(t)
  return Number.isFinite(n) ? String(n) : t
}
const seriesKeys = (list: AbsSeriesRef[]): string[] => list.map((s) => JSON.stringify([s.name, seqKey(s.sequence)])).sort()
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
const seriesText = (list: AbsSeriesRef[]): string => list.map((s) => (s.sequence ? `${s.name} #${s.sequence}` : s.name)).join(', ')

/** The fields where the outgoing record would change ABS; empty outgoing values are never a difference. */
function differing(current: AbsRecord, outgoing: AbsRecord): { scalar: Set<AbsPushField>; isbn: boolean; asin: boolean } {
  const scalar = new Set<AbsPushField>()
  for (const f of ['title', 'subtitle', 'publisher', 'publishedDate'] as const) {
    if (outgoing[f] !== null && outgoing[f] !== current[f]) scalar.add(f)
  }
  if (outgoing.authors.length > 0 && !sameList(current.authors, outgoing.authors)) scalar.add('authors')
  if (outgoing.narrators.length > 0 && !sameList(current.narrators, outgoing.narrators)) scalar.add('narrators')
  if (outgoing.series.length > 0 && !sameList(seriesKeys(current.series), seriesKeys(outgoing.series))) scalar.add('series')
  const outLang = normalizeLanguage(outgoing.language)
  if (outLang !== null && outLang !== normalizeLanguage(current.language)) scalar.add('language')
  const isbn = outgoing.isbn !== null && cleanIsbn(outgoing.isbn) !== cleanIsbn(current.isbn ?? '')
  const asin = outgoing.asin !== null && outgoing.asin !== current.asin
  return { scalar, isbn, asin }
}

/** Per-field differences, in tickbox order. The hash covers the field and both sides, so a change on either side changes it. */
export function diffAbs(current: AbsRecord, outgoing: AbsRecord, hash: (text: string) => string): AbsFieldDiff[] {
  const d = differing(current, outgoing)
  const out: AbsFieldDiff[] = []
  const entry = (field: AbsPushField, from: string, to: string, cur: unknown, outg: unknown): void => {
    out.push({ field, from, to, hash: hash(JSON.stringify([field, cur, outg])) })
  }
  for (const field of absPushFields) {
    switch (field) {
      case 'title':
      case 'subtitle':
      case 'publisher':
      case 'publishedDate':
      case 'language':
        if (d.scalar.has(field)) entry(field, current[field] ?? '', outgoing[field] ?? '', current[field], outgoing[field])
        break
      case 'authors':
      case 'narrators':
        if (d.scalar.has(field)) entry(field, current[field].join(', '), outgoing[field].join(', '), current[field], outgoing[field])
        break
      case 'series':
        if (d.scalar.has(field)) entry(field, seriesText(current.series), seriesText(outgoing.series), current.series, outgoing.series)
        break
      case 'identifiers': {
        if (!d.isbn && !d.asin) break
        const from: string[] = []
        const to: string[] = []
        if (d.isbn) {
          from.push(`ISBN ${current.isbn ?? ''}`.trim())
          to.push(`ISBN ${outgoing.isbn ?? ''}`)
        }
        if (d.asin) {
          from.push(`ASIN ${current.asin ?? ''}`.trim())
          to.push(`ASIN ${outgoing.asin ?? ''}`)
        }
        entry(field, from.join(' · '), to.join(' · '), [current.isbn, current.asin], [outgoing.isbn, outgoing.asin])
        break
      }
    }
  }
  return out
}

/** ABS spells these two out; anything else is sent as stored (R6). */
const languageForAbs = (code: string): string => (code === 'en' ? 'English' : code === 'he' ? 'Hebrew' : code)

/** The PATCH `metadata` body: only the ticked fields that differ. */
export function absMetadataPatch(outgoing: AbsRecord, current: AbsRecord, fields: readonly AbsPushField[]): Record<string, unknown> {
  const d = differing(current, outgoing)
  const patch: Record<string, unknown> = {}
  for (const field of absPushFields) {
    if (!fields.includes(field)) continue
    switch (field) {
      case 'title':
      case 'subtitle':
      case 'publisher':
        if (d.scalar.has(field)) patch[field] = outgoing[field]
        break
      case 'publishedDate':
        if (d.scalar.has(field) && outgoing.publishedDate !== null) {
          patch.publishedDate = outgoing.publishedDate
          patch.publishedYear = outgoing.publishedDate.slice(0, 4)
        }
        break
      case 'authors':
        if (d.scalar.has(field)) patch.authors = outgoing.authors.map((name) => ({ name }))
        break
      case 'narrators':
        if (d.scalar.has(field)) patch.narrators = outgoing.narrators
        break
      case 'series':
        if (d.scalar.has(field)) patch.series = outgoing.series.map((s) => ({ name: s.name, sequence: s.sequence }))
        break
      case 'language': {
        const code = normalizeLanguage(outgoing.language)
        if (d.scalar.has(field) && code !== null) patch.language = languageForAbs(code)
        break
      }
      case 'identifiers':
        if (d.isbn) patch.isbn = outgoing.isbn
        if (d.asin) patch.asin = outgoing.asin
        break
    }
  }
  return patch
}

export const AbsPushSendInput = z.object({
  books: z
    .array(z.object({ sourceItemId: z.uuid(), fields: z.array(z.object({ field: z.enum(absPushFields), hash: z.string().length(64) })).min(1) }))
    .min(1)
    .max(2000),
})
export type AbsPushSendInput = z.output<typeof AbsPushSendInput>
export const AbsPushFieldsInput = z.object({ fields: z.array(z.enum(absPushFields)) })
export type AbsPushFieldsInput = z.output<typeof AbsPushFieldsInput>
