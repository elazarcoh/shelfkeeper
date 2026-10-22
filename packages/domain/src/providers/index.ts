import { err, ok, type Result } from '../result'
import type { ExternalItem } from '../sources'
import { normalizeText } from '../text'
import { importedTitleOf, ItemVolume, volumeFromTitles } from '../volume-marker'
import type { PageCapture } from './page-capture'
import { nli } from './nli'
import { openLibrary } from './openlibrary'
import { simania } from './simania'

export * from './page-capture'
export { bookmarkletSource, bookmarkletUrl, isBookCapture } from './bookmarklet'
export { cleanNliTitle, NLI_API_URL, nliBookUrl, nliPersonName, nliResults, nliSearchUrl } from './nli'
export { OPEN_LIBRARY_RESULTS, openLibraryIsbnCapture, openLibraryIsbnUrl, openLibraryResults, openLibrarySearchUrl } from './openlibrary'

export type ExtractError = 'not_a_book_page' | 'stale' | 'unknown_page'
export const extractErrorMessage: Record<ExtractError, string> = {
  not_a_book_page: "That isn't a book page — open the book itself and send it again",
  stale: 'That page still showed another book — reload it and send it again',
  unknown_page: "That page isn't from a book site My Library knows",
}

export const providerIds = ['simania', 'openlibrary', 'nli'] as const
export type ProviderId = (typeof providerIds)[number]

/** Where a fetched page can come from: a capture provider, or Hardcover's API. */
export type MetadataSource = ProviderId | 'hardcover'

export const sourceLabel = (s: MetadataSource): string => (s === 'hardcover' ? 'Hardcover' : providerById(s).label)

export interface ExtractedPage {
  provider: MetadataSource
  providerId: string
  url: string
  title: string
  subtitle: null
  authors: string[]
  translators: string[]
  publisher: string | null
  year: string | null
  /** the full publication date (ISO) when the source knows it; capture providers don't */
  publishedOn: string | null
  pageCount: number | null
  isbn13: string | null
  isbn10: string | null
  series: { name: string; position: number | null } | null
  language: string | null
  coverUrl: string | null
  description: string | null
  /** read from a marker in the page title ("כרך ב'"); null when the title has none */
  volume: ItemVolume | null
  /** the page title as printed, when stripping a volume marker changed it */
  importedTitle: string | null
}

/** What a provider reads off its page: the volume marker is still on the title. */
export type UnmarkedPage = Omit<ExtractedPage, 'importedTitle'>

export interface BookPageProvider {
  id: ProviderId
  label: string
  hosts: readonly string[]
  coverHosts: readonly string[]
  /** where a cover on `coverHosts` may redirect to (followed hop by hop, each hop checked) */
  coverRedirectHosts: readonly (string | RegExp)[]
  /** its book pages carry a schema.org Book, so the bookmarklet can send them */
  bookmarklet: boolean
  /** the site's own search page, opened in a new tab */
  searchUrl(query: string): string
  bookId(url: URL): string | null
  canonicalUrl(id: string): string
  /** the address the server reads for a book (`id` from `bookId`), and how its answer becomes a capture; `detailsUrl`
   *  is an optional second read whose answer (null if it failed) only adds details, like an edition's page count (#102) */
  fetch: { url(id: string): string; detailsUrl?(id: string): string | null; accept: string; capture(body: string, url: string, details?: string | null): PageCapture | null }
  extract(capture: PageCapture): Result<UnmarkedPage, ExtractError>
}

export const providers: readonly BookPageProvider[] = [simania, openLibrary, nli]

export const providerById = (id: ProviderId): BookPageProvider => (id === 'simania' ? simania : id === 'nli' ? nli : openLibrary)

/** Where a book is looked up first: Hardcover (when set up) replaces Open Library, Simania stays for the rest. */
export function defaultSourceFor(book: { language: string | null; title: string }, hardcover: boolean): MetadataSource {
  const provider = defaultProviderFor(book)
  return hardcover && provider === 'openlibrary' ? 'hardcover' : provider
}

const HEBREW = /[֐-׿]/
const LATIN = /[a-z]/i

/** Where a book is looked up first: Open Library for an English book, Simania for everything else. */
export function defaultProviderFor(book: { language: string | null; title: string }): ProviderId {
  const language = book.language?.trim().toLowerCase() ?? ''
  if (language === 'en' || language === 'eng' || language.startsWith('en-') || language === 'english') return 'openlibrary'
  if (language !== '') return 'simania'
  return LATIN.test(book.title) && !HEBREW.test(book.title) ? 'openlibrary' : 'simania'
}

