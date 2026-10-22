import { describe, expect, it } from 'vitest'
import { ExternalItem } from '../sources'
import search from './fixtures/openlibrary-search.json'
import work from './fixtures/openlibrary-work.json'
import edition from './fixtures/openlibrary-edition.json'
import editionDetails from './fixtures/openlibrary-edition-details.json'
import isbnAnswer from './fixtures/openlibrary-isbn.json'
import { defaultProviderFor, extractPage, isAllowedCoverRedirect, isAllowedCoverUrl, mergeLinkedPage, openLibraryIsbnCapture, openLibraryIsbnUrl, openLibraryResults, openLibrarySearchUrl, pageFromText, PageCapture, providerById, providerForOrigin } from '.'

const page = (c: unknown) => {
  const r = extractPage(PageCapture.parse(c))
  if (!r.ok) throw new Error(r.error)
  return r.value
}
const ol = providerById('openlibrary')

describe('Open Library search', () => {
  it('reads every result of a search, best first, as a capture the extractor accepts', () => {
    const results = openLibraryResults(search)
    expect(results.length).toBeGreaterThanOrEqual(3)
    expect(page(results[0])).toEqual({
      provider: 'openlibrary', providerId: 'OL5725977W', url: 'https://openlibrary.org/works/OL5725977W', title: 'Artemis Fowl. The Lost Colony', subtitle: null,
      authors: ['Eoin Colfer'], translators: [], publisher: null, year: '2006', publishedOn: null, pageCount: null, isbn13: null, isbn10: null, series: null, language: null,
      coverUrl: 'https://covers.openlibrary.org/b/id/12636224-L.jpg', description: null,
      volume: null, importedTitle: null,
    })
  })
  it('keeps the series and its number', () => {
    expect(page(openLibraryResults(work)[0])).toMatchObject({ providerId: 'OL8479867W', title: 'The Name of the Wind', series: { name: 'The Kingkiller Chronicle', position: 1 } })
  })
  it('skips results without a work key or a title; garbage gives nothing', () => {
    expect(openLibraryResults({ docs: [{ key: '/authors/OL1A', title: 'x' }, { key: '/works/OL1W', title: '  ' }, { key: '/works/OL2W', title: 'Kept', cover_i: 'no' }, 7] }).map((c) => c.title)).toEqual(['Kept'])
    expect(openLibraryResults(null)).toEqual([])
    expect(openLibraryResults({ docs: 'x' })).toEqual([])
  })
  it('the search address encodes the query and asks only for the fields it reads', () => {
    expect(openLibrarySearchUrl('the hobbit & co')).toBe('https://openlibrary.org/search.json?q=the%20hobbit%20%26%20co&limit=8&fields=key,title,author_name,first_publish_year,cover_i,series_name,series_position')
  })
})

