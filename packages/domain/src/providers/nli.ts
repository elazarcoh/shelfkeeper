import { z } from 'zod'
import { err, ok, type Result } from '../result'
import { bookNode, clean, imageUrl, names, validIsbns } from './extract'
import type { BookPageProvider, ExtractError, UnmarkedPage } from './index'
import type { PageCapture } from './page-capture'

/** The National Library of Israel (#157): its search API answers an ISBN with the library's catalog record. */
const ORIGIN = 'https://www.nli.org.il'
export const NLI_API_URL = 'https://api.nli.org.il/openlibrary/search'
const RECORD_ID = /^\d{8,20}$/
const DC = 'http://purl.org/dc/elements/1.1/'

const Values = z.array(z.object({ '@value': z.string().optional().catch(undefined), '@id': z.string().optional().catch(undefined) })).catch([])
const NliRecord = z.object({
  [`${DC}recordid`]: Values,
  [`${DC}title`]: Values.optional(),
  [`${DC}creator`]: Values.optional(),
  [`${DC}publisher`]: Values.optional(),
  [`${DC}date`]: Values.optional(),
  [`${DC}non_standard_date`]: Values.optional(),
  [`${DC}format`]: Values.optional(),
  [`${DC}isbn`]: Values.optional(),
  [`${DC}language`]: Values.optional(),
  [`${DC}thumbnail`]: Values.optional(),
  [`${DC}type`]: Values.optional(),
})
type NliRecord = z.output<typeof NliRecord>
const Answer = z.array(z.unknown()).max(100)

const values = (r: NliRecord, field: string): string[] =>
  ((r as Record<string, z.output<typeof Values> | undefined>)[`${DC}${field}`] ?? []).flatMap((v) => (v['@value'] === undefined ? [] : [v['@value']]))

export const nliBookUrl = (id: string) => `${ORIGIN}/en/books/NNL_ALEPH${id}`

/** The search API's address (without the key, which the server adds) for a query like `any,contains,9789655310320`. */
export function nliSearchUrl(query: string, base = NLI_API_URL): string {
  return `${base}?query=${encodeURIComponent(query)}&output_format=json`
}

/** "לויתני האפר : שירים / חגית גרוסמן." → "לויתני האפר" (the statement of responsibility and subtitle go). */
export function cleanNliTitle(raw: string): string | null {
  return clean(raw.split(' / ')[0]?.split(' : ')[0]?.replace(/[\s.:;/]+$/, ''))
}

/** "גרוסמן, חגית, 1976-$$Q…" → "חגית גרוסמן"; a name already in reading order stays. */
export function nliPersonName(raw: string): string | null {
  const name = raw.split('$$')[0] ?? ''
  const parts = name
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '' && !/^[\d\s?-]+$/.test(p) && !/^\(?\d{3,4}-/.test(p))
  if (parts.length >= 2) return clean(`${parts[1]} ${parts[0]}`.replace(/[.,]+$/, ''))
  return clean(parts[0]?.replace(/[,]+$/, ''))
}

/** "[תל אביב] : קשב לשירה" → "קשב לשירה" */
const publisherName = (raw: string): string | null => clean((raw.split(' : ').at(-1) ?? '').replace(/^\[|\]$/g, '').replace(/[\s,.;]+$/, ''))