const parse = (s: string): URL | null => {
  try {
    return new URL(s)
  } catch {
    return null
  }
}

export function providerForUrl(url: string): { provider: BookPageProvider; id: string } | null {
  const u = parse(url)
  if (u === null || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.port !== '' || u.username !== '' || u.password !== '') return null
  const provider = providers.find((p) => p.hosts.includes(u.hostname))
  const id = provider?.bookId(u) ?? null
  return provider !== undefined && id !== null ? { provider, id } : null
}

export function pageFromText(text: string): { provider: BookPageProvider; id: string } | null {
  const url = /https?:\/\/\S+/i.exec(text)?.[0]
  return url === undefined ? null : providerForUrl(url)
}

export function providerForOrigin(origin: string): BookPageProvider | null {
  const u = parse(origin)
  if (u === null || u.protocol !== 'https:' || u.port !== '' || u.origin !== origin) return null
  return providers.find((p) => p.bookmarklet && p.hosts.includes(u.hostname)) ?? null
}

export const HARDCOVER_COVER_HOSTS: readonly string[] = ['assets.hardcover.app']

export function isAllowedCoverUrl(url: string): boolean {
  const u = parse(url)
  return u !== null && u.protocol === 'https:' && u.port === '' && u.username === '' && u.password === '' && (providers.some((p) => p.coverHosts.includes(u.hostname)) || HARDCOVER_COVER_HOSTS.includes(u.hostname))
}

const plainHttps = (u: URL | null): u is URL => u !== null && u.protocol === 'https:' && u.port === '' && u.username === '' && u.password === ''

/** A hop a cover download may follow, from a cover of `from`'s provider. */
export function isAllowedCoverRedirect(from: string, to: string): boolean {
  const [a, b] = [parse(from), parse(to)]
  if (!plainHttps(a) || !plainHttps(b)) return false
  const provider = providers.find((p) => p.coverHosts.includes(a.hostname) || p.coverRedirectHosts.some((h) => (typeof h === 'string' ? h === a.hostname : h.test(a.hostname))))
  return provider !== undefined && (provider.coverHosts.includes(b.hostname) || provider.coverRedirectHosts.some((h) => (typeof h === 'string' ? h === b.hostname : h.test(b.hostname))))
}

export function extractPage(capture: PageCapture): Result<ExtractedPage, ExtractError> {
  const u = parse(capture.url)
  const provider = u === null ? undefined : providers.find((p) => p.hosts.includes(u.hostname))
  if (provider === undefined) return err('unknown_page')
  const page = provider.extract(capture)
  if (!page.ok) return page
  // "כרך ב'" on the page title is the edition's volume, not part of the book's title (#66)
  const marked = volumeFromTitles(page.value.title, null)
  return ok({ ...page.value, importedTitle: importedTitleOf(page.value.title, null, marked)?.title ?? null, title: marked.title, volume: marked.volume ?? page.value.volume })
}

/** The linked page wins for what it knows; the AI's reading keeps the series position (spec §7). */
export function mergeLinkedPage(item: ExternalItem, page: ExtractedPage): ExternalItem {
  const aiSeries = item.series[0] ?? null
  const seriesName = page.series?.name ?? aiSeries?.name ?? null
  // An explicit "#n" on the page wins; otherwise the AI's number counts only for the same series.
  const sameSeries = aiSeries !== null && (page.series === null || normalizeText(aiSeries.name) === normalizeText(page.series.name))
  const position = page.series?.position ?? (sameSeries ? aiSeries.position : null)
  return {
    ...item,
    title: page.title,
    importedTitle: page.importedTitle !== null || item.importedTitle !== null ? { title: page.importedTitle ?? page.title, subtitle: item.importedTitle?.subtitle ?? item.subtitle } : null,
    volume: page.volume ?? item.volume,
    // Open Library lists every contributor of a work (illustrators too): the names on the spine win there
    authors: page.authors.length > 0 && (page.provider !== 'openlibrary' || item.authors.length === 0) ? page.authors : item.authors,
    translators: page.translators.length > 0 ? page.translators : item.translators,
    publisher: page.publisher ?? item.publisher,
    pageCount: page.pageCount ?? item.pageCount,
    language: page.language ?? item.language,
    description: page.description ?? item.description,
    coverUrl: page.coverUrl ?? item.coverUrl,
    series: seriesName === null ? [] : [{ name: seriesName, position, positionEnd: null }],
    identifiers: {
      ...item.identifiers,
      isbn13: page.isbn13 ?? item.identifiers.isbn13,
      isbn10: page.isbn10 ?? item.identifiers.isbn10,
      others: { ...item.identifiers.others, [page.provider]: page.providerId },
    },
  }
}
