import search from '../../../../packages/domain/src/providers/fixtures/openlibrary-search.json'
import work from '../../../../packages/domain/src/providers/fixtures/openlibrary-work.json'
import edition from '../../../../packages/domain/src/providers/fixtures/openlibrary-edition.json'
import editionDetails from '../../../../packages/domain/src/providers/fixtures/openlibrary-edition-details.json'
import isbnAnswer from '../../../../packages/domain/src/providers/fixtures/openlibrary-isbn.json'

export const OPEN_LIBRARY_TEST_URL = 'https://openlibrary.org'
export let openLibraryFetches: { url: string; headers: Record<string, string> }[] = []
export const resetOpenLibraryFetches = () => {
  openLibraryFetches = []
}

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))

/** Open Library's search API: "lost colony" finds the fixture search, the Kingkiller work by its key, the Fantastic Mr Fox edition by its key; anything else finds nothing. */
export function openLibraryFixtureFetch() {
  return (url: string, init: { headers: Record<string, string> }): Promise<Response> => {
    openLibraryFetches.push({ url, headers: init.headers })
    const u = new URL(url)
    // the Books API knows the Fantastic Mr Fox edition (its page count); it is down for any other
    if (u.pathname === '/api/books') return u.searchParams.get('bibkeys') === 'OLID:OL7353617M' ? json(editionDetails) : Promise.resolve(new Response(null, { status: 503 }))
    if (u.pathname !== '/search.json') return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://openlibrary.org/' } }))
    const q = u.searchParams.get('q') ?? ''
    if (q === 'broken') return Promise.resolve(new Response('<html>busy</html>', { status: 200 }))
    if (q === 'down') return Promise.resolve(new Response(null, { status: 503 }))
    if (q.includes('lost colony')) return json(search)
    if (q === 'key:/works/OL8479867W') return json(work)
    if (q === 'edition_key:OL7353617M') return json(edition)
    // #157: Harry Potter and the Chamber of Secrets by its ISBN
    if (q === 'isbn:9780747538486') return json(isbnAnswer)
    // an edition the search knows but the Books API doesn't
    if (q === 'edition_key:OL9M') return json({ docs: edition.docs.map((d) => ({ ...d, editions: { docs: [{ key: '/books/OL9M' }] } })) })
    return json({ numFound: 0, docs: [] })
  }
}

export const OPEN_LIBRARY_COVERS_TEST_URL = 'https://covers.openlibrary.org'

/** Open Library's cover host: cover 1 is an image, cover 2 is not, cover 3 redirects off the site. */
export function openLibraryCoversFixtureFetch(png: Uint8Array) {
  return (url: string): Promise<Response> => {
    const path = new URL(url).pathname
    if (path === '/b/id/1-L.jpg') return Promise.resolve(new Response(png.slice(), { status: 200, headers: { 'content-type': 'image/png' } }))
    if (path === '/b/id/3-L.jpg') return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example/x.jpg' } }))
    return Promise.resolve(new Response('<html>not a picture</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  }
}
