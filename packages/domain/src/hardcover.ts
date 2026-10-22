import { z } from 'zod'
import { normalizeText } from './text'

/** A personal access token as pasted from hardcover.app/account/api: "Bearer " is often copied along. */
export const HardcoverToken = z
  .string()
  .trim()
  .transform((s) => s.replace(/^bearer\s+/i, '').trim())
  .pipe(z.string().min(20, 'Paste the whole token').max(4000))

export const hardcoverAccountStatuses = ['ok', 'needs_token', 'missing_scope'] as const
export type HardcoverAccountStatus = (typeof hardcoverAccountStatuses)[number]
export const hardcoverMatchKinds = ['isbn', 'title', 'openlibrary', 'manual', 'none', 'rejected'] as const
export type HardcoverMatchKind = (typeof hardcoverMatchKinds)[number]
export const hardcoverPushStatuses = ['waiting', 'sent', 'skipped'] as const
export type HardcoverPushStatus = (typeof hardcoverPushStatuses)[number]

export interface HardcoverTags {
  genre: string[]
  mood: string[]
}

export interface HardcoverSearchHit {
  id: number
  title: string
  authors: string[]
  year: number | null
  series: string[]
  imageUrl: string | null
}

/** One edition of a Hardcover book; `format` is its edition_format, or Audiobook/E-book from its reading format. */
export interface HardcoverEdition {
  id: number
  title: string | null
  format: string | null
  pages: number | null
  publisher: string | null
  releaseDate: string | null
  isbn13: string | null
  isbn10: string | null
  imageUrl: string | null
  language: string | null
}

/** A Hardcover book with its editions, as the Fetch metadata dialog reads it. */
export interface HardcoverBookPage {
  id: number
  slug: string
  title: string
  description: string | null
  releaseDate: string | null
  imageUrl: string | null
  authors: string[]
  translators: string[]
  series: { name: string; position: number | null } | null
  mainEditionId: number | null
  editions: HardcoverEdition[]
}

export interface HardcoverBookData {
  id: number
  slug: string
  title: string
  rating: number | null
  ratingsCount: number
  tags: HardcoverTags
  similarIds: number[]
}

/** One of the series a book belongs to (a saga, a sub-trilogy, a whole universe); `featured` marks the main one. */
export interface HardcoverBookSeries {
  id: number
  name: string
  position: number | null
  featured: boolean
}

export interface HardcoverExternalBook {
  id: number
  title: string
  authors: string[]
  seriesName: string | null
  position: number | null
  pages: number | null
  releaseDate: string | null
  imageUrl: string | null
  tags: HardcoverTags
  hasAudiobook: boolean | null
}

export interface HardcoverSeriesBooks {
  seriesId: number
  name: string
  books: { id: number; position: number | null; title: string; releaseDate: string | null }[]
}

export interface HardcoverAuthorBooks {
  authorId: number
  books: { id: number; title: string; releaseDate: string | null }[]
}

const TagList = z.array(z.object({ tag: z.string(), count: z.number().optional() }).loose()).catch([])
const names = (list: z.output<typeof TagList>) => [...list].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).map((t) => t.tag)

/** Hardcover's `cached_tags`: { Genre: [{ tag, count }], Mood: [...], ... }; anything else reads as no tags. */
export function tagsFromCached(cached: unknown): HardcoverTags {
  const record = typeof cached === 'object' && cached !== null ? (cached as Record<string, unknown>) : {}
  return { genre: names(TagList.parse(record['Genre'] ?? [])), mood: names(TagList.parse(record['Mood'] ?? [])) }
}

/** "https://hardcover.app/books/<slug>[/...]" → slug; any other address → null. */
export function hardcoverSlugFromUrl(url: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?hardcover\.app\/books\/([a-z0-9-]+)(?:[/?#].*)?$/i.exec(url.trim())
  return m?.[1]?.toLowerCase() ?? null
}

/** "https://hardcover.app/books/<slug>/editions/<id>" → the edition id; any other address → null. */
export function hardcoverEditionIdFromUrl(url: string): number | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?hardcover\.app\/books\/[a-z0-9-]+\/editions\/(\d{1,12})(?:[/?#].*)?$/i.exec(url.trim())
  return m?.[1] === undefined ? null : Number(m[1])
}

/**
 * The only title search match we accept: the same normalized title (or Hardcover's "<series>: <our title>", the prefix
 * being one of either side's series names) and at least one same normalized author.
 */
export function sameTitleAndAuthor(ours: { title: string; authors: string[]; series?: string[] }, theirs: { title: string; authors: string[]; series?: string[] }): boolean {
  const ourTitle = normalizeText(ours.title)
  if (normalizeText(theirs.title) !== ourTitle) {
    const cut = theirs.title.indexOf(': ')
    if (cut < 0 || normalizeText(theirs.title.slice(cut + 2)) !== ourTitle) return false
    const prefix = normalizeText(theirs.title.slice(0, cut))
    const names = [...(ours.series ?? []), ...(theirs.series ?? [])].map(normalizeText)
    if (!names.includes(prefix)) return false
  }
  const authors = new Set(ours.authors.map(normalizeText))
  return theirs.authors.some((a) => authors.has(normalizeText(a)))
}

/**
 * `sameTitleAndAuthor` against many of our books at once: titles, authors and series are normalized once, and a lookup costs
 * the candidate's own size instead of the library's. Matches come back in the order of `items`.
 */
export function titleAuthorIndex<T extends { titles: string[]; authors: string[]; series?: string[] }>(items: T[]): (theirs: { title: string; authors: string[]; series?: string[] }) => T[] {
  interface Prepared {
    order: number
    item: T
    authors: Set<string>
    series: string[]
  }
  const byTitle = new Map<string, Prepared[]>()
  items.forEach((item, order) => {
    const p: Prepared = { order, item, authors: new Set(item.authors.map(normalizeText)), series: (item.series ?? []).map(normalizeText) }
    for (const title of new Set(item.titles.map(normalizeText))) byTitle.set(title, [...(byTitle.get(title) ?? []), p])
  })
  return (theirs) => {
    const theirAuthors = theirs.authors.map(normalizeText)
    const hits = new Set<Prepared>(byTitle.get(normalizeText(theirs.title)) ?? [])
    const cut = theirs.title.indexOf(': ')
    if (cut >= 0) {
      const prefix = normalizeText(theirs.title.slice(0, cut))
      const theirSeries = (theirs.series ?? []).map(normalizeText)
      for (const p of byTitle.get(normalizeText(theirs.title.slice(cut + 2))) ?? []) {
        if (theirSeries.includes(prefix) || p.series.includes(prefix)) hits.add(p)
      }
    }
    return [...hits]
      .sort((a, b) => a.order - b.order)
      .filter((p) => theirAuthors.some((a) => p.authors.has(a)))
      .map((p) => p.item)
  }
}
