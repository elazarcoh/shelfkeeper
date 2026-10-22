import { z } from 'zod'
import { EditionInput } from './catalog'
import { EditionFormat, editionFormats, type WorkKind } from './enums'
import { normalizeLanguage } from './languages'
import type { WishVolumes } from './volumes'
import { isAllowedCoverUrl, type ExtractedPage } from './providers'

/** What the shared Simania / Open Library page said about its edition: shown on the wish, and pre-fills a bought copy. */
export const WishPage = z.object({
  provider: z.string().max(40),
  url: z.string().max(2000),
  publisher: z.string().max(300).nullable(),
  translators: z.array(z.string().max(300)).max(20),
  year: z.string().max(40).nullable(),
  isbn13: z.string().max(20).nullable(),
  isbn10: z.string().max(20).nullable(),
  pageCount: z.number().int().min(1).max(100_000).nullable(),
  language: z.string().max(35).nullable().transform(normalizeLanguage),
  coverUrl: z.string().max(2000).nullable(),
  /** the volume the page describes (#66); absent on pages stored before volumes */
  volume: z.number().int().min(1).max(999).nullable().default(null),
  volumeCount: z.number().int().min(1).max(999).nullable().default(null),
})
export type WishPage = z.output<typeof WishPage>

const blankToNull = (v: string | null | undefined) => (v === undefined || v === null || v.trim() === '' ? null : v.trim())

/** A wish's criteria: any subset of formats (none = any format), an optional language, a note. */
export const WishFields = z.object({
  formats: z.array(EditionFormat).max(editionFormats.length).transform((fs) => editionFormats.filter((f) => fs.includes(f))),
  language: z.string().max(35).nullable().default(null).transform(normalizeLanguage),
  note: z.string().max(500).nullable().default(null).transform(blankToNull),
})
export type WishFields = z.output<typeof WishFields>
export type WishRecord = WishFields & { page: WishPage | null }

export interface WishRow {
  workId: string
  title: string
  kind: WorkKind
  authors: string[]
  formats: EditionFormat[]
  language: string | null
  note: string | null
  page: WishPage | null
  /** the work's own cover, when it has editions */
  coverAssetId: string | null
  /** formats the household already has copies of */
  haveFormats: EditionFormat[]
  /** the volumes owned of the set this wish would fill (#66) */
  volumes: WishVolumes | null
  createdAt: string
}

export interface WishMember {
  userId: string
  name: string
  count: number
}

export function wishPageFromExtracted(p: ExtractedPage): WishPage {
  return {
    provider: p.provider,
    url: p.url,
    publisher: p.publisher,
    translators: p.translators,
    year: p.year,
    isbn13: p.isbn13,
    isbn10: p.isbn10,
    pageCount: p.pageCount,
    language: p.language,
    coverUrl: p.coverUrl !== null && isAllowedCoverUrl(p.coverUrl) ? p.coverUrl : null,
    volume: p.volume?.number ?? null,
    volumeCount: p.volume?.count ?? null,
  }
}

/**
 * The owned copy a bought wish becomes. A book page describes a print edition, so its ISBNs, publisher, pages and
 * year go only on a physical copy; language and translators hold for any format.
 */
export function editionFromWish(page: WishPage | null, format: EditionFormat, on: string, volume: number | null = null): EditionInput {
  const shape = EditionInput.shape
  // every page-derived field stands or falls on its own: a bad one must never block the purchase
  const keep = (key: 'isbn13' | 'isbn10' | 'publisher' | 'pageCount' | 'publishedOn' | 'language', value: unknown) => {
    const parsed = shape[key].safeParse(value)
    return parsed.success ? parsed.data : null
  }
  const print = page !== null && format === 'physical'
  return EditionInput.parse({
    format,
    ownership: 'owned',
    holdingOn: on,
    language: keep('language', page?.language ?? null),
    // the page's volume wins; otherwise the one asked for, whose count the set supplies
    volume: page?.volume ?? volume,
    volumeCount: page?.volume != null ? page.volumeCount : null,
    translators: (page?.translators ?? []).filter((t) => shape.translators.unwrap().element.safeParse(t).success),
    isbn13: print ? keep('isbn13', page.isbn13) : null,
    isbn10: print ? keep('isbn10', page.isbn10) : null,
    publisher: print ? keep('publisher', page.publisher) : null,
    pageCount: print ? keep('pageCount', page.pageCount) : null,
    publishedOn: print && page.year !== null && /^\d{4}$/.test(page.year) ? keep('publishedOn', `${page.year}-01-01`) : null,
  })
}

/** One person's two wishes on two books being merged into one (#28): nothing they said is lost. */
export function mergeWishes(target: WishRecord, source: WishRecord): WishRecord {
  const any = target.formats.length === 0 || source.formats.length === 0
  const notes = [target.note, source.note].filter((n): n is string => n !== null)
  return {
    formats: any ? [] : editionFormats.filter((f) => target.formats.includes(f) || source.formats.includes(f)),
    language: target.language ?? source.language,
    note: notes.length > 0 ? notes.join(' · ').slice(0, 500) : null,
    page: target.page ?? source.page,
  }
}
