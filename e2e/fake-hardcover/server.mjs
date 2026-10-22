// A stand-in Hardcover GraphQL API for the e2e stack (POST /v1/graphql), with three books.
import { createServer } from 'node:http'

const TOKEN = 'fake-hardcover-token-e2e-0001'
const tags = { Genre: [{ tag: 'Classics', count: 5 }], Mood: [{ tag: 'romantic', count: 3 }] }
const books = {
  1001: { id: 1001, slug: 'hardcover-pride-z', title: 'Hardcover Pride Z', rating: 4.3, ratings_count: 1234, cached_tags: tags, cached_similar_book_ids: [1002, 9999] },
  1002: { id: 1002, slug: 'hardcover-cities-z', title: 'Hardcover Cities Z', rating: 3.9, ratings_count: 88, cached_tags: {}, cached_similar_book_ids: [1001] },
  // found only by searching: its author differs from the book's, so the nightly match never takes it
  1003: { id: 1003, slug: 'hardcover-lonely-z', title: 'Hardcover Lonely Z', rating: 4.8, ratings_count: 7, cached_tags: {}, cached_similar_book_ids: [] },
}
// the books of the Fetch metadata specs (#146), linkable by id or slug
books[3001] = { id: 3001, slug: 'wyrm-serial-z', title: 'Wyrm Serial Z', rating: 4.2, ratings_count: 51, cached_tags: {}, cached_similar_book_ids: [] }
books[3002] = { id: 3002, slug: 'isbn-lookup-z', title: 'Isbn Lookup Z', rating: 3.5, ratings_count: 4, cached_tags: {}, cached_similar_book_ids: [] }
const editions = [
  { id: 1101, isbn_13: '9780141439518', isbn_10: null, book_id: 1001 },
  { id: 3102, isbn_13: '9789003000019', isbn_10: null, book_id: 3002 },
  { isbn_13: '9780141439600', isbn_10: null, book_id: 1002 },
  // the What next spec's library books
  { isbn_13: '9789001000011', isbn_10: null, book_id: 2001 },
  { isbn_13: '9789001000028', isbn_10: null, book_id: 2002 },
  { isbn_13: '9789001000035', isbn_10: null, book_id: 2004 },
]

// What next (#56): a series of three (the library holds 1 and 2), its author, a book of the author's released two months ago
// (computed when the server starts, so it stays inside the page's window), a recommended book at #2 of a series the library lacks
// (whose #1 the fake lists), and a book on the fake user's Read list that the recommendations also name.
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const AUTHOR = { id: 8001, name: 'Wnxt Author' }
const SAGA = { id: 7001, name: 'Wnxt Saga' }
const OTHER = { id: 7002, name: 'Wnxt Other Saga' }
const detail = (id, title, extra = {}) => ({
  id,
  title,
  pages: 300,
  release_date: '2015-05-05',
  cached_image: null,
  cached_contributors: [{ author: AUTHOR, contribution: 'Author' }],
  cached_tags: {},
  book_series: [],
  ...extra,
})
const inSeries = (series, position) => [{ position, featured: true, series }]
const details = {
  2001: detail(2001, 'Wnxt Saga One', { book_series: inSeries(SAGA, 1) }),
  2002: detail(2002, 'Wnxt Saga Two', { book_series: inSeries(SAGA, 2) }),
  2003: detail(2003, 'Wnxt Saga Three', { book_series: inSeries(SAGA, 3) }),
  2004: detail(2004, 'Wnxt Standalone'),
  2010: detail(2010, 'Wnxt New Release', { release_date: daysAgo(60) }),
  2020: detail(2020, 'Wnxt Other One', { book_series: inSeries(OTHER, 1), cached_contributors: [] }),
  2021: detail(2021, 'Wnxt Other Two', { book_series: inSeries(OTHER, 2), cached_contributors: [] }),
  2030: detail(2030, 'Wnxt Already Read', { cached_contributors: [] }),
}
for (const id of [2001, 2002, 2004]) books[id] = { id, slug: `wnxt-${id}`, title: details[id].title, rating: 4, ratings_count: 10, cached_tags: {}, cached_similar_book_ids: [] }
const seriesRows = [
  { series_id: SAGA.id, position: 1, series: { name: SAGA.name }, book: { id: 2001, title: 'Wnxt Saga One', release_date: '2015-05-05', users_count: 90 } },
  { series_id: SAGA.id, position: 2, series: { name: SAGA.name }, book: { id: 2002, title: 'Wnxt Saga Two', release_date: '2016-05-05', users_count: 80 } },
  // a split audio volume at the same position: the client drops it
  { series_id: SAGA.id, position: 3, series: { name: SAGA.name }, book: { id: 2999, title: 'Wnxt Saga Three (1 of 2)', release_date: '2017-05-05', users_count: 500 } },
  { series_id: SAGA.id, position: 3, series: { name: SAGA.name }, book: { id: 2003, title: 'Wnxt Saga Three', release_date: '2017-05-05', users_count: 70 } },
  { series_id: OTHER.id, position: 1, series: { name: OTHER.name }, book: { id: 2020, title: 'Wnxt Other One', release_date: '2014-05-05', users_count: 40 } },
  { series_id: OTHER.id, position: 2, series: { name: OTHER.name }, book: { id: 2021, title: 'Wnxt Other Two', release_date: '2015-05-05', users_count: 30 } },
]
// the author's books by release date: the old one lies outside the window the client asks for
const authorRows = [
  { author_id: AUTHOR.id, book: { id: 2010, title: 'Wnxt New Release', release_date: daysAgo(60) } },
  { author_id: AUTHOR.id, book: { id: 2011, title: 'Wnxt Old Release', release_date: daysAgo(1100) } },
]
const READ_LIST = [2030]
const RECOMMENDED = [2021, 2030]

