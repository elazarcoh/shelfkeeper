import { z } from 'zod'
import { err, ok, type Result } from '../result'
import { bookNode, clean, imageUrl, names, validIsbns } from './extract'
import type { BookPageProvider, ExtractError, UnmarkedPage } from './index'
import type { PageCapture } from './page-capture'

const ORIGIN = 'https://openlibrary.org'
const FIELDS = 'key,title,author_name,first_publish_year,cover_i,series_name,series_position'
// an edition_key lookup also returns the matched edition under `editions` (#102)
const EDITION_FIELDS = 'editions,editions.key,editions.cover_i,editions.publisher,editions.publish_year,editions.isbn,editions.language'
export const OPEN_LIBRARY_RESULTS = 8
const WORK_ID = /^OL\d{1,12}W$/
const EDITION_ID = /^OL\d{1,12}M$/

/** One `docs` entry of Open Library's search API; anything else in it is ignored. */
const SearchDoc = z.object({
  key: z.string(),
  title: z.string().catch(''),
  author_name: z.array(z.string()).optional().catch(undefined),
  first_publish_year: z.number().int().optional().catch(undefined),
  cover_i: z.number().int().positive().optional().catch(undefined),
  series_name: z.array(z.string()).optional().catch(undefined),
  series_position: z.array(z.string()).optional().catch(undefined),
  editions: z.object({ docs: z.array(z.unknown()) }).optional().catch(undefined),
})
type SearchDoc = z.output<typeof SearchDoc>
/** The one edition an edition_key lookup matched. */
const EditionDoc = z.object({
  key: z.string(),
  cover_i: z.number().int().positive().optional().catch(undefined),
  publisher: z.array(z.string()).optional().catch(undefined),
  publish_year: z.array(z.number().int()).optional().catch(undefined),
  isbn: z.array(z.string()).max(50).optional().catch(undefined),
  language: z.array(z.string()).optional().catch(undefined),
})
/** The Books API's record of one edition: only its page count is read (the search has none per edition). */
const EditionDetails = z.record(z.string(), z.object({ details: z.object({ number_of_pages: z.number().int().positive().max(99_999).optional().catch(undefined) }) }).catch({ details: {} }))

function editionPages(details: string | null | undefined, id: string): number | null {
  if (details == null) return null
  let json: unknown
  try {
    json = JSON.parse(details)
  } catch {
    return null
  }
  const parsed = EditionDetails.safeParse(json)
  return (parsed.success ? parsed.data[`OLID:${id}`]?.details.number_of_pages : undefined) ?? null
}

const SearchAnswer = z.object({ docs: z.array(z.unknown()).max(100) })

export const workUrl = (id: string) => `${ORIGIN}/works/${id}`
const editionUrl = (id: string) => `${ORIGIN}/books/${id}`
const coverUrl = (coverId: number) => `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`

/** The search API's address for a query, or for one work or edition (by its key; `edition` adds the edition's own fields). */
export function openLibrarySearchUrl(query: string, limit = OPEN_LIBRARY_RESULTS, edition = false): string {
  return `${ORIGIN}/search.json?q=${encodeURIComponent(query)}&limit=${limit}&fields=${FIELDS}${edition ? `,${EDITION_FIELDS}` : ''}`
}
const lookupQuery = (id: string) => (WORK_ID.test(id) ? `key:/works/${id}` : `edition_key:${id}`)

/** A search result as a capture, in the shape the bookmarklet sends: one schema.org Book node. */
function docCapture(doc: SearchDoc): PageCapture | null {
  const id = /^\/works\/(OL\d{1,12}W)$/.exec(doc.key)?.[1]
  const title = clean(doc.title)
  if (id === undefined || title === null) return null
  const position = Number(doc.series_position?.[0] ?? '')
  const series = clean(doc.series_name?.[0])
  const book: Record<string, unknown> = {
    '@type': 'Book',
    url: workUrl(id),
    name: title,
    author: (doc.author_name ?? []).slice(0, 10).map((name) => ({ '@type': 'Person', name })),
    ...(doc.first_publish_year === undefined ? {} : { datePublished: String(doc.first_publish_year) }),
    ...(doc.cover_i === undefined ? {} : { image: coverUrl(doc.cover_i) }),
    ...(series === null ? {} : { isPartOf: { '@type': 'BookSeries', name: series, ...(Number.isInteger(position) && position > 0 ? { position } : {}) } }),
  }
  return { url: workUrl(id), title, ld: [book], meta: {} }
}

/** An edition lookup as a capture of that edition: the work's Book node with the edition's own cover, publisher, year,
 *  ISBNs and language over it, and the work as `exampleOfWork` (#102). Null unless the answer is that very edition. */
function editionCapture(doc: SearchDoc, id: string, pages: number | null): PageCapture | null {
  const work = docCapture(doc)
  const found = EditionDoc.safeParse(doc.editions?.docs[0])
  if (work === null || !found.success || found.data.key !== `/books/${id}`) return null
  const e = found.data
  const [node] = work.ld as Record<string, unknown>[]
  const year = e.publish_year?.[0]
  const publisher = clean(e.publisher?.[0])
  const book: Record<string, unknown> = {
    ...node,
    url: editionUrl(id),
    exampleOfWork: { '@type': 'Book', url: work.url },
    ...(e.cover_i === undefined ? {} : { image: coverUrl(e.cover_i) }),
    ...(year === undefined ? {} : { datePublished: String(year) }),
    ...(pages === null ? {} : { numberOfPages: pages }),
    ...(publisher === null ? {} : { publisher: { '@type': 'Organization', name: publisher } }),
    ...(e.isbn === undefined ? {} : { isbn: e.isbn }),
    ...(clean(e.language?.[0]) === null ? {} : { inLanguage: clean(e.language?.[0]) }),
  }
  return { url: editionUrl(id), title: work.title, ld: [book], meta: {} }
}

