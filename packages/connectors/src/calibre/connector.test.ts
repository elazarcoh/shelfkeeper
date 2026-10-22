import { describe, expect, it } from 'vitest'
import { CalibreConfig, type ExternalItem, type ItemError, type Result } from '@mylib/domain'
import { ConnectorFailure } from '../connector'
import { createHttpClient, type FetchLike } from '../http'
import { CALIBRE_FIXTURE_PASSWORD, CALIBRE_FIXTURE_USER, calibreFixtureFetch } from '../testing'
import { calibre, createCalibreConnector } from './connector'

const BASE = 'http://calibre.local:8080'
const config = CalibreConfig.parse({ kind: 'calibre', baseUrl: BASE, username: CALIBRE_FIXTURE_USER, password: CALIBRE_FIXTURE_PASSWORD, wordCountColumn: '#words' })

async function collect(iterable: AsyncIterable<Result<ExternalItem, ItemError>>) {
  const out: Result<ExternalItem, ItemError>[] = []
  for await (const r of iterable) out.push(r)
  return out
}

function recording(inner: FetchLike) {
  const calls: { url: string; method: string }[] = []
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, method: init.method })
    return inner(url, init)
  }
  return { fetch, calls }
}

describe('calibre connector', () => {
  it('tests the connection and names the library', async () => {
    expect(await calibre.test(config, createHttpClient({ fetch: calibreFixtureFetch(BASE) }))).toEqual({ ok: true, value: { libraries: ['Calibre Library'] } })
  })

  it('explains a rejected login in terms of basic authentication', async () => {
    const result = await calibre.test({ ...config, password: 'wrong' }, createHttpClient({ fetch: calibreFixtureFetch(BASE) }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: 'unauthorized' })
      expect(result.error.message).toContain('--auth-mode=basic')
    }
  })

  it('maps every book with a file to one ebook item, GET only, paging through search', async () => {
    const { fetch, calls } = recording(calibreFixtureFetch(BASE))
    const results = await collect(createCalibreConnector({ pageSize: 2 }).fetchItems(config, createHttpClient({ fetch })))
    const items = results.flatMap((r) => (r.ok ? [r.value] : []))
    expect(items.map((i) => i.externalId)).toEqual(['1', '2'])
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(calls.filter((c) => c.url.includes('/ajax/search/')).map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '2'])

    expect(items[0]).toMatchObject({
      format: 'ebook',
      title: 'The Final Empire',
      authors: ['Brandon Sanderson'],
      series: [{ name: 'Mistborn', position: 1 }],
      identifiers: { isbn13: '9780765311788', isbn10: null, asin: 'B000SEIFKK', others: { calibreId: '1', goodreads: '68428' } },
      publisher: 'Tor',
      publishedOn: '2006-07-17',
      wordCount: 214000,
      language: 'en',
      description: 'For a thousand years the ash fell & no flowers bloomed.',
      coverUrl: `${BASE}/get/cover/1/Calibre_Library`,
      tags: ['Fantasy', 'Epic'],
    })
  })

  it('drops Calibre\'s undefined date and keeps Hebrew metadata as is', async () => {
    const items = (await collect(calibre.fetchItems(config, createHttpClient({ fetch: calibreFixtureFetch(BASE) })))).flatMap((r) => (r.ok ? [r.value] : []))
    expect(items[1]).toMatchObject({ title: 'הארי פוטר ואבן החכמים', publishedOn: null, series: [], language: 'he', wordCount: null })
  })

  it('leaves the word count empty without a configured column', async () => {
    const items = (await collect(calibre.fetchItems({ ...config, wordCountColumn: null }, createHttpClient({ fetch: calibreFixtureFetch(BASE) })))).flatMap((r) => (r.ok ? [r.value] : []))
    expect(items[0]?.wordCount).toBeNull()
  })

  it('refuses a username without a password before sending anything', async () => {
    const { fetch, calls } = recording(calibreFixtureFetch(BASE))
    const http = createHttpClient({ fetch })
    const noPassword = { ...config, password: null }
    expect(await calibre.test(noPassword, http)).toEqual({ ok: false, error: { kind: 'unauthorized', message: 'Calibre needs both a username and a password' } })
    await expect(collect(calibre.fetchItems(noPassword, http))).rejects.toMatchObject({ error: { kind: 'unauthorized', message: 'Calibre needs both a username and a password' } })
    expect(await calibre.fetchCover(noPassword, http, `${BASE}/get/cover/1/Calibre_Library`)).toMatchObject({ ok: false, error: { kind: 'unauthorized' } })
    expect(calls).toEqual([])
  })

  it('finds the configured library by its id or by its display name', async () => {
    const http = createHttpClient({ fetch: calibreFixtureFetch(BASE) })
    expect(await calibre.test({ ...config, libraryId: 'Calibre_Library' }, http)).toEqual({ ok: true, value: { libraries: ['Calibre Library'] } })
    expect(await calibre.test({ ...config, libraryId: 'Calibre Library' }, http)).toEqual({ ok: true, value: { libraries: ['Calibre Library'] } })
    const items = (await collect(calibre.fetchItems({ ...config, libraryId: 'Calibre Library' }, http))).flatMap((r) => (r.ok ? [r.value] : []))
    expect(items.map((i) => i.externalId)).toEqual(['1', '2'])
  })

  it('fails the run for a library the server does not have', async () => {
    await expect(collect(calibre.fetchItems({ ...config, libraryId: 'Other' }, createHttpClient({ fetch: calibreFixtureFetch(BASE) })))).rejects.toBeInstanceOf(ConnectorFailure)
  })

  it('fetches covers from its own server only', async () => {
    const http = createHttpClient({ fetch: calibreFixtureFetch(BASE) })
    expect((await calibre.fetchCover(config, http, `${BASE}/get/cover/1/Calibre_Library`)).ok).toBe(true)
    expect((await calibre.fetchCover(config, http, 'http://elsewhere/cover.jpg')).ok).toBe(false)
  })
})