// Fetch metadata (#146): full book pages (no cached_image: the e2e stack has no internet)
const WILD = { id: 8101, name: 'Wildbough Z' }
const PARA = { id: 7101, name: 'Parahumanz' }
const pageEdition = (id, pages, extra = {}) => ({ id, title: 'Wyrm Serial Z', isbn_13: null, isbn_10: null, pages, release_date: '2013-11-19', edition_format: null, reading_format_id: null, publisher: { name: 'Parahumanz.example' }, cached_image: null, language: null, ...extra })
const pages = {
  // linked by z-hardcover through the dialog: a page that adds nothing, so its step is just "Only link"
  1003: { id: 1003, slug: 'hardcover-lonely-z', title: 'Hardcover Lonely Z', description: null, release_date: null, cached_image: null, cached_contributors: [], book_series: [], default_physical_edition_id: null, default_cover_edition_id: null, editions: [] },
  3001: {
    id: 3001,
    slug: 'wyrm-serial-z',
    title: 'Wyrm Serial Z',
    description: 'A girl with bug powers.',
    release_date: '2013-11-19',
    cached_image: null,
    cached_contributors: [{ author: WILD, contribution: 'Author' }],
    book_series: inSeries(PARA, 1),
    default_physical_edition_id: 3101,
    default_cover_edition_id: null,
    editions: [pageEdition(3101, 6073, { edition_format: 'Webnovel' }), pageEdition(3111, 4192), pageEdition(3112, null)],
  },
  3002: {
    id: 3002,
    slug: 'isbn-lookup-z',
    title: 'Isbn Lookup Z',
    description: null,
    release_date: '2020-01-01',
    cached_image: null,
    cached_contributors: [],
    book_series: [],
    default_physical_edition_id: 3102,
    default_cover_edition_id: null,
    editions: [pageEdition(3102, 321, { title: 'Isbn Lookup Z', isbn_13: '9789003000019' })],
  },
}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/graphql') return send(res, 404, { error: 'not found' })
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'invalid_token' })
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const { query, variables = {} } = JSON.parse(raw)
    const op = /(?:query|mutation) (\w+)/.exec(query)?.[1]
    if (op === 'Me') return send(res, 200, { data: { me: [{ id: 1, username: 'fakehome' }] } })
    if (op === 'EditionsByIsbn') return send(res, 200, { data: { editions: editions.filter((e) => variables.isbns.includes(e.isbn_13)) } })
    if (op === 'BooksById') return send(res, 200, { data: { books: variables.ids.flatMap((id) => (books[id] ? [books[id]] : [])) } })
    if (op === 'SearchBooks') {
      const hits = /lonely/i.test(variables.q)
        ? [{ document: { id: '1003', title: 'Hardcover Lonely Z', author_names: ['Original Author'], release_year: 1999, series_names: [] } }]
        : /wyrm/i.test(variables.q)
          ? [{ document: { id: '3001', title: 'Wyrm Serial Z', author_names: ['Wildbough Z'], release_year: 2013, series_names: ['Parahumanz'] } }]
          : []
      return send(res, 200, { data: { search: { results: { hits } } } })
    }
    if (op === 'BookPageById') return send(res, 200, { data: { books: pages[variables.id] ? [pages[variables.id]] : [] } })
    if (op === 'BookPageBySlug') return send(res, 200, { data: { books: Object.values(pages).filter((p) => p.slug === variables.slug) } })
    if (op === 'Recommendations') return send(res, 200, { data: { vibes: [{ cached_book_ids: RECOMMENDED }] } })
    if (op === 'BookDetails') return send(res, 200, { data: { books: variables.ids.flatMap((id) => (details[id] ? [details[id]] : [])) } })
    if (op === 'SeriesBooks') return send(res, 200, { data: { book_series: seriesRows.filter((r) => variables.ids.includes(r.series_id)) } })
    if (op === 'AuthorBooks') {
      const inWindow = (r) => variables.ids.includes(r.author_id) && r.book.release_date >= variables.since && r.book.release_date <= variables.until
      return send(res, 200, { data: { contributions: authorRows.filter(inWindow) } })
    }
    if (op === 'ReadBookIds') return send(res, 200, { data: { user_books: variables.offset === 0 ? READ_LIST.map((book_id) => ({ book_id })) : [] } })
    if (op === 'UserBook') return send(res, 200, { data: { user_books: [] } })
    // the sends (#140): saved, with a made-up id
    if (op === 'InsertUserBook') return send(res, 200, { data: { insert_user_book: { id: 5000 + variables.object.book_id, error: null } } })
    if (op === 'UpdateUserBook') return send(res, 200, { data: { update_user_book: { id: variables.id, error: null } } })
    if (op === 'InsertRead') return send(res, 200, { data: { insert_user_book_read: { id: 1, error: null } } })
    return send(res, 400, { error: 'invalid_query' })
  })
}).listen(80, () => console.log('fake-hardcover listening on :80'))