/** One catalog record as a capture, in the shape the bookmarklet sends: one schema.org Book node. */
function recordCapture(record: NliRecord): PageCapture | null {
  const id = values(record, 'recordid')[0]
  const title = cleanNliTitle(values(record, 'title')[0] ?? '')
  const type = values(record, 'type')[0]
  if (id === undefined || !RECORD_ID.test(id) || title === null || (type !== undefined && type !== 'book')) return null
  const year = /^\d{4}/.exec(values(record, 'date')[0] ?? '')?.[0] ?? /\b(1[5-9]\d{2}|20\d{2})\b/.exec(values(record, 'non_standard_date')[0] ?? '')?.[1]
  // "89, [4] עמודים ; 23 ס"מ." → 89: the numbered pages, before the unnumbered ones in brackets
  const pages = Number(/^\D*?(\d{1,5})[^;]*?(?:עמודים|עמ'|pages|p\.)/.exec(values(record, 'format')[0] ?? '')?.[1] ?? '')
  const publisher = publisherName(values(record, 'publisher')[0] ?? '')
  const language = clean(values(record, 'language')[0]?.split(';')[0])
  const thumbnail = clean(values(record, 'thumbnail')[0])
  const book: Record<string, unknown> = {
    '@type': 'Book',
    url: nliBookUrl(id),
    name: title,
    author: values(record, 'creator')
      .slice(0, 10)
      .flatMap((c) => {
        const name = nliPersonName(c)
        return name === null ? [] : [{ '@type': 'Person', name }]
      }),
    ...(year === undefined ? {} : { datePublished: year }),
    ...(Number.isInteger(pages) && pages > 0 ? { numberOfPages: pages } : {}),
    ...(publisher === null ? {} : { publisher: { '@type': 'Organization', name: publisher } }),
    isbn: values(record, 'isbn').slice(0, 10),
    ...(language === null ? {} : { inLanguage: language }),
    ...(thumbnail === null ? {} : { image: thumbnail }),
  }
  return { url: nliBookUrl(id), title, ld: [book], meta: {} }
}

/** The search API's answer as captures, in its order; records that aren't books, or have no title, are skipped. */
export function nliResults(json: unknown): PageCapture[] {
  const answer = Answer.safeParse(json)
  if (!answer.success) return []
  return answer.data.flatMap((r) => {
    const record = NliRecord.safeParse(r)
    const capture = record.success ? recordCapture(record.data) : null
    return capture === null ? [] : [capture]
  })
}

export const nli: BookPageProvider = {
  id: 'nli',
  label: 'National Library',
  hosts: ['www.nli.org.il', 'nli.org.il'],
  coverHosts: ['nli.alma.exlibrisgroup.com'],
  coverRedirectHosts: [],
  bookmarklet: false,
  searchUrl: (query) => `${ORIGIN}/en/discover?q=${encodeURIComponent(query)}`,
  bookId(url) {
    const id = /^\/(?:en|he|ar)\/books\/NNL_ALEPH(\d{8,20})\/?$/.exec(url.pathname)?.[1]
    return id === undefined ? null : id
  },
  canonicalUrl: nliBookUrl,
  fetch: {
    url: (id) => nliSearchUrl(`any,contains,${id}`),
    accept: 'application/json',
    capture(body, url) {
      let json: unknown
      try {
        json = JSON.parse(body)
      } catch {
        return null
      }
      return nliResults(json).find((c) => c.url === url) ?? null
    },
  },
  extract(capture: PageCapture): Result<UnmarkedPage, ExtractError> {
    let url: URL
    try {
      url = new URL(capture.url)
    } catch {
      return err('unknown_page')
    }
    const id = nli.bookId(url)
    if (id === null) return err('not_a_book_page')
    const book = bookNode(capture)
    const title = book === null ? null : clean(book['name'])
    if (book === null || title === null) return err('not_a_book_page')
    if (clean(book['url']) !== nliBookUrl(id)) return err('stale')
    const pages = book['numberOfPages']
    return ok({
      provider: 'nli',
      providerId: id,
      url: nliBookUrl(id),
      title,
      subtitle: null,
      authors: names(book['author']),
      translators: [],
      publisher: names(book['publisher'])[0] ?? null,
      year: /^\d{4}$/.exec(clean(book['datePublished']) ?? '')?.[0] ?? null,
      publishedOn: null,
      pageCount: typeof pages === 'number' && Number.isInteger(pages) && pages > 0 && pages < 100_000 ? pages : null,
      ...validIsbns(...[book['isbn']].flat()),
      series: null,
      language: clean(book['inLanguage']),
      coverUrl: imageUrl(book['image']),
      description: null,
      volume: null,
    })
  },
}
