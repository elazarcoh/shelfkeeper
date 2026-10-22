import { describe, expect, it } from 'vitest'
import { hardcoverFixturePost } from '../testing'
import { createHardcoverClient } from './client'

const TOKEN = 'fixture-hardcover-token-0001'
const noSleep = () => Promise.resolve()
const book = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  slug: `book-${id}`,
  title: `Book ${id}`,
  rating: 4.25,
  ratings_count: 12,
  cached_tags: { Genre: [{ tag: 'Fantasy', count: 3 }], Mood: [{ tag: 'dark', count: 2 }] },
  cached_similar_book_ids: [2, 3],
  ...extra,
})

describe('Hardcover client', () => {
  it('reads me, editions, books, search and recommendations', async () => {
    const post = hardcoverFixturePost({
      token: TOKEN,
      me: { id: 7, username: 'reader' },
      editions: [{ isbn_13: '9780141439518', isbn_10: null, book_id: 1 }],
      books: { 1: book(1) },
      search: [{ id: '1', title: 'Book 1', author_names: ['Ann Author'] }],
      vibes: [5, 4, 1],
    })
    const client = createHardcoverClient({ token: TOKEN, post, sleep: noSleep })
    expect(await client.me()).toEqual({ ok: true, value: { id: 7, username: 'reader' } })
    expect(await client.editionsByIsbn(['9780141439518'])).toEqual({ ok: true, value: [{ isbn13: '9780141439518', isbn10: null, bookId: 1, editionId: null }] })
    expect(await client.booksById([1])).toEqual({
      ok: true,
      value: [{ id: 1, slug: 'book-1', title: 'Book 1', rating: 4.25, ratingsCount: 12, tags: { genre: ['Fantasy'], mood: ['dark'] }, similarIds: [2, 3] }],
    })
    expect(await client.searchBooks('Book 1 Ann Author')).toEqual({ ok: true, value: [{ id: 1, title: 'Book 1', authors: ['Ann Author'], year: null, series: [], imageUrl: null }] })
    expect(await client.recommendations(7)).toEqual({ ok: true, value: [5, 4, 1] })
    expect(client.requestsUsed).toBe(5)
    expect(post.calls.every((c) => c.query.includes('query'))).toBe(true)
  })

  it('maps 401, a missing scope, 429 and a GraphQL error', async () => {
    const run = (status: number, body: unknown) => createHardcoverClient({ token: TOKEN, post: hardcoverFixturePost({ token: TOKEN, status, body }), sleep: noSleep }).me()
    expect(await run(401, { error: 'invalid_token' })).toMatchObject({ ok: false, error: { kind: 'unauthorized' } })
    expect(await run(403, { error: 'insufficient_scope', scope: 'read:vibes' })).toMatchObject({ ok: false, error: { kind: 'missing_scope', scope: 'read:vibes' } })
    expect(await run(429, { error: 'Too Many Requests' })).toMatchObject({ ok: false, error: { kind: 'rate_limited' } })
    expect(await run(503, {})).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
    expect(await run(200, { errors: [{ message: 'field "x" not found' }] })).toMatchObject({ ok: false, error: { kind: 'bad_response' } })
    expect(await run(200, { data: { me: 'not a user' } })).toMatchObject({ ok: false, error: { kind: 'bad_response' } })
  })

  it('a wrong token is unauthorized; a 429 is retried once after waiting', async () => {
    const wrong = createHardcoverClient({ token: 'another-token-entirely-000', post: hardcoverFixturePost({ token: TOKEN, me: { id: 1, username: 'x' } }), sleep: noSleep })
    expect(await wrong.me()).toMatchObject({ ok: false, error: { kind: 'unauthorized' } })
    let first = true
    const flaky = hardcoverFixturePost({ token: TOKEN, me: { id: 1, username: 'x' } })
    const waits: number[] = []
    const client = createHardcoverClient({
      token: TOKEN,
      post: (url, init) => {
        if (first) {
          first = false
          return Promise.resolve(new Response('{}', { status: 429 }))
        }
        return flaky(url, init)
      },
      sleep: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    })
    expect(await client.me()).toEqual({ ok: true, value: { id: 1, username: 'x' } })
    expect(waits.some((ms) => ms >= 1000)).toBe(true)
  })

  it('retries a query once after about 3 s on a network error, 5xx or 408, counting both attempts (I3)', async () => {
    const attempts = async (first: () => Promise<Response>) => {
      let n = 0
      const waits: number[] = []
      const ok = hardcoverFixturePost({ token: TOKEN, me: { id: 1, username: 'x' } })
      const client = createHardcoverClient({
        token: TOKEN,
        post: (url, init) => (n++ === 0 ? first() : ok(url, init)),
        sleep: (ms) => {
          waits.push(ms)
          return Promise.resolve()
        },
      })
      const result = await client.me()
      return { result, n, waits, used: client.requestsUsed }
    }
    for (const first of [() => Promise.reject(new Error('fetch failed')), () => Promise.resolve(new Response('{}', { status: 502 })), () => Promise.resolve(new Response('{}', { status: 408 }))]) {
      const r = await attempts(first)
      expect(r.result).toEqual({ ok: true, value: { id: 1, username: 'x' } })
      expect(r.n).toBe(2)
      expect(r.waits).toContain(3000)
      expect(r.used).toBe(2)
    }
    // a second failure is reported, not retried again
    const down = createHardcoverClient({ token: TOKEN, post: () => Promise.reject(new Error('down')), sleep: noSleep })
    expect(await down.me()).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
    expect(down.requestsUsed).toBe(2)
  })

  it('never retries a mutation (insert_user_book_read is not idempotent) (I3)', async () => {
    for (const first of [() => Promise.reject(new Error('fetch failed')), () => Promise.resolve(new Response('{}', { status: 503 }))]) {
      let n = 0
      const client = createHardcoverClient({ token: TOKEN, post: () => (n++, first()), sleep: noSleep })
      expect(await client.markRead(null, 5, { finishedOn: '2026-10-18', rating: null })).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
      expect(n).toBe(1)
      expect(client.requestsUsed).toBe(1)
    }
  })

  it('paces requests: an eleventh request in a burst waits', async () => {
    const waits: number[] = []
    const client = createHardcoverClient({
      token: TOKEN,
      post: hardcoverFixturePost({ token: TOKEN, me: { id: 1, username: 'x' } }),
      sleep: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    })
    for (let i = 0; i < 11; i++) await client.me()
    expect(waits.filter((ms) => ms > 0)).toHaveLength(1)
  })

  it('marks a book Read add-only: a new entry with a read; an existing one gets status 3 and a read', async () => {
    const post = hardcoverFixturePost({ token: TOKEN })
    const client = createHardcoverClient({ token: TOKEN, post, sleep: noSleep })
    expect(await client.markRead(null, 1, { finishedOn: '2026-10-01', rating: 4.5 })).toEqual({ ok: true, value: undefined })
    expect(post.calls.map((c) => /(insert_user_book_read|insert_user_book|update_user_book)/.exec(c.query)?.[1])).toEqual(['insert_user_book', 'insert_user_book_read'])
    expect(post.calls[0]?.variables).toEqual({ object: { book_id: 1, status_id: 3, rating: 4.5 } })
    post.calls.length = 0
    await client.markRead({ id: 9, rating: 3 }, 1, { finishedOn: '2026-10-01', rating: 4.5 })
    // Hardcover already has a rating: it stays
    expect(post.calls[0]?.variables).toEqual({ id: 9, object: { status_id: 3 } })
    expect(post.calls[1]?.variables).toEqual({ id: 9, read: { finished_at: '2026-10-01' } })
  })
})

