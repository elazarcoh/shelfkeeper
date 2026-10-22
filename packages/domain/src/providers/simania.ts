import { err, ok, type Result } from '../result'
import { bookNode, clean, imageUrl, names, validIsbns } from './extract'
import type { BookPageProvider, ExtractError, UnmarkedPage } from './index'
import { captureFromHtml, type PageCapture } from './page-capture'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "ארטמיס פאול #3 - צופן הנצח" → { title: "צופן הנצח", position: 3 }; also drops "(2008)" and "[מהדורת 2018]". */
export function cleanSimaniaTitle(raw: string, series: string | null): { title: string; position: number | null } {
  let title = raw.replace(/\s+/g, ' ').trim()
  let position: number | null = null
  if (series !== null) {
    const m = new RegExp(`^${escapeRe(series)}\\s*(?:#\\s*(\\d+))?\\s*[-–—:]\\s*(.+)$`).exec(title)
    if (m?.[2]) {
      title = m[2]
      position = m[1] !== undefined ? Number(m[1]) : null
    }
  }
  title = title.replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\s*\((?:1[89]|20)\d{2}\)\s*$/, '').trim()
  return { title, position }
}

/** "(מאנגלית) עפרה אביגד" → "עפרה אביגד" */
export const cleanTranslator = (name: string): string => name.replace(/^\s*\([^)]*\)\s*/, '').trim()

export const simania: BookPageProvider = {
  id: 'simania',
  label: 'Simania',
  hosts: ['simania.co.il', 'www.simania.co.il'],
  coverHosts: ['cdn.simania.co.il'],
  coverRedirectHosts: [],
  bookmarklet: true,
  searchUrl: (query) => `https://simania.co.il/search?query=${encodeURIComponent(query)}`,
  bookId: (url) => (url.pathname === '/bookdetails.php' && /^\d{1,12}$/.test(url.searchParams.get('item_id') ?? '') ? url.searchParams.get('item_id') : null),
  canonicalUrl: (id) => `https://simania.co.il/bookdetails.php?item_id=${id}`,
  fetch: { url: (id) => simania.canonicalUrl(id), accept: 'text/html', capture: (html, url) => captureFromHtml(html, url) },
  extract(capture: PageCapture): Result<UnmarkedPage, ExtractError> {
    let url: URL
    try {
      url = new URL(capture.url)
    } catch {
      return err('unknown_page')
    }
    const id = simania.bookId(url)
    if (id === null) return err('not_a_book_page')
    const book = bookNode(capture)
    if (book === null || clean(book['name']) === null) return err('not_a_book_page')
    const declared = clean(book['url']) ?? clean(book['@id'])
    if (declared !== null && !new RegExp(`item_id=${id}(?:\\D|$)`).test(declared)) return err('stale')
    const m = capture.meta
    const seriesName = names(book['isPartOf'])[0] ?? null
    const { title, position } = cleanSimaniaTitle(clean(book['name']) ?? '', seriesName)
    const pagesFromTag = /(\d+)\s*עמודים/.exec(m['book:tag'] ?? '')?.[1]
    const pages = typeof book['numberOfPages'] === 'number' ? book['numberOfPages'] : pagesFromTag !== undefined ? Number(pagesFromTag) : null
    const published = book['datePublished'] ?? m['book:release_date']
    const year = /^\d{4}/.exec(typeof published === 'string' ? published : '')?.[0] ?? null
    return ok({
      provider: 'simania',
      providerId: id,
      url: simania.canonicalUrl(id),
      title,
      subtitle: null,
      authors: names(book['author']).length > 0 ? names(book['author']) : names(m['book:author']),
      translators: names(book['translator']).map(cleanTranslator).filter((t) => t !== ''),
      publisher: names(book['publisher'])[0] ?? null,
      year,
      publishedOn: null,
      pageCount: pages !== null && Number.isInteger(pages) && pages > 0 && pages < 100_000 ? pages : null,
      ...validIsbns(book['isbn'], m['book:isbn']),
      series: seriesName === null ? null : { name: seriesName, position },
      language: clean(book['inLanguage']),
      coverUrl: imageUrl(book['image']) ?? clean(m['og:image']),
      description: clean(book['description']),
      volume: null,
    })
  },
}
