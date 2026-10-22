import librariesJson from './audiobookshelf/fixtures/libraries.json'
import pageJson from './audiobookshelf/fixtures/items-page-0.json'
import hp1Json from './audiobookshelf/fixtures/li_hp1.json'
import mistbornJson from './audiobookshelf/fixtures/li_mistborn.json'
import calibreBooksJson from './calibre/fixtures/books.json'
import calibreInfoJson from './calibre/fixtures/library-info.json'
import calibreSearchJson from './calibre/fixtures/search.json'
import arrAuthorJson from './arr/fixtures/author.json'
import arrBookJson from './arr/fixtures/book.json'
import arrBookFileJson from './arr/fixtures/bookfile.json'
import arrRootFolderJson from './arr/fixtures/rootfolder.json'
import arrStatusJson from './arr/fixtures/system-status.json'
import type { PostLike } from './hardcover/client'
import type { FetchLike } from './http'

export const ABS_FIXTURE_TOKEN = 'fixture-token'
export const CALIBRE_FIXTURE_USER = 'reader'
export const CALIBRE_FIXTURE_PASSWORD = 'fixture-pass'
export const ARR_FIXTURE_KEY = 'fixture-key'

const items: Record<string, unknown> = { li_mistborn: mistbornJson, li_hp1: hp1Json }

/** A 1×1 PNG, served as every fixture cover. */
export const COVER_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

/** A fake Audiobookshelf serving the recorded fixtures (library "lib_books"). */
export function absFixtureFetch(baseUrl: string): FetchLike {
  return (url, init) => {
    if (init.headers.authorization !== `Bearer ${ABS_FIXTURE_TOKEN}`) return Promise.resolve(new Response('Unauthorized', { status: 401 }))
    const u = new URL(url)
    if (!url.startsWith(baseUrl)) return Promise.reject(new Error(`unexpected host ${u.host}`))
    if (u.pathname === '/api/libraries') return Promise.resolve(Response.json(librariesJson))
    if (u.pathname === '/api/libraries/lib_books/items') {
      return Promise.resolve(u.searchParams.get('page') === '0' ? Response.json(pageJson) : Response.json({ ...pageJson, results: [], page: Number(u.searchParams.get('page')) }))
    }
    if (u.pathname === '/api/libraries/lib_pods/items') return Promise.resolve(Response.json({ results: [], total: 0, limit: 100, page: 0 }))
    if (/^\/api\/items\/[^/]+\/cover$/.test(u.pathname)) {
      return Promise.resolve(new Response(COVER_PNG, { headers: { 'content-type': 'image/png' } }))
    }
    const match = /^\/api\/items\/([^/]+)$/.exec(u.pathname)
    const body = match?.[1] === undefined ? undefined : items[decodeURIComponent(match[1])]
    return Promise.resolve(body === undefined ? new Response('Not found', { status: 404 }) : Response.json(body))
  }
}

/** A fake Calibre content server (Basic auth) serving the recorded fixtures; search honours num/offset. */
export function calibreFixtureFetch(baseUrl: string): FetchLike {
  const expected = `Basic ${Buffer.from(`${CALIBRE_FIXTURE_USER}:${CALIBRE_FIXTURE_PASSWORD}`).toString('base64')}`
  const books = calibreBooksJson as Record<string, unknown>
  return (url, init) => {
    if (!url.startsWith(baseUrl)) return Promise.reject(new Error(`unexpected host ${new URL(url).host}`))
    const u = new URL(url)
    if (init.headers.authorization !== expected) return Promise.resolve(new Response('Unauthorized', { status: 401 }))
    if (u.pathname === '/ajax/library-info') return Promise.resolve(Response.json(calibreInfoJson))
    if (u.pathname === '/ajax/search/Calibre_Library') {
      const num = Number(u.searchParams.get('num') ?? '100')
      const offset = Number(u.searchParams.get('offset') ?? '0')
      return Promise.resolve(Response.json({ ...calibreSearchJson, offset, num, book_ids: calibreSearchJson.book_ids.slice(offset, offset + num) }))
    }
    if (u.pathname === '/ajax/books/Calibre_Library') {
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter((s) => s !== '')
      return Promise.resolve(Response.json(Object.fromEntries(ids.map((id) => [id, books[id] ?? null]))))
    }
    if (/^\/get\/cover\/\d+\/Calibre_Library$/.test(u.pathname)) return Promise.resolve(new Response(COVER_PNG, { headers: { 'content-type': 'image/png' } }))
    return Promise.resolve(new Response('Not found', { status: 404 }))
  }
}

/** A fake Readarr (or Chaptarr, by appName) serving the recorded fixtures; /bookfile filters by repeated bookId. */
export function arrFixtureFetch(baseUrl: string, appName = 'Readarr'): FetchLike {
  return (url, init) => {
    if (!url.startsWith(baseUrl)) return Promise.reject(new Error(`unexpected host ${new URL(url).host}`))
    if (init.headers['x-api-key'] !== ARR_FIXTURE_KEY) return Promise.resolve(new Response('Unauthorized', { status: 401 }))
    const u = new URL(url)
    if (u.pathname === '/api/v1/system/status') return Promise.resolve(Response.json({ ...arrStatusJson, appName, instanceName: appName }))
    if (u.pathname === '/api/v1/author') return Promise.resolve(Response.json(arrAuthorJson))
    if (u.pathname === '/api/v1/book') return Promise.resolve(Response.json(arrBookJson))
    if (u.pathname === '/api/v1/rootfolder') return Promise.resolve(Response.json(arrRootFolderJson))
    if (u.pathname === '/api/v1/bookfile') {
      const ids = u.searchParams.getAll('bookId').map(Number)
      if (ids.length === 0) return Promise.resolve(new Response('authorId, bookId or bookFileIds must be provided', { status: 400 }))
      return Promise.resolve(Response.json(arrBookFileJson.filter((f) => ids.includes(f.bookId))))
    }
    if (u.pathname.startsWith('/MediaCover/')) return Promise.resolve(new Response(COVER_PNG, { headers: { 'content-type': 'image/png' } }))
    return Promise.resolve(new Response('Not found', { status: 404 }))
  }
}