function docs(json: unknown): SearchDoc[] {
  const answer = SearchAnswer.safeParse(json)
  if (!answer.success) return []
  return answer.data.docs.flatMap((d) => {
    const doc = SearchDoc.safeParse(d)
    return doc.success ? [doc.data] : []
  })
}

/** The search API's answer as captures, best first; works without a usable key or title are skipped. */
export function openLibraryResults(json: unknown): PageCapture[] {
  return docs(json).flatMap((d) => {
    const c = docCapture(d)
    return c === null ? [] : [c]
  })
}

/** The search API's address for one ISBN: the work it belongs to, with the matching edition under `editions` (#157). */
export const openLibraryIsbnUrl = (isbn: string): string => openLibrarySearchUrl(`isbn:${isbn}`, 1, true)

/** An ISBN search's answer as a capture of that edition (no page count: that is a second request), or of the work. */
export function openLibraryIsbnCapture(json: unknown): PageCapture | null {
  const doc = docs(json)[0]
  if (doc === undefined) return null
  const id = /^\/books\/(OL\d{1,12}M)$/.exec(EditionDoc.safeParse(doc.editions?.docs[0]).data?.key ?? '')?.[1]
  return (id === undefined ? null : editionCapture(doc, id, null)) ?? docCapture(doc)
}

export const openLibrary: BookPageProvider = {
  id: 'openlibrary',
  label: 'Open Library',
  hosts: ['openlibrary.org', 'www.openlibrary.org'],
  coverHosts: ['covers.openlibrary.org'],
  // covers.openlibrary.org answers most covers with a redirect into archive.org's storage
  coverRedirectHosts: ['archive.org', /^ia\d{1,6}\.us\.archive\.org$/],
  bookmarklet: false,
  searchUrl: (query) => `${ORIGIN}/search?q=${encodeURIComponent(query)}`,
  bookId(url) {
    const id = /^\/(?:works|books)\/(OL\d{1,12}[WM])(?:\/[^/]*)?\/?$/.exec(url.pathname)?.[1]
    return id === undefined ? null : id
  },
  canonicalUrl: (id) => (EDITION_ID.test(id) ? `${ORIGIN}/books/${id}` : workUrl(id)),
  fetch: {
    url: (id) => openLibrarySearchUrl(lookupQuery(id), 1, EDITION_ID.test(id)),
    detailsUrl: (id) => (EDITION_ID.test(id) ? `${ORIGIN}/api/books?bibkeys=${encodeURIComponent(`OLID:${id}`)}&format=json&jscmd=details` : null),
    accept: 'application/json',
    capture(body, url, details) {
      let json: unknown
      try {
        json = JSON.parse(body)
      } catch {
        return null
      }
      const edition = /^https:\/\/openlibrary\.org\/books\/(OL\d{1,12}M)$/.exec(url)?.[1]
      if (edition === undefined) return openLibraryResults(json)[0] ?? null
      const doc = docs(json)[0]
      return doc === undefined ? null : editionCapture(doc, edition, editionPages(details, edition))
    },
  },
  extract(capture: PageCapture): Result<UnmarkedPage, ExtractError> {
    let url: URL
    try {
      url = new URL(capture.url)
    } catch {
      return err('unknown_page')
    }
    const id = openLibrary.bookId(url)
    if (id === null) return err('not_a_book_page')
    const book = bookNode(capture)
    const title = book === null ? null : clean(book['name'])
    if (book === null || title === null) return err('not_a_book_page')
    const isEdition = EDITION_ID.test(id)
    if (clean(book['url']) !== (isEdition ? editionUrl(id) : workUrl(id))) return err('stale')
    // an edition is kept on its work: the work's key is the book's Open Library id, the edition's page is the link (#102)
    const of = book['exampleOfWork']
    const ofUrl = of !== null && typeof of === 'object' ? clean((of as Record<string, unknown>)['url']) : null
    const workId = isEdition ? (/^https:\/\/openlibrary\.org\/works\/(OL\d{1,12}W)$/.exec(ofUrl ?? '')?.[1] ?? null) : id
    if (workId === null) return err('not_a_book_page')
    const part = book['isPartOf']
    const seriesName = names(part)[0] ?? null
    const rawPosition = part !== null && typeof part === 'object' ? (part as Record<string, unknown>)['position'] : null
    const year = /^\d{4}$/.exec(clean(book['datePublished']) ?? '')?.[0] ?? null
    // a work link says nothing of the edition on the shelf; an edition link knows its publisher, ISBNs, language and pages
    const pages = book['numberOfPages']
    const isbns = isEdition ? validIsbns(...[book['isbn']].flat()) : { isbn13: null, isbn10: null }
    return ok({
      provider: 'openlibrary',
      providerId: workId,
      url: isEdition ? editionUrl(id) : workUrl(id),
      title,
      subtitle: null,
      authors: names(book['author']),
      translators: [],
      publisher: isEdition ? (names(book['publisher'])[0] ?? null) : null,
      year,
      publishedOn: null,
      pageCount: isEdition && typeof pages === 'number' && Number.isInteger(pages) && pages > 0 && pages < 100_000 ? pages : null,
      ...isbns,
      series: seriesName === null ? null : { name: seriesName, position: typeof rawPosition === 'number' && Number.isInteger(rawPosition) && rawPosition > 0 ? rawPosition : null },
      language: isEdition ? clean(book['inLanguage']) : null,
      coverUrl: imageUrl(book['image']),
      description: null,
      volume: null,
    })
  },
}
