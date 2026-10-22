import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createHttpClient, getConnector, type Connector } from '@mylib/connectors'
import { ABS_FIXTURE_TOKEN, absFixtureFetch, COVER_PNG } from '@mylib/connectors/testing'
import { createFileAssetStore, createSecretBox, createSource, DEV_SECRET_KEY, loadUserScope, resolveSourceMatch, listInbox, syncSource, editions, sourceItems, sources, type AssetStore } from '@mylib/db'
import { seedUser, seedWork, useTestDb } from '@mylib/db/testing'
import { CreateSourceInput, err, ExternalItem, ok } from '@mylib/domain'
import { runCoversJob } from './run-covers'

const BASE = 'http://abs.test'
const box = createSecretBox(DEV_SECRET_KEY)
const http = createHttpClient({ fetch: absFixtureFetch(BASE) })
const html = new TextEncoder().encode('<!doctype html><html>not a cover</html>')

describe('covers job', () => {
  const t = useTestDb()

  it('downloads the cover of every linked copy and gives it to the edition', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const sourceId = await createSource(t.db, scope, box, CreateSourceInput.parse({ name: 'ABS', config: { kind: 'audiobookshelf', baseUrl: BASE, apiToken: ABS_FIXTURE_TOKEN } }))
    const config = { kind: 'audiobookshelf' as const, baseUrl: BASE, apiToken: ABS_FIXTURE_TOKEN, libraryIds: null }
    await syncSource(t.db, sourceId, getConnector('audiobookshelf').fetchItems(config, http))
    for (const entry of (await listInbox(t.db, scope)).items) await resolveSourceMatch(t.db, scope, entry.id, { action: 'create_work' })

    const store = createFileAssetStore(await mkdtemp(path.join(tmpdir(), 'covers-')))
    const result = await runCoversJob({ db: t.db, box, http, getConnector, store }, { sourceId })
    expect(result.saved).toBeGreaterThan(0)
    expect(result.failed).toBe(0)
    const rows = await t.db.select({ cover: editions.coverAssetId }).from(editions)
    expect(rows.every((r) => r.cover !== null)).toBe(true)
    // nothing left to do: a second run downloads nothing
    expect(await runCoversJob({ db: t.db, box, http, getConnector, store }, { sourceId })).toEqual({ saved: 0, failed: 0 })
  })

  /** An Audiobookshelf source with one linked, coverless copy per cover URL. */
  async function copiesWithCovers(coverUrls: string[]) {
    const scope = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const sourceId = await createSource(t.db, scope, box, CreateSourceInput.parse({ name: 'ABS', config: { kind: 'audiobookshelf', baseUrl: BASE, apiToken: ABS_FIXTURE_TOKEN } }))
    for (const [i, coverUrl] of coverUrls.entries()) {
      const { workId, editionIds } = await seedWork(t.db, { title: `Book ${i}`, formats: ['audiobook'] })
      const normalized = ExternalItem.parse({ externalId: `li_${i}`, format: 'audiobook', title: `Book ${i}`, coverUrl })
      await t.db.insert(sourceItems).values({ sourceId, externalId: `li_${i}`, normalized, contentHash: 'x', state: 'linked', workId, editionId: editionIds[0] ?? null })
    }
    return sourceId
  }
  const store = async (): Promise<AssetStore> => createFileAssetStore(await mkdtemp(path.join(tmpdir(), 'covers-')))
  const unchecked = async () => (await t.db.select({ checked: sourceItems.coverCheckedAt }).from(sourceItems)).filter((r) => r.checked === null).length
  const withCover = (fetchCover: Connector['fetchCover']) => () => ({ ...getConnector('audiobookshelf'), fetchCover })

  it('rejects a cover that is not an image, and waits a week before trying it again', async () => {
    const sourceId = await copiesWithCovers([`${BASE}/api/items/li_0/cover`])
    const deps = { db: t.db, box, http, getConnector: withCover(() => Promise.resolve(ok(html))), store: await store() }
    expect(await runCoversJob(deps, { sourceId })).toEqual({ saved: 0, failed: 1 })
    expect(await unchecked()).toBe(0)
    expect(await runCoversJob(deps, { sourceId })).toEqual({ saved: 0, failed: 0 })
  })

  it('skips a cover on another server without fetching it', async () => {
    const sourceId = await copiesWithCovers(['http://elsewhere.test/cover.jpg', `${BASE}/api/items/li_1/cover`])
    const deps = { db: t.db, box, http, getConnector, store: await store() }
    expect(await runCoversJob(deps, { sourceId })).toEqual({ saved: 1, failed: 1 })
    expect(await unchecked()).toBe(0)
  })

  it('stops the job without marking anything when our own store cannot write — the disk is not the cover\'s fault', async () => {
    const sourceId = await copiesWithCovers([0, 1, 2].map((i) => `${BASE}/api/items/li_${i}/cover`))
    const real = await store()
    let calls = 0
    const flaky: AssetStore = {
      put: (bytes, ext) => (++calls === 2 ? Promise.reject(new Error('ENOSPC: no space left on device')) : real.put(bytes, ext)),
      read: (p) => real.read(p),
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(await runCoversJob({ db: t.db, box, http, getConnector, store: flaky }, { sourceId })).toEqual({ saved: 1, failed: 0 })
      expect(logged).toHaveBeenCalledWith('[covers] could not store a cover, stopping', 'ENOSPC: no space left on device')
    } finally {
      logged.mockRestore()
    }
    expect(calls).toBe(2)
    expect((await t.db.select({ cover: editions.coverAssetId }).from(editions)).filter((r) => r.cover === null)).toHaveLength(2)
    // the two left are tried again by the next job, not a week later
    expect(await unchecked()).toBe(2)
  })

  it('stops after its wall-clock budget, leaving the rest unmarked for the next job', async () => {
    const sourceId = await copiesWithCovers([0, 1, 2].map((i) => `${BASE}/api/items/li_${i}/cover`))
    const start = Date.UTC(2026, 0, 5, 3, 0)
    let fetched = 0
    const counting = withCover((config, client, url) => {
      fetched++
      return getConnector('audiobookshelf').fetchCover(config, client, url)
    })
    // every clock reading after the first cover is 51 minutes later
    const now = () => (fetched === 0 ? start : start + 51 * 60_000)
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await runCoversJob({ db: t.db, box, http, getConnector: counting, store: await store(), now }, { sourceId })).toEqual({ saved: 1, failed: 0 })
    } finally {
      warned.mockRestore()
    }
    expect(fetched).toBe(1)
    expect(await unchecked()).toBe(2)
  })

  it('stops at an unreachable source without marking anything, so the next job tries them all again', async () => {
    const sourceId = await copiesWithCovers([0, 1, 2].map((i) => `${BASE}/api/items/li_${i}/cover`))
    let calls = 0
    const down = withCover(() => {
      calls++
      return Promise.resolve(err({ kind: 'unreachable' as const, message: 'Could not reach abs.test (ECONNREFUSED)' }))
    })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await runCoversJob({ db: t.db, box, http, getConnector: down, store: await store() }, { sourceId })).toEqual({ saved: 0, failed: 0 })
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('Could not reach abs.test'))
    } finally {
      warned.mockRestore()
    }
    expect(calls).toBe(1)
    expect(await unchecked()).toBe(3)
  })
  describe('shelf sources', () => {
    const GOOD = 'https://cdn.simania.co.il/bookimages/covers0/1.jpg'
    const EVIL = 'https://evil.example/x.jpg'

    async function shelfCopies(coverUrls: string[], kind: 'shelf' | 'csv' = 'shelf') {
      const [source] = await t.db.insert(sources).values({ kind, name: 'Shelf', config: { kind }, schedule: null }).returning({ id: sources.id })
      const sourceId = source?.id ?? ''
      for (const [i, coverUrl] of coverUrls.entries()) {
        const { workId, editionIds } = await seedWork(t.db, { title: `Shelf ${i}`, formats: ['physical'] })
        const normalized = ExternalItem.parse({ externalId: `s_${i}`, format: 'physical', title: `Shelf ${i}`, coverUrl })
        await t.db.insert(sourceItems).values({ sourceId, externalId: `s_${i}`, normalized, contentHash: 'x', state: 'linked', workId, editionId: editionIds[0] ?? null })
      }
      return sourceId
    }
    const recording = (respond: (url: string) => Response) => {
      const urls: string[] = []
      const client = createHttpClient({
        fetch: (url) => {
          urls.push(url)
          return Promise.resolve(respond(url))
        },
      })
      return { urls, client }
    }
    const png = () => new Response(COVER_PNG, { headers: { 'content-type': 'image/png' } })

    it('downloads a cover from the image host and never asks any other host', async () => {
      const sourceId = await shelfCopies([GOOD, EVIL])
      const { urls, client } = recording(png)
      const result = await runCoversJob({ db: t.db, box, http: client, getConnector, store: await store() }, { sourceId })
      expect(result).toEqual({ saved: 1, failed: 1 })
      expect(urls).toEqual([GOOD])
      expect(await unchecked()).toBe(0)
      expect((await t.db.select({ cover: editions.coverAssetId }).from(editions)).filter((r) => r.cover !== null)).toHaveLength(1)
    })

    it('treats a CSV import (a row linked to a book page) like a shelf batch: only the image host is asked', async () => {
      const sourceId = await shelfCopies([GOOD, EVIL], 'csv')
      const { urls, client } = recording(png)
      expect(await runCoversJob({ db: t.db, box, http: client, getConnector, store: await store() }, { sourceId })).toEqual({ saved: 1, failed: 1 })
      expect(urls).toEqual([GOOD])
    })

    it('counts a redirect from the cover URL as a failed cover, not a followed one', async () => {
      const sourceId = await shelfCopies([GOOD])
      const { urls, client } = recording(() => new Response(null, { status: 302, headers: { location: EVIL } }))
      expect(await runCoversJob({ db: t.db, box, http: client, getConnector, store: await store() }, { sourceId })).toEqual({ saved: 0, failed: 1 })
      expect(urls).toEqual([GOOD])
      expect(await unchecked()).toBe(0)
    })

    it("follows an Open Library cover into archive.org's storage, and no further than that", async () => {
      const OL = 'https://covers.openlibrary.org/b/id/12636224-L.jpg'
      const ZIP = 'https://archive.org/download/l_covers_0012/l_covers_0012_63.zip/0012636224-L.jpg'
      const STORE = 'https://ia800100.us.archive.org/view_archive.php?archive=/5/items/l_covers_0012/l_covers_0012_63.zip&file=0012636224-L.jpg'
      const OL2 = 'https://covers.openlibrary.org/b/id/2-L.jpg'
      const sourceId = await shelfCopies([OL, OL2])
      const hops: Record<string, string> = { [OL]: ZIP, [ZIP]: STORE, [OL2]: EVIL }
      const { urls, client } = recording((url) => (hops[url] === undefined ? png() : new Response(null, { status: 302, headers: { location: hops[url] } })))
      expect(await runCoversJob({ db: t.db, box, http: client, getConnector, store: await store() }, { sourceId })).toEqual({ saved: 1, failed: 1 })
      // the two covers come in either order; each one's hops in sequence
      expect(urls.filter((u) => u !== OL2)).toEqual([OL, ZIP, STORE])
      expect(urls.filter((u) => u === OL2)).toEqual([OL2])
    })
  })
})