describe('Hardcover client: book page', () => {
  const wormRow = {
    id: 474572,
    slug: 'worm',
    title: 'Worm',
    description: 'A web serial.',
    release_date: '2013-11-19',
    cached_image: { url: 'https://assets.hardcover.app/worm.jpeg' },
    cached_contributors: [
      { author: { id: 1, name: 'Wildbow' }, contribution: null },
      { author: { id: 2, name: 'Tess Translator' }, contribution: 'Translator' },
      { author: { id: 3, name: 'Nat Narrator' }, contribution: 'Narrator' },
    ],
    book_series: [{ position: 1, featured: true, series: { id: 9, name: 'Parahumans' } }],
    default_physical_edition_id: 30647610,
    default_cover_edition_id: 30647611,
    editions: [
      { id: 30647610, title: 'Worm', isbn_13: null, isbn_10: null, pages: 6073, release_date: '2013-11-19', edition_format: 'Webnovel', reading_format_id: 4, publisher: { name: 'Parahumans.wordpress.com' }, cached_image: null, language: { code3: 'eng' } },
      { id: 30647611, title: null, isbn_13: null, isbn_10: null, pages: 4192, release_date: null, edition_format: null, reading_format_id: 4, publisher: null, cached_image: { url: 'https://assets.hardcover.app/e.jpeg' }, language: null },
      { id: 30647612, title: null, isbn_13: null, isbn_10: null, pages: null, release_date: null, edition_format: null, reading_format_id: null, publisher: null, cached_image: null, language: null },
    ],
  }
  const make = (extra: Record<string, unknown> = {}) => {
    const post = hardcoverFixturePost({ token: TOKEN, pages: { 474572: wormRow }, ...extra })
    return { post, client: createHardcoverClient({ token: TOKEN, post, sleep: noSleep }) }
  }

  it('reads a book and all its editions in one request', async () => {
    const { post, client } = make()
    const page = await client.bookPage({ id: 474572 })
    if (!page.ok) throw new Error('expected ok')
    expect(page.value?.editions.map((e) => e.pages)).toEqual([6073, 4192, null])
    expect(page.value?.editions[0]).toMatchObject({ format: 'Webnovel', publisher: 'Parahumans.wordpress.com', language: 'en' })
    expect(page.value?.editions[1]?.format).toBe('E-book')
    expect(page.value).toMatchObject({ authors: ['Wildbow'], translators: ['Tess Translator'], series: { name: 'Parahumans', position: 1 }, mainEditionId: 30647610, imageUrl: 'https://assets.hardcover.app/worm.jpeg' })
    expect(post.calls).toHaveLength(1)
  })

  it('falls back to the cover edition as main edition', async () => {
    const { client } = make({ pages: { 474572: { ...wormRow, default_physical_edition_id: null } } })
    const page = await client.bookPage({ slug: 'worm' })
    expect(page.ok && page.value?.mainEditionId).toBe(30647611)
  })

  it('answers null for an unknown book', async () => {
    const { client } = make()
    expect(await client.bookPage({ slug: 'nope' })).toEqual({ ok: true, value: null })
    expect(await client.bookPage({ id: 1 })).toEqual({ ok: true, value: null })
  })

  it('gives the edition id with an ISBN lookup and the cover with a search hit', async () => {
    const { client } = make({
      editions: [{ id: 501, isbn_13: '9780141439518', isbn_10: null, book_id: 1001 }],
      search: [{ id: '1', title: 'Book 1', author_names: ['Ann'], image: { url: 'https://assets.hardcover.app/s.jpeg' } }],
    })
    const r = await client.editionsByIsbn(['9780141439518'])
    expect(r.ok && r.value[0]).toMatchObject({ bookId: 1001, editionId: 501 })
    const hits = await client.searchBooks('Book 1')
    expect(hits.ok && hits.value[0]?.imageUrl).toBe('https://assets.hardcover.app/s.jpeg')
  })
})

