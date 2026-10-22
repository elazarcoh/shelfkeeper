import { describe, expect, it, vi } from 'vitest'
import { audiobookshelf, createHttpClient } from '@mylib/connectors'
import { ABS_FIXTURE_TOKEN, ARR_FIXTURE_KEY, CALIBRE_FIXTURE_PASSWORD, CALIBRE_FIXTURE_USER, absFixtureFetch } from '@mylib/connectors/testing'
import { syncSource } from '@mylib/db'
import { ABS_TEST_URL, CALIBRE_TEST_URL, READARR_TEST_URL, useServerHarness } from '../testing/harness'

const absConfig = { kind: 'audiobookshelf' as const, baseUrl: ABS_TEST_URL, apiToken: ABS_FIXTURE_TOKEN, libraryIds: null }

describe('sources, jobs and inbox routers', () => {
  const h = useServerHarness()

  it('adds a source without ever returning its token, and tests the connection', async () => {
    const { api } = await h.asNewUser('admin')
    const sourceId = await api.sources.create({ name: 'Home ABS', config: absConfig })
    const list = await api.sources.list()
    expect(list).toMatchObject([{ id: sourceId, name: 'Home ABS', config: { baseUrl: ABS_TEST_URL, hasSecret: true } }])
    expect(JSON.stringify(list)).not.toContain(ABS_FIXTURE_TOKEN)
    expect(await api.sources.test({ sourceId })).toEqual({ ok: true, value: { libraries: ['Audiobooks'] } })

    await api.sources.update({ sourceId, patch: { config: { ...absConfig, apiToken: 'wrong' } } })
    expect(await api.sources.test({ sourceId })).toMatchObject({ ok: false, error: { kind: 'unauthorized' } })
  })

  it('queues "Sync now" and "Re-run" for the worker', async () => {
    const { api } = await h.asNewUser('admin')
    const sourceId = await api.sources.create({ name: 'Home ABS', config: absConfig })
    const run = await api.sources.syncNow({ sourceId })
    expect(h.enqueued).toEqual([run])
    const [listed] = await api.jobs.list()
    expect(listed).toMatchObject({ id: run.runId, sourceName: 'Home ABS', trigger: 'manual', status: 'queued' })
    const again = await api.jobs.rerun({ runId: run.runId })
    expect(h.enqueued).toEqual([run, again])
  })

  it('records the run as failed when it cannot be queued', async () => {
    const { api } = await h.asNewUser('admin')
    const sourceId = await api.sources.create({ name: 'Home ABS', config: absConfig })
    h.queue.failWith = new Error('queue is down')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // the client gets a generic 500 (#5); the reason stays on the run, which admins see in Jobs
      await expect(api.sources.syncNow({ sourceId })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong. Please try again.' })
      const [run] = await api.jobs.list()
      expect(run).toMatchObject({ status: 'failed', error: 'queue is down' })
      await expect(api.jobs.rerun({ runId: run?.id ?? '' })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong. Please try again.' })
      expect(logged.mock.calls.map((c) => c.join(' '))).toEqual(['[trpc] sources.syncNow failed: queue is down', '[trpc] jobs.rerun failed: queue is down'])
    } finally {
      logged.mockRestore()
    }
    expect((await api.jobs.list()).map((r) => r.status)).toEqual(['failed', 'failed'])
  })

  it('resolves Inbox items through the API', async () => {
    const { api } = await h.asNewUser('admin')
    const sourceId = await api.sources.create({ name: 'Home ABS', config: absConfig })
    const http = createHttpClient({ fetch: absFixtureFetch(ABS_TEST_URL) })
    await syncSource(h.db, sourceId, audiobookshelf.fetchItems(absConfig, http))

    expect(await api.inbox.count()).toBe(3)
    const mistborn = (await api.inbox.list()).items.find((i) => i.item.externalId === 'li_mistborn')
    const { workId } = await api.inbox.resolve({ proposalId: mistborn?.id ?? '', resolution: { action: 'create_work' } })
    expect((await api.catalog.get({ workId: workId ?? '' })).editions).toMatchObject([{ format: 'audiobook', asin: 'B002UZMLXM' }])
    expect(await api.inbox.count()).toBe(2)
    expect(await api.inbox.acceptExact()).toEqual({ accepted: 0, remaining: 0 })

    expect((await api.inbox.list()).total).toBe(2)
    // the page asks for more as it is scrolled; the total counts them all
    expect(await api.inbox.list({ limit: 1 })).toMatchObject({ items: [expect.anything()], total: 2 })
    // Harry Potter's audiobook and its ebook sibling land on one new book
    expect(await api.inbox.createUnmatched()).toEqual({ created: 1, linked: 1, wanted: 0, skipped: 0, remaining: 0 })
    expect(await api.inbox.count()).toBe(0)
  })

  it('adds and tests Calibre and Readarr sources', async () => {
    const { api } = await h.asNewUser('admin')
    const calibreId = await api.sources.create({
      name: 'Calibre',
      config: { kind: 'calibre', baseUrl: CALIBRE_TEST_URL, username: CALIBRE_FIXTURE_USER, password: CALIBRE_FIXTURE_PASSWORD, libraryId: null, wordCountColumn: null },
      schedule: null,
    })
    expect(await api.sources.test({ sourceId: calibreId })).toEqual({ ok: true, value: { libraries: ['Calibre Library'] } })
    const readarrId = await api.sources.create({ name: 'Readarr', config: { kind: 'readarr', baseUrl: READARR_TEST_URL, apiKey: ARR_FIXTURE_KEY }, schedule: null })
    expect(await api.sources.test({ sourceId: readarrId })).toEqual({ ok: true, value: { libraries: ['Readarr 0.4.18.2805'] } })
    const list = await api.sources.list()
    expect(list.map((s) => [s.kind, s.config.hasSecret])).toEqual([
      ['calibre', true],
      ['readarr', true],
    ])
  })

  it('keeps sources, jobs and the Inbox away from members', async () => {
    const { api } = await h.asNewUser()
    await expect(api.sources.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(api.jobs.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(api.inbox.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(api.inbox.createUnmatched()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await api.inbox.count()).toBe(0)
  })

  it('queues a covers download after an Inbox item is filed', async () => {
    const { api, user } = await h.asNewUser('admin')
    const sourceId = await api.sources.create({ name: 'Home ABS', config: absConfig })
    await syncSource(h.db, sourceId, audiobookshelf.fetchItems(absConfig, createHttpClient({ fetch: absFixtureFetch(ABS_TEST_URL) })))
    const { items } = await api.inbox.list()
    await api.inbox.resolve({ proposalId: items[0]?.id ?? '', resolution: { action: 'create_work' } })
    expect(h.coversEnqueued).toEqual([sourceId])
    expect(user.role).toBe('admin')
  })

  it('queues covers for every synced source after bulk filing, and a queue failure does not fail the filing', async () => {
    const { api } = await h.asNewUser('admin')
    const sourceId = await api.sources.create({ name: 'Home ABS', config: absConfig })
    await syncSource(h.db, sourceId, audiobookshelf.fetchItems(absConfig, createHttpClient({ fetch: absFixtureFetch(ABS_TEST_URL) })))
    await api.inbox.acceptExact()
    expect(h.coversEnqueued).toEqual([sourceId])
    h.coversEnqueued.length = 0

    h.queue.failWith = new Error('queue down')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(await api.inbox.createUnmatched()).toMatchObject({ remaining: 0 })
      expect(await api.inbox.acceptExact()).toMatchObject({ accepted: 0 })
      expect(logged).toHaveBeenCalledWith('[inbox] could not queue covers', h.queue.failWith)
    } finally {
      logged.mockRestore()
    }
    expect(h.coversEnqueued).toEqual([])
    expect((await api.inbox.list()).items).toEqual([])

    h.queue.failWith = null
    await api.inbox.createUnmatched()
    expect(h.coversEnqueued).toEqual([sourceId])
  })
})
