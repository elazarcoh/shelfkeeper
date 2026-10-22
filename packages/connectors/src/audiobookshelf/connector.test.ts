import { describe, expect, it } from 'vitest'
import type { ExternalItem, ItemError, Result } from '@mylib/domain'
import { ConnectorFailure } from '../connector'
import { createHttpClient, type FetchLike } from '../http'
import { ABS_FIXTURE_TOKEN, absFixtureFetch } from '../testing'
import { audiobookshelf } from './connector'
import { toExternalItems } from './map'

const BASE = 'http://abs.local:13378'
const config = { kind: 'audiobookshelf' as const, baseUrl: BASE, apiToken: ABS_FIXTURE_TOKEN, libraryIds: null }

async function collect(iterable: AsyncIterable<Result<ExternalItem, ItemError>>) {
  const out: Result<ExternalItem, ItemError>[] = []
  for await (const r of iterable) out.push(r)
  return out
}

function recording(inner: FetchLike) {
  const calls: { url: string; method: string; auth: string | undefined }[] = []
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization })
    return inner(url, init)
  }
  return { fetch, calls }
}

describe('Audiobookshelf connector', () => {
  it('tests a connection and names the book libraries', async () => {
    const http = createHttpClient({ fetch: absFixtureFetch(BASE) })
    expect(await audiobookshelf.test(config, http)).toEqual({ ok: true, value: { libraries: ['Audiobooks'] } })
  })

  it('reports a bad token', async () => {
    const http = createHttpClient({ fetch: absFixtureFetch(BASE) })
    expect(await audiobookshelf.test({ ...config, apiToken: 'wrong' }, http)).toMatchObject({ ok: false, error: { kind: 'unauthorized' } })
  })

  it('maps books to editions, splitting audio and ebook, skipping missing items', async () => {
    const http = createHttpClient({ fetch: absFixtureFetch(BASE) })
    const items = (await collect(audiobookshelf.fetchItems(config, http))).map((r) => (r.ok ? r.value : null))
    expect(items.map((i) => [i?.externalId, i?.format])).toEqual([
      ['li_mistborn', 'audiobook'],
      ['li_hp1', 'audiobook'],
      ['li_hp1:ebook', 'ebook'],
    ])
    expect(items[0]).toMatchObject({
      title: 'The Final Empire',
      subtitle: 'Mistborn, Book 1',
      authors: ['Brandon Sanderson'],
      narrators: ['Michael Kramer'],
      series: [{ name: 'Mistborn', position: 1 }],
      identifiers: { asin: 'B002UZMLXM', isbn13: null, others: { audiobookshelfId: 'li_mistborn', libraryPath: 'Brandon Sanderson/Mistborn/The Final Empire' } },
      publisher: 'Macmillan Audio',
      durationSec: 88_035,
      language: 'en',
      description: 'For a thousand years the ash fell.',
      tags: ['Fantasy', 'Epic'],
      coverUrl: `${BASE}/api/items/li_mistborn/cover`,
    })
    expect(items[1]).toMatchObject({
      title: 'הארי פוטר ואבן החכמים',
      series: [{ name: 'הארי פוטר', position: null }],
      identifiers: { isbn13: '9780747532699' },
      publishedOn: '1998-06-01',
    })
    // Audiobookshelf's one ISBN/ASIN belongs to the book's audio edition, not to its ebook
    expect(items[2]).toMatchObject({ narrators: [], durationSec: null, identifiers: { isbn13: null, isbn10: null, asin: null, others: { audiobookshelfId: 'li_hp1' } } })
  })

  it('gives the ebook sibling none of the audiobook’s identifiers', () => {
    const raw = {
      id: 'li_x',
      mediaType: 'book',
      media: {
        metadata: { title: 'Both', isbn: '9780747532699', asin: 'B002UZMLXM' },
        duration: 60,
        audioFiles: [{}],
        ebookFile: { ebookFormat: 'epub' },
      },
    }
    const mapped = toExternalItems(BASE, raw)
    const [audio, ebook] = mapped.ok ? mapped.value : []
    expect(audio?.identifiers).toMatchObject({ isbn13: '9780747532699', asin: 'B002UZMLXM' })
    expect(ebook?.identifiers).toEqual({ isbn13: null, isbn10: null, asin: null, others: { audiobookshelfId: 'li_x' } })

    const ebookOnly = toExternalItems(BASE, { ...raw, media: { ...raw.media, duration: null, audioFiles: [] } })
    expect(ebookOnly.ok ? ebookOnly.value.map((i) => [i.format, i.identifiers.isbn13]) : null).toEqual([['ebook', '9780747532699']])
  })

  it('reads a series range, and keeps the start of a sequence it cannot read (#122)', () => {
    const seriesOf = (sequence: string) => {
      const mapped = toExternalItems(BASE, { id: 'li_p', mediaType: 'book', media: { metadata: { title: 'Pack', series: [{ name: 'Mage Errant', sequence }] }, audioFiles: [{}] } })
      return mapped.ok ? mapped.value[0]?.series : null
    }
    expect(seriesOf('1-2')).toEqual([{ name: 'Mage Errant', position: 1, positionEnd: 2 }])
    expect(seriesOf('1a')).toEqual([{ name: 'Mage Errant', position: 1, positionEnd: null }])
    expect(seriesOf('2-1')).toEqual([{ name: 'Mage Errant', position: 2, positionEnd: null }])
    // a comma in a sequence reads as before ranges, not as a decimal point: stored items keep their number
    expect(seriesOf('1,2')).toEqual([{ name: 'Mage Errant', position: 1, positionEnd: null }])
  })

  it('names the book’s folder within its library, never a lone file’s', () => {
    const raw = { id: 'li_y', mediaType: 'book', relPath: 'Author\\Title', media: { metadata: { title: 'T' }, audioFiles: [{}], ebookFile: { ebookFormat: 'epub' } } }
    const both = toExternalItems(BASE, raw)
    // the ebook sibling is in the same folder: its own format keeps it from claiming the audiobook's copy
    expect(both.ok ? both.value.map((i) => i.identifiers.others.libraryPath) : null).toEqual(['Author/Title', 'Author/Title'])
    const lone = toExternalItems(BASE, { ...raw, relPath: 'Title.m4b', isFile: true })
    expect(lone.ok ? lone.value[0]?.identifiers.others : null).toEqual({ audiobookshelfId: 'li_y' })
    const none = toExternalItems(BASE, { ...raw, relPath: undefined })
    expect(none.ok ? none.value[0]?.identifiers.others : null).toEqual({ audiobookshelfId: 'li_y' })
  })

  it('only ever sends authenticated GETs', async () => {
    const { fetch, calls } = recording(absFixtureFetch(BASE))
    await collect(audiobookshelf.fetchItems(config, createHttpClient({ fetch })))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.method === 'GET' && c.auth === `Bearer ${ABS_FIXTURE_TOKEN}`)).toBe(true)
    expect(calls.some((c) => c.url.includes('li_missing'))).toBe(false)
  })

  it('skips a book deleted between listing and reading, records one the server fails to serve, and fails the run when the token stops working', async () => {
    const fixtures = absFixtureFetch(BASE)
    const withStatus = (status: number): FetchLike => (url, init) =>
      url.includes('/api/items/li_hp1') ? Promise.resolve(new Response('x', { status })) : fixtures(url, init)
    const summary = (results: Result<ExternalItem, ItemError>[]) => results.map((r) => (r.ok ? r.value.externalId : `error:${r.error.externalId ?? ''}`))

    const gone = await collect(audiobookshelf.fetchItems(config, createHttpClient({ fetch: withStatus(404) })))
    expect(summary(gone)).toEqual(['li_mistborn'])

    // spec §8: one bad item is recorded and skipped; the sync engine keeps its copy (plan deviations 12–13)
    const oneBroken = await collect(audiobookshelf.fetchItems(config, createHttpClient({ fetch: withStatus(500) })))
    expect(summary(oneBroken)).toEqual(['li_mistborn', 'error:li_hp1'])

    await expect(collect(audiobookshelf.fetchItems(config, createHttpClient({ fetch: withStatus(401) })))).rejects.toBeInstanceOf(ConnectorFailure)
  })

  it('follows pagination', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `li_${i}`)
    const fetch: FetchLike = (url) => {
      const u = new URL(url)
      if (u.pathname === '/api/libraries') return Promise.resolve(Response.json({ libraries: [{ id: 'lib_books', name: 'Audiobooks', mediaType: 'book' }] }))
      if (u.pathname === '/api/libraries/lib_books/items') {
        const page = Number(u.searchParams.get('page'))
        const limit = Number(u.searchParams.get('limit'))
        return Promise.resolve(Response.json({ results: ids.slice(page * limit, (page + 1) * limit).map((id) => ({ id, isMissing: false })), total: ids.length, limit, page }))
      }
      const id = u.pathname.split('/').at(-1) ?? ''
      return Promise.resolve(
        Response.json({ id, libraryId: 'lib_books', mediaType: 'book', media: { metadata: { title: `Book ${id}`, authors: [] }, tags: [], duration: 60, audioFiles: [{}], ebookFile: null } }),
      )
    }
    const items = await collect(audiobookshelf.fetchItems(config, createHttpClient({ fetch })))
    expect(items).toHaveLength(150)
  })

  it('syncs only the chosen libraries', async () => {
    const http = createHttpClient({ fetch: absFixtureFetch(BASE) })
    expect(await collect(audiobookshelf.fetchItems({ ...config, libraryIds: ['lib_pods'] }, http))).toEqual([])
  })

  it('fetches a cover from its own server with the token, and strips HTML from descriptions', async () => {
    const http = createHttpClient({ fetch: absFixtureFetch(BASE) })
    const cover = await audiobookshelf.fetchCover(config, http, `${BASE}/api/items/li_mistborn/cover`)
    expect(cover.ok).toBe(true)
    const items: ExternalItem[] = []
    for await (const r of audiobookshelf.fetchItems(config, http)) if (r.ok) items.push(r.value)
    expect(items.every((i) => i.description === null || !/<[a-z]/i.test(i.description))).toBe(true)
  })
})