describe('Hardcover client: what-next data', () => {
  const detail = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Book ${id}`,
    pages: 300,
    release_date: '2006-07-17',
    cached_image: { id: 1, url: `https://assets.hardcover.app/${id}.jpeg`, color: '#935b67', width: 330, height: 500 },
    cached_contributors: [
      { author: { id: 10, name: 'Ann Author' }, contribution: 'Author' },
      { author: { id: 11, name: 'Nat Narrator' }, contribution: 'Narrator' },
      { author: { id: 12, name: 'Old Style' }, contribution: null },
    ],
    cached_tags: { Genre: [{ tag: 'Fantasy', count: 3 }], Mood: [{ tag: 'dark', count: 2 }] },
    book_series: [
      { position: 3, featured: false, series: { id: 200, name: 'The Universe' } },
      { position: 1, featured: true, series: { id: 100, name: 'The Saga' } },
    ],
    editions: [{ id: 5 }],
    ...extra,
  })

  it('bookDetails maps image, authors, series and audiobook availability', async () => {
    const post = hardcoverFixturePost({ token: TOKEN, detailBooks: { 1: detail(1), 2: detail(2, { editions: [], book_series: [{ position: 2, featured: false, series: { id: 300, name: 'Other' } }] }), 3: detail(3, { editions: undefined, book_series: [], cached_image: null }) } })
    const client = createHardcoverClient({ token: TOKEN, post, sleep: noSleep })
    const r = await client.bookDetails([1, 2, 3])
    expect(r).toEqual({
      ok: true,
      value: [
        {
          id: 1,
          title: 'Book 1',
          authors: ['Ann Author', 'Old Style'],
          authorIds: [10, 12],
          seriesName: 'The Saga',
          position: 1,
          series: [
            { id: 200, name: 'The Universe', position: 3, featured: false },
            { id: 100, name: 'The Saga', position: 1, featured: true },
          ],
          pages: 300,
          releaseDate: '2006-07-17',
          imageUrl: 'https://assets.hardcover.app/1.jpeg',
          tags: { genre: ['Fantasy'], mood: ['dark'] },
          hasAudiobook: true,
        },
        expect.objectContaining({ id: 2, hasAudiobook: false, seriesName: 'Other', position: 2 }),
        expect.objectContaining({ id: 3, hasAudiobook: null, seriesName: null, position: null, series: [], imageUrl: null }),
      ],
    })
    expect(post.calls).toHaveLength(1)
    expect(post.calls[0]?.query).toContain('query BookDetails')
  })

  it('bookDetails skips one malformed contributor and keeps the others', async () => {
    const post = hardcoverFixturePost({
      token: TOKEN,
      detailBooks: { 1: detail(1, { cached_contributors: [{ author: { id: 10, name: 'Ann Author' }, contribution: 'Author' }, { author: null, contribution: 'Author' }, 'junk', { author: { id: 'x', name: 'Bad Id' } }, { author: { id: 12, name: 'Old Style' }, contribution: null }] }) },
    })
    const r = await createHardcoverClient({ token: TOKEN, post, sleep: noSleep }).bookDetails([1])
    expect(r.ok && r.value.map((b) => [b.authors, b.authorIds])).toEqual([[['Ann Author', 'Old Style'], [10, 12]]])
  })

  it('bookDetails shows the lowest-positioned series, not the featured universe; a tie goes to a featured one, then the first', async () => {
    const entry = (id: number, name: string, position: number | null, featured = false) => ({ position, featured, series: { id, name } })
    const post = hardcoverFixturePost({
      token: TOKEN,
      detailBooks: {
        // the Mistborn sample: the universe at #3 is the featured one
        1: detail(1, { book_series: [entry(5452, 'The Mistborn Saga', 1), entry(5497, 'The Cosmere', 3, true), entry(10001, 'The Mistborn Saga: The Original Trilogy', 1)] }),
        2: detail(2, { book_series: [entry(1, 'First', 2), entry(2, 'Second', 2, true)] }),
        3: detail(3, { book_series: [entry(1, 'Unplaced', null), entry(2, 'Placed', 4)] }),
        4: detail(4, { book_series: [entry(1, 'No position', null), entry(2, 'Also none', null)] }),
      },
    })
    const r = await createHardcoverClient({ token: TOKEN, post, sleep: noSleep }).bookDetails([1, 2, 3, 4])
    expect(r.ok && r.value.map((b) => [b.seriesName, b.position])).toEqual([
      ['The Mistborn Saga', 1],
      ['Second', 2],
      ['Placed', 4],
      ['No position', null],
    ])
  })

  it('readBookIds stops after 20 pages (10,000 books) even when every page is full', async () => {
    const post = hardcoverFixturePost({ token: TOKEN, readBookIds: Array.from({ length: 12_000 }, (_, i) => i + 1) })
    const client = createHardcoverClient({ token: TOKEN, post, sleep: noSleep })
    const r = await client.readBookIds(7)
    expect(r.ok && r.value).toHaveLength(10_000)
    expect(post.calls).toHaveLength(20)
    expect(client.requestsUsed).toBe(20)
  })

  it('seriesBooks groups by series in position order, drops null positions and keeps one book per position', async () => {
    const row = (series_id: number, position: number | null, id: number, users_count: number, release_date: string | null) => ({ series_id, position, series: { name: `Series ${series_id}` }, book: { id, title: `Book ${id}`, release_date, users_count, compilation: false } })
    const post = hardcoverFixturePost({
      token: TOKEN,
      series: [row(1, 2, 12, 50, '2007-01-01'), row(1, 1, 11, 10, '2014-02-01'), row(1, 1, 13, 90, '2006-07-17'), row(1, null, 19, 99, null), row(1, 3, 14, 5, null), row(1, 3, 15, 5, '2008-01-01'), row(2, 1, 21, 1, null)],
    })
    const client = createHardcoverClient({ token: TOKEN, post, sleep: noSleep })
    expect(await client.seriesBooks([1, 2])).toEqual({
      ok: true,
      value: [
        {
          seriesId: 1,
          name: 'Series 1',
          books: [
            { id: 13, position: 1, title: 'Book 13', releaseDate: '2006-07-17' },
            { id: 12, position: 2, title: 'Book 12', releaseDate: '2007-01-01' },
            { id: 15, position: 3, title: 'Book 15', releaseDate: '2008-01-01' },
          ],
        },
        { seriesId: 2, name: 'Series 2', books: [{ id: 21, position: 1, title: 'Book 21', releaseDate: null }] },
      ],
    })
    expect(post.calls).toHaveLength(1)
  })

  it('seriesBooks drops split parts of a book whatever their featured flag, keeping the novella', async () => {
    const row = (position: number, id: number, title: string, users_count: number) => ({ series_id: 5452, position, series: { name: 'The Mistborn Saga' }, book: { id, title, release_date: null, users_count, compilation: false } })
    const post = hardcoverFixturePost({
      token: TOKEN,
      series: [
        row(1, 1, 'Mistborn: The Final Empire', 11731),
        row(1, 2, 'The Final Empire (1 of 3)', 13),
        row(2, 3, 'The Well of Ascension', 7491),
        row(2.1, 4, 'The Well of Ascension, Part 1', 9),
        row(2.2, 5, 'The Well of Ascension, Part 2', 8),
        row(3.1, 6, 'The Hero of Ages, Part 1 of 3', 7),
        row(3.2, 7, 'Words 1/3', 6),
        row(0.5, 8, 'The Eleventh Metal', 4000),
      ],
    })
    const r = await createHardcoverClient({ token: TOKEN, post, sleep: noSleep }).seriesBooks([5452])
    expect(r.ok && r.value[0]?.books.map((b) => [b.position, b.id])).toEqual([[0.5, 8], [1, 1], [2, 3]])
    expect(post.calls[0]?.query).not.toContain('featured')
  })

  it('seriesBooks breaks a users_count tie by the earliest release date, null last', async () => {
    const row = (position: number, id: number, release_date: string | null) => ({ series_id: 1, position, series: { name: 'S' }, book: { id, title: `Book ${id}`, release_date, users_count: 4, compilation: false } })
    const post = hardcoverFixturePost({ token: TOKEN, series: [row(1, 1, null), row(1, 2, '2010-01-01'), row(1, 3, '2009-01-01')] })
    const r = await createHardcoverClient({ token: TOKEN, post, sleep: noSleep }).seriesBooks([1])
    expect(r.ok && r.value[0]?.books.map((b) => b.id)).toEqual([3])
  })

  it('authorBooks sends a 24 months back, 6 months ahead window and excludes compilations', async () => {
    const c = (author_id: number, id: number, compilation: boolean) => ({ author_id, contribution: 'Author', book: { id, title: `Book ${id}`, release_date: '2026-01-01', compilation } })
    const post = hardcoverFixturePost({ token: TOKEN, contributions: [c(10, 1, false), c(10, 2, true), c(10, 3, false), c(11, 4, false)] })
    const client = createHardcoverClient({ token: TOKEN, post, sleep: noSleep })
    expect(await client.authorBooks([10, 11], '2026-10-20')).toEqual({
      ok: true,
      value: [
        {
          authorId: 10,
          books: [
            { id: 1, title: 'Book 1', releaseDate: '2026-01-01' },
            { id: 3, title: 'Book 3', releaseDate: '2026-01-01' },
          ],
        },
        { authorId: 11, books: [{ id: 4, title: 'Book 4', releaseDate: '2026-01-01' }] },
      ],
    })
    expect(post.calls).toHaveLength(1)
    expect(post.calls[0]?.variables).toEqual({ ids: [10, 11], since: '2024-10-20', until: '2027-04-20' })
  })

  it('readBookIds asks for a second page when the first is full and stops at a short page', async () => {
    const all = Array.from({ length: 520 }, (_, i) => i + 1)
    const post = hardcoverFixturePost({ token: TOKEN, readBookIds: all })
    const client = createHardcoverClient({ token: TOKEN, post, sleep: noSleep })
    const r = await client.readBookIds(7)
    expect(r.ok && r.value).toEqual(all)
    expect(post.calls.map((c) => c.variables)).toEqual([
      { userId: 7, offset: 0 },
      { userId: 7, offset: 500 },
    ])
  })
})