/** Routes each request to the fake server for its origin. */
export function routeFetch(routes: Record<string, FetchLike>): FetchLike {
  return (url, init) => {
    const route = routes[new URL(url).origin]
    return route ? route(url, init) : Promise.reject(new Error(`no fake server for ${new URL(url).origin}`))
  }
}

export interface HardcoverFixtures {
  token: string
  me?: { id: number; username: string }
  editions?: { id?: number; isbn_13: string | null; isbn_10: string | null; book_id: number }[]
  books?: Record<number, unknown>
  search?: { id: string; title: string; author_names: string[]; series_names?: string[]; image?: { url: string } | null }[]
  vibes?: number[]
  /** raw `books` rows (with nested `editions`) for BookPageById / BookPageBySlug, by id */
  pages?: Record<number, unknown>
  /** raw `books` rows for BookDetails, by id */
  detailBooks?: Record<number, unknown>
  /** raw `book_series` rows; compilations are dropped like the query does */
  series?: { series_id: number; position: number | null; series: { name: string } | null; book: { id: number; title: string; release_date: string | null; users_count: number; compilation: boolean } }[]
  /** raw `contributions` rows; compilations are dropped like the query does */
  contributions?: { author_id: number; contribution: string | null; book: { id: number; title: string; release_date: string | null; compilation: boolean } }[]
  /** every Read book id, served 500 a page */
  readBookIds?: number[]
  userBooks?: { id: number; book_id: number; status_id: number; rating: number | null }[]
  /** forces every reply to this status and body (error tests) */
  status?: number
  body?: unknown
}

/** A stand-in Hardcover GraphQL endpoint for tests; records every call. */
export function hardcoverFixturePost(f: HardcoverFixtures): PostLike & { calls: { query: string; variables: unknown }[] } {
  const calls: { query: string; variables: unknown }[] = []
  const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  const fn: PostLike = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }
    calls.push({ query, variables })
    if (f.status !== undefined) return reply(f.status, f.body ?? {})
    if (init.headers['authorization'] !== `Bearer ${f.token}`) return reply(401, { error: 'invalid_token' })
    const op = /(?:query|mutation) (\w+)/.exec(query)?.[1]
    const ids = (variables['ids'] as number[] | undefined) ?? []
    switch (op) {
      case 'Me':
        return reply(200, { data: { me: f.me ? [f.me] : [] } })
      case 'EditionsByIsbn': {
        const isbns = new Set(variables['isbns'] as string[])
        return reply(200, { data: { editions: (f.editions ?? []).filter((e) => isbns.has(e.isbn_13 ?? '') || isbns.has(e.isbn_10 ?? '')) } })
      }
      case 'BooksById':
        return reply(200, { data: { books: ids.flatMap((id) => (f.books?.[id] ? [f.books[id]] : [])) } })
      case 'BookDetails':
        return reply(200, { data: { books: ids.flatMap((id) => (f.detailBooks?.[id] ? [f.detailBooks[id]] : [])) } })
      case 'SeriesBooks':
        return reply(200, { data: { book_series: (f.series ?? []).filter((r) => ids.includes(r.series_id) && !r.book.compilation) } })
      case 'AuthorBooks':
        return reply(200, { data: { contributions: (f.contributions ?? []).filter((c) => ids.includes(c.author_id) && !c.book.compilation) } })
      case 'ReadBookIds': {
        const offset = variables['offset'] as number
        return reply(200, { data: { user_books: (f.readBookIds ?? []).slice(offset, offset + 500).map((book_id) => ({ book_id })) } })
      }
      case 'BookPageById': {
        const row = f.pages?.[variables['id'] as number]
        return reply(200, { data: { books: row ? [row] : [] } })
      }
      case 'BookPageBySlug':
        return reply(200, { data: { books: Object.values(f.pages ?? {}).filter((b) => (b as { slug: string }).slug === variables['slug']) } })
      case 'SearchBooks':
        return reply(200, { data: { search: { results: { hits: (f.search ?? []).map((document) => ({ document })) } } } })
      case 'Recommendations':
        return reply(200, { data: { vibes: f.vibes ? [{ cached_book_ids: f.vibes }] : [] } })
      case 'UserBook':
        return reply(200, { data: { user_books: (f.userBooks ?? []).filter((b) => b.book_id === variables['bookId']) } })
      case 'InsertUserBook':
        return reply(200, { data: { insert_user_book: { id: 900, error: null } } })
      case 'UpdateUserBook':
        return reply(200, { data: { update_user_book: { id: variables['id'], error: null } } })
      case 'InsertRead':
        return reply(200, { data: { insert_user_book_read: { id: 901, error: null } } })
      default:
        return reply(400, { error: 'invalid_query' })
    }
  }
  return Object.assign(fn, { calls })
}
