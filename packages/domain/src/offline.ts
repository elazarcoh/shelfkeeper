import type { WorkCard } from './library'
import { acronymsOf } from './search-document'
import { normalizeText, tokenize } from './text'

/** #62: one book of the phone's offline copy of the catalog, just what answers "do I own it, have I read it?". */
export type OfflineWork = Pick<WorkCard, 'id' | 'title' | 'subtitle' | 'kind' | 'authors' | 'series' | 'formats' | 'availability' | 'status' | 'rating' | 'coverAssetId'>

export interface OfflineSnapshot {
  /** when the server made it (ISO) */
  at: string
  works: OfflineWork[]
}

export function toOfflineWork(card: WorkCard): OfflineWork {
  const { id, title, subtitle, kind, authors, series, formats, availability, status, rating, coverAssetId } = card
  return { id, title, subtitle, kind, authors, series, formats, availability, status, rating, coverAssetId }
}

export const OFFLINE_RESULTS = 50

/**
 * Searches the offline copy as the Library's search box does, roughly: every word of the query must start a word of the
 * book's title, subtitle, series or authors, or the query is a book's first-letter abbreviation (#73: twi, asoiaf).
 * Title hits come first; an empty query lists nothing.
 */
export function searchOffline(works: readonly OfflineWork[], query: string, limit = OFFLINE_RESULTS): OfflineWork[] {
  const terms = tokenize(query)
  if (terms.length === 0) return []
  const joined = terms.join('')
  const hits: { work: OfflineWork; rank: number }[] = []
  for (const work of works) {
    const titleWords = normalizeText(`${work.title} ${work.subtitle ?? ''}`).split(' ')
    const words = [...titleWords, ...normalizeText([work.series?.name ?? '', ...work.authors].join(' ')).split(' ')]
    const starts = (pool: readonly string[]) => terms.every((t) => pool.some((w) => w.startsWith(t)))
    if (starts(titleWords)) hits.push({ work, rank: 0 })
    else if (starts(words)) hits.push({ work, rank: 1 })
    else if (terms.length === 1 && joined.length >= 2 && [work.title, work.series?.name ?? ''].some((t) => acronymsOf(t).includes(joined))) hits.push({ work, rank: 2 })
  }
  return hits
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((h) => h.work)
}
