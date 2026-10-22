import { describe, expect, it } from 'vitest'
import { ReadarrConfig, ChaptarrConfig, type ExternalItem, type ItemError, type Result } from '@mylib/domain'
import { createHttpClient, type FetchLike } from '../http'
import { ARR_FIXTURE_KEY, arrFixtureFetch } from '../testing'
import { createArrConnector } from './connector'
import { libraryPathOfFiles, parseSeriesTitle } from './map'

const BASE = 'http://readarr.local:8787'
const config = ReadarrConfig.parse({ kind: 'readarr', baseUrl: BASE, apiKey: ARR_FIXTURE_KEY })
const readarr = createArrConnector('readarr', { batchSize: 1 })

async function items(connector: typeof readarr, fetch: FetchLike) {
  const out: Result<ExternalItem, ItemError>[] = []
  for await (const r of connector.fetchItems(config, createHttpClient({ fetch }))) out.push(r)
  return out.flatMap((r) => (r.ok ? [r.value] : []))
}

describe('readarr connector', () => {
  it('tests the connection by the app name and version', async () => {
    expect(await readarr.test(config, createHttpClient({ fetch: arrFixtureFetch(BASE) }))).toEqual({ ok: true, value: { libraries: ['Readarr 0.4.18.2805'] } })
    expect(await readarr.test({ ...config, apiKey: 'wrong' }, createHttpClient({ fetch: arrFixtureFetch(BASE) }))).toMatchObject({ ok: false, error: { kind: 'unauthorized' } })
  })

  it('turns files into one item per book and format, and monitored missing books into wanted items', async () => {
    const calls: string[] = []
    const all = await items(readarr, (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}${new URL(url).search}`)
      return arrFixtureFetch(BASE)(url, init)
    })
    expect(all.map((i) => [i.externalId, i.format, i.wantedOnly])).toEqual([
      ['book:10:ebook', 'ebook', false],
      ['book:11', 'ebook', true],
      ['book:13:audiobook', 'audiobook', false],
    ])
    expect(calls.every((c) => c.startsWith('GET '))).toBe(true)
    // one request per batch of books that have files, never an unfiltered listing
    expect(calls.filter((c) => c.includes('/api/v1/bookfile'))).toEqual(['GET /api/v1/bookfile?bookId=10', 'GET /api/v1/bookfile?bookId=13'])
  })

  it('maps a present ebook with its edition identifiers, series and a same-server cover', async () => {
    const [ebook] = await items(readarr, arrFixtureFetch(BASE))
    expect(ebook).toMatchObject({
      title: 'The Final Empire',
      authors: ['Brandon Sanderson'],
      series: [{ name: 'Mistborn', position: 1 }],
      identifiers: { isbn13: '9780765311788', asin: 'B000SEIFKK', others: { readarrBookId: '10', libraryPath: 'Brandon Sanderson/The Final Empire' } },
      publisher: 'Tor',
      publishedOn: '2006-07-17',
      pageCount: 541,
      description: 'For a thousand years the ash fell.',
      coverUrl: `${BASE}/MediaCover/Books/10/cover.jpg?lastWrite=638400000000000000`,
      tags: ['fantasy'],
    })
  })

  it('groups a multi-file audiobook into one item and reads several series', async () => {
    const audiobook = (await items(readarr, arrFixtureFetch(BASE))).find((i) => i.externalId === 'book:13:audiobook')
    expect(audiobook).toMatchObject({ format: 'audiobook', series: [{ name: 'Mistborn', position: 2 }, { name: 'The Cosmere', position: 4 }] })
    expect(audiobook?.identifiers.others).toEqual({ readarrBookId: '13', libraryPath: 'Brandon Sanderson/The Well of Ascension' })
  })

  it('names each format’s folder within its root folder (#104)', () => {
    const file = (path: string) => ({ id: 1, bookId: 1, path })
    const roots = ['/existing-audiobooks', '/audiobooks/']
    expect(libraryPathOfFiles([file('/existing-audiobooks/Author/Series/Title/Title.m4b')], roots)).toBe('Author/Series/Title')
    // a book split into disc folders is still the book's folder
    expect(libraryPathOfFiles([file('/audiobooks/Author/Title/CD1/01.mp3'), file('/audiobooks/Author/Title/CD2/01.mp3')], roots)).toBe('Author/Title')
    // the deepest root wins
    expect(libraryPathOfFiles([file('/media/books/Author/Title/t.epub')], ['/media', '/media/books'])).toBe('Author/Title')
    // outside every root, directly in a root, no root folders at all, no files
    expect(libraryPathOfFiles([file('/downloads/Author/Title/t.mp3')], roots)).toBeNull()
    expect(libraryPathOfFiles([file('/audiobooks/Title.m4b')], roots)).toBeNull()
    expect(libraryPathOfFiles([file('/audiobooks/Author/Title/t.mp3')], [])).toBeNull()
    expect(libraryPathOfFiles([], roots)).toBeNull()
    // a root that only shares a name prefix is not the root
    expect(libraryPathOfFiles([file('/audiobooks-staging/Author/Title/t.mp3')], roots)).toBeNull()
  })

  it('still syncs when the root folders cannot be read, without library paths', async () => {
    const noRoots: FetchLike = (url, init) => (new URL(url).pathname === '/api/v1/rootfolder' ? Promise.resolve(new Response('nope', { status: 500 })) : arrFixtureFetch(BASE)(url, init))
    const all = await items(readarr, noRoots)
    expect(all.map((i) => i.externalId)).toEqual(['book:10:ebook', 'book:11', 'book:13:audiobook'])
    expect(all.every((i) => i.identifiers.others.libraryPath === undefined)).toBe(true)
  })

  it('keeps a wanted book\'s identifiers but never fetches its off-server cover', async () => {
    const wanted = (await items(readarr, arrFixtureFetch(BASE))).find((i) => i.wantedOnly)
    expect(wanted).toMatchObject({ title: 'Project Hail Mary', identifiers: { isbn13: '9780593135204', others: { readarrBookId: '11' } } })
    expect((await readarr.fetchCover(config, createHttpClient({ fetch: arrFixtureFetch(BASE) }), wanted?.coverUrl ?? '')).ok).toBe(false)
  })

  it('reports a book whose files cannot be read without dropping its other items', async () => {
    const broken: FetchLike = (url, init) =>
      new URL(url).searchParams.get('bookId') === '13' ? Promise.resolve(Response.json([])) : arrFixtureFetch(BASE)(url, init)
    const out: Result<ExternalItem, ItemError>[] = []
    for await (const r of readarr.fetchItems(config, createHttpClient({ fetch: broken }))) out.push(r)
    expect(out.find((r) => !r.ok)).toMatchObject({ ok: false, error: { externalId: 'book:13' } })
  })
})

describe('chaptarr connector', () => {
  it('speaks the same API and keys its ids as chaptarr', async () => {
    const chaptarr = createArrConnector('chaptarr')
    const cfg = ChaptarrConfig.parse({ kind: 'chaptarr', baseUrl: BASE, apiKey: ARR_FIXTURE_KEY })
    const http = createHttpClient({ fetch: arrFixtureFetch(BASE, 'Chaptarr') })
    expect(await chaptarr.test(cfg, http)).toEqual({ ok: true, value: { libraries: ['Chaptarr 0.4.18.2805'] } })
    const first = (await chaptarr.fetchItems(cfg, http)[Symbol.asyncIterator]().next()).value as Result<ExternalItem, ItemError>
    expect(first).toMatchObject({ ok: true, value: { identifiers: { others: { chaptarrBookId: '10' } } } })
  })
})

describe('parseSeriesTitle', () => {
  it('reads a range after # (#122)', () => {
    expect(parseSeriesTitle('Mage Errant #1-2; The Cosmere #4')).toEqual([
      { name: 'Mage Errant', position: 1, positionEnd: 2 },
      { name: 'The Cosmere', position: 4, positionEnd: null },
    ])
    expect(parseSeriesTitle('Mage Errant #2-1')).toEqual([{ name: 'Mage Errant', position: 2, positionEnd: null }])
    expect(parseSeriesTitle('Loose')).toEqual([{ name: 'Loose', position: null, positionEnd: null }])
  })
})