describe('Open Library links', () => {
  it('a pasted work or edition link, with or without a slug; nothing else on the site', () => {
    expect(pageFromText('see https://openlibrary.org/works/OL8479867W/The_Name_of_the_Wind?edition=x')).toMatchObject({ id: 'OL8479867W' })
    expect(pageFromText('https://openlibrary.org/books/OL7353617M/Fantastic_Mr._Fox')).toMatchObject({ id: 'OL7353617M' })
    expect(pageFromText('https://www.openlibrary.org/works/OL1W')).toMatchObject({ id: 'OL1W' })
    expect(pageFromText('https://openlibrary.org/authors/OL23919A')).toBeNull()
    expect(pageFromText('https://openlibrary.org/works/OL1W/a/b')).toBeNull()
    expect(pageFromText('https://openlibrary.org.evil.test/works/OL1W')).toBeNull()
  })
  it('the server reads one work or edition through the search API, never the pasted address', () => {
    expect(ol.fetch.url('OL8479867W')).toBe(openLibrarySearchUrl('key:/works/OL8479867W', 1))
    expect(ol.fetch.url('OL7353617M')).toBe(openLibrarySearchUrl('edition_key:OL7353617M', 1, true))
    expect(ol.fetch.url('OL7353617M')).toContain(',editions.cover_i,')
    // and, for an edition only, its own record for the page count the search doesn't have
    expect(ol.fetch.detailsUrl?.('OL7353617M')).toBe('https://openlibrary.org/api/books?bibkeys=OLID%3AOL7353617M&format=json&jscmd=details')
    expect(ol.fetch.detailsUrl?.('OL8479867W')).toBeNull()
  })
  it('an edition link keeps that edition: its cover, publisher, year and ISBNs, on its work (#102)', () => {
    const capture = ol.fetch.capture(JSON.stringify(edition), ol.canonicalUrl('OL7353617M'), JSON.stringify(editionDetails))
    expect(capture === null ? null : page(capture)).toEqual({
      provider: 'openlibrary', providerId: 'OL45804W', url: 'https://openlibrary.org/books/OL7353617M', title: 'Fantastic Mr Fox', subtitle: null,
      authors: ['Roald Dahl'], translators: [], publisher: 'Puffin', year: '1988', publishedOn: null, pageCount: 96, isbn13: '9780140328721', isbn10: '0140328726', series: null, language: 'eng',
      coverUrl: 'https://covers.openlibrary.org/b/id/15152634-L.jpg', description: null,
      volume: null, importedTitle: null,
    })
    expect(ol.fetch.capture('not json', 'x')).toBeNull()
    expect(ol.fetch.capture('{"docs":[]}', 'x')).toBeNull()
  })
  it("an edition without its own cover or details falls back to the work's", () => {
    const bare = { docs: [{ ...edition.docs[0], editions: { docs: [{ key: '/books/OL7353617M' }] } }] }
    const capture = ol.fetch.capture(JSON.stringify(bare), ol.canonicalUrl('OL7353617M'))
    expect(capture === null ? null : page(capture)).toMatchObject({ providerId: 'OL45804W', url: 'https://openlibrary.org/books/OL7353617M', coverUrl: 'https://covers.openlibrary.org/b/id/6498519-L.jpg', year: '1970', publisher: null, isbn13: null, pageCount: null })
  })
  it("the page count comes only from that edition's own record; a missing, failed or odd one leaves it unknown", () => {
    const pages = (details: unknown) => {
      const c = ol.fetch.capture(JSON.stringify(edition), ol.canonicalUrl('OL7353617M'), details === undefined ? null : JSON.stringify(details))
      return c === null ? 'no capture' : page(c).pageCount
    }
    expect(pages(undefined)).toBeNull()
    expect(pages({})).toBeNull()
    expect(pages({ 'OLID:OL1M': { details: { number_of_pages: 300 } } })).toBeNull()
    expect(pages({ 'OLID:OL7353617M': { details: { number_of_pages: 0 } } })).toBeNull()
    expect(pages({ 'OLID:OL7353617M': { details: { number_of_pages: '96' } } })).toBeNull()
    expect(pages({ 'OLID:OL7353617M': { details: { number_of_pages: 412 } } })).toBe(412)
    expect(ol.fetch.capture(JSON.stringify(edition), ol.canonicalUrl('OL7353617M'), 'not json')).not.toBeNull()
  })
  it('a lookup answered with another edition (or none) is refused', () => {
    const other = { docs: [{ ...edition.docs[0], editions: { docs: [{ key: '/books/OL1M' }] } }] }
    expect(ol.fetch.capture(JSON.stringify(other), ol.canonicalUrl('OL7353617M'))).toBeNull()
    const none = { docs: [{ ...edition.docs[0], editions: undefined }] }
    expect(ol.fetch.capture(JSON.stringify(none), ol.canonicalUrl('OL7353617M'))).toBeNull()
  })
  it('refuses a capture whose book is another work, or that has no book', () => {
    const c = openLibraryResults(work)[0]
    if (c === undefined) throw new Error('no result')
    expect(extractPage({ ...c, url: 'https://openlibrary.org/works/OL1W' })).toEqual({ ok: false, error: 'stale' })
    expect(extractPage({ ...c, ld: [] })).toEqual({ ok: false, error: 'not_a_book_page' })
    expect(extractPage({ ...c, url: 'https://openlibrary.org/books/OL7353617M' })).toEqual({ ok: false, error: 'stale' })
    // an edition's capture must name the edition and a work
    const e = ol.fetch.capture(JSON.stringify(edition), ol.canonicalUrl('OL7353617M'))
    if (e === null) throw new Error('no capture')
    expect(extractPage({ ...e, url: 'https://openlibrary.org/books/OL1M' })).toEqual({ ok: false, error: 'stale' })
    const [node] = e.ld as Record<string, unknown>[]
    expect(extractPage({ ...e, ld: [{ ...node, exampleOfWork: null }] })).toEqual({ ok: false, error: 'not_a_book_page' })
  })
  it('the bookmarklet is never accepted from Open Library (its pages have no Book data)', () => {
    expect(providerForOrigin('https://openlibrary.org')).toBeNull()
    expect(providerForOrigin('https://simania.co.il')?.id).toBe('simania')
  })
})

describe('Open Library covers', () => {
  it('only from covers.openlibrary.org, following redirects only into archive.org storage', () => {
    expect(isAllowedCoverUrl('https://covers.openlibrary.org/b/id/1-L.jpg')).toBe(true)
    expect(isAllowedCoverUrl('https://archive.org/download/x.jpg')).toBe(false)
    const cover = 'https://covers.openlibrary.org/b/id/1-L.jpg'
    expect(isAllowedCoverRedirect(cover, 'https://archive.org/download/l_covers_0012/x.zip/1-L.jpg')).toBe(true)
    expect(isAllowedCoverRedirect('https://archive.org/download/x', 'https://ia800100.us.archive.org/view_archive.php?x')).toBe(true)
    expect(isAllowedCoverRedirect(cover, 'https://evil.test/x.jpg')).toBe(false)
    expect(isAllowedCoverRedirect(cover, 'http://archive.org/x.jpg')).toBe(false)
    expect(isAllowedCoverRedirect(cover, 'https://ia1.us.archive.org.evil.test/x')).toBe(false)
    expect(isAllowedCoverRedirect('https://cdn.simania.co.il/a.jpg', 'https://evil.test/x.jpg')).toBe(false)
    expect(isAllowedCoverRedirect('https://evil.test/a.jpg', 'https://archive.org/x.jpg')).toBe(false)
  })
})

describe('merging an Open Library work', () => {
  it('fills the title, series and cover; keeps the spine authors and everything only an edition knows', () => {
    const item = ExternalItem.parse({ externalId: 'photo:1', format: 'physical', title: 'name of the wind', authors: ['Patrick Rothfuss'], publisher: 'DAW', pageCount: 662, identifiers: { isbn13: '9780756404741' } })
    expect(mergeLinkedPage(item, page(openLibraryResults(work)[0]))).toMatchObject({
      title: 'The Name of the Wind', authors: ['Patrick Rothfuss'], publisher: 'DAW', pageCount: 662,
      series: [{ name: 'The Kingkiller Chronicle', position: 1 }], identifiers: { isbn13: '9780756404741', others: { openlibrary: 'OL8479867W' } },
      coverUrl: 'https://covers.openlibrary.org/b/id/11480483-L.jpg',
    })
  })
  it('takes the authors when the spine had none', () => {
    const item = ExternalItem.parse({ externalId: 'photo:2', format: 'physical', title: 'x', authors: [] })
    expect(mergeLinkedPage(item, page(openLibraryResults(work)[0])).authors).toEqual(['Patrick Rothfuss', 'Marc Simonetti'])
  })
})

describe('defaultProviderFor', () => {
  it('Open Library for English, Simania for everything else; the title script decides when the language is unknown', () => {
    expect(defaultProviderFor({ language: 'en', title: 'ספר' })).toBe('openlibrary')
    expect(defaultProviderFor({ language: 'EN-GB', title: 'x' })).toBe('openlibrary')
    expect(defaultProviderFor({ language: 'he', title: 'Harry Potter' })).toBe('simania')
    expect(defaultProviderFor({ language: null, title: 'The Hobbit' })).toBe('openlibrary')
    expect(defaultProviderFor({ language: '', title: 'הוביט' })).toBe('simania')
    expect(defaultProviderFor({ language: null, title: 'Harry Potter הארי פוטר' })).toBe('simania')
    expect(defaultProviderFor({ language: null, title: '1984' })).toBe('simania')
  })
})

// #157: a scanned ISBN is one search, whose answer carries the edition it matched
describe('Open Library by ISBN', () => {
  it('reads the matched edition from one search', () => {
    expect(openLibraryIsbnUrl('9780747538486')).toContain('q=isbn%3A9780747538486&limit=1&')
    const capture = openLibraryIsbnCapture(isbnAnswer)
    if (capture === null) throw new Error('no capture')
    expect(capture.url).toBe('https://openlibrary.org/books/OL59041259M')
    const page = extractPage(capture)
    expect(page.ok && page.value).toMatchObject({ provider: 'openlibrary', providerId: 'OL82537W', title: 'Harry Potter and the Chamber of Secrets', publisher: 'Bloomsbury', isbn13: '9780747538486', isbn10: '0747538484', series: { name: 'Harry Potter', position: 2 } })
  })
  it('falls back to the work, and finds nothing in an empty answer', () => {
    const noEdition = { docs: [{ ...isbnAnswer.docs[0], editions: undefined }] }
    expect(openLibraryIsbnCapture(noEdition)?.url).toBe('https://openlibrary.org/works/OL82537W')
    expect(openLibraryIsbnCapture({ docs: [] })).toBeNull()
  })
})
