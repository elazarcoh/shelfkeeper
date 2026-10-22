import { describe, expect, it } from 'vitest'
import { createHttpClient, type FetchLike } from '@mylib/connectors'
import { createSecretBox, createSource, DEV_SECRET_KEY, getAbsPushRun, listAbsOutOfSync, loadUserScope, sourceItems, startAbsPushRun, workTitles } from '@mylib/db'
import { seedUser, seedWork, useTestDb } from '@mylib/db/testing'
import { CreateSourceInput } from '@mylib/domain'
import { runAbsPushJob } from './run-abs-push'

const BASE = 'http://abs.test'
const box = createSecretBox(DEV_SECRET_KEY)
const KEY_COPY = "The Audiobookshelf key can't edit books"

type Meta = Record<string, unknown>
const item = (id: string, meta: Meta) => ({
  id,
  mediaType: 'book',
  media: { metadata: { title: 'x', authors: [{ name: 'Wildbow' }], narrators: [], series: [], genres: [], ...meta }, tags: [], audioFiles: [{}], numAudioFiles: 1, duration: 60 },
})

describe('runAbsPushJob', () => {
  const t = useTestDb()

  /** A fake ABS: items by id, GET returns them, PATCH answers `patchStatus(id, n)` and applies the metadata when it is 200. */
  function fakeAbs(items: Map<string, Meta>, patchStatus: (id: string, n: number) => number, transform: (m: Meta) => Meta = (m) => m) {
    const patches: { id: string; body: unknown }[] = []
    const fetch: FetchLike = (url, init) => {
      const id = decodeURIComponent(new URL(url).pathname.split('/')[3] ?? '')
      if (init.method === 'GET') {
        const meta = items.get(id)
        return Promise.resolve(meta ? Response.json(item(id, meta)) : new Response('', { status: 404 }))
      }
      patches.push({ id, body: JSON.parse(init.body ?? '{}') })
      const status = patchStatus(id, patches.length)
      if (status === 200) {
        const sent = (JSON.parse(init.body ?? '{}') as { metadata: Meta }).metadata
        items.set(id, { ...(items.get(id) ?? {}), ...transform(sent) })
      }
      return Promise.resolve(new Response('{}', { status, headers: { 'content-type': 'application/json' } }))
    }
    return { fetch, patches }
  }

  async function setup(titles: string[]) {
    const admin = await seedUser(t.db, { role: 'admin' })
    const scope = await loadUserScope(t.db, admin)
    const sourceId = await createSource(t.db, scope, box, CreateSourceInput.parse({ name: 'ABS', config: { kind: 'audiobookshelf', baseUrl: BASE, apiToken: 'secret-key' } }))
    const items = new Map<string, Meta>()
    const ids: string[] = []
    for (const [i, title] of titles.entries()) {
      const w = await seedWork(t.db, { title, formats: ['audiobook'], authors: ['Wildbow'] })
      const externalId = `li_${i + 1}`
      const meta: Meta = { title: `${title} (audiobook)` }
      items.set(externalId, meta)
      const [row] = await t.db
        .insert(sourceItems)
        .values({
          sourceId,
          externalId,
          raw: item(externalId, meta),
          normalized: { externalId, format: 'audiobook', title: `${title} (audiobook)`, authors: [], narrators: [], series: [], identifiers: { others: {} }, tags: [] } as never,
          contentHash: 'h',
          editionId: w.editionIds[0] ?? '',
          workId: w.workId,
          state: 'linked',
        })
        .returning({ id: sourceItems.id })
      ids.push(row?.id ?? '')
    }
    const { rows } = await listAbsOutOfSync(t.db, { showIgnored: false })
    const books = ids.map((sourceItemId) => ({
      sourceItemId,
      fields: (rows.find((r) => r.sourceItemId === sourceItemId)?.diffs ?? []).filter((d) => d.field === 'title').map((d) => ({ field: d.field, hash: d.hash })),
    }))
    const runId = (await startAbsPushRun(t.db, admin.id, books)) ?? ''
    return { items, ids, runId }
  }

  const deps = (fetch: FetchLike) => ({ db: t.db, box, http: createHttpClient({ fetch }) })

  it('sends ticked fields and re-reads', async () => {
    const s = await setup(['Worm'])
    const abs = fakeAbs(s.items, () => 200)
    await runAbsPushJob(deps(abs.fetch), { runId: s.runId })
    expect(abs.patches).toEqual([{ id: 'li_1', body: { metadata: { title: 'Worm' } } }])
    const run = await getAbsPushRun(t.db, s.runId)
    expect(run?.status).toBe('succeeded')
    expect(run?.results).toMatchObject([{ outcome: 'sent', message: null }])
    const [stored] = await t.db.select({ raw: sourceItems.raw }).from(sourceItems)
    expect(JSON.stringify(stored?.raw)).toContain('"title":"Worm"')
    expect((await listAbsOutOfSync(t.db, { showIgnored: false })).rows).toEqual([])
  })

  it('skips a book edited after preview', async () => {
    const s = await setup(['Worm'])
    await t.db.update(workTitles).set({ title: 'Worm 2' })
    const abs = fakeAbs(s.items, () => 200)
    await runAbsPushJob(deps(abs.fetch), { runId: s.runId })
    expect(abs.patches).toHaveLength(0)
    const run = await getAbsPushRun(t.db, s.runId)
    expect(run?.results).toMatchObject([{ outcome: 'skipped', message: 'changed since you looked — review it again' }])
    expect(run?.status).toBe('succeeded')
  })

  it('403 on the first book stops at once', async () => {
    const s = await setup(['A', 'B', 'C'])
    const abs = fakeAbs(s.items, () => 403)
    await runAbsPushJob(deps(abs.fetch), { runId: s.runId })
    const run = await getAbsPushRun(t.db, s.runId)
    expect(run?.results.map((r) => [r.outcome, r.message])).toEqual([['failed', KEY_COPY], ['not_sent', 'not sent'], ['not_sent', 'not sent']])
    expect(run).toMatchObject({ status: 'stopped', error: KEY_COPY })
    expect(abs.patches).toHaveLength(1)
  })

  it('403 mid-run stops after its batch', async () => {
    const s = await setup(['A', 'B', 'C', 'D', 'E', 'F'])
    const abs = fakeAbs(s.items, (_id, n) => (n === 1 ? 200 : 403))
    await runAbsPushJob(deps(abs.fetch), { runId: s.runId })
    const run = await getAbsPushRun(t.db, s.runId)
    expect(run?.results.map((r) => r.outcome)).toEqual(['sent', 'failed', 'failed', 'failed', 'failed', 'not_sent'])
    expect(run?.results.slice(1, 5).every((r) => r.message === KEY_COPY)).toBe(true)
    expect(run?.results[5]?.message).toBe('not sent')
    expect(run).toMatchObject({ status: 'stopped', error: KEY_COPY })
    expect(abs.patches).toHaveLength(5)
  })

  it('404 is item gone and the run continues', async () => {
    const s = await setup(['A', 'B'])
    const abs = fakeAbs(s.items, (id) => (id === 'li_1' ? 404 : 200))
    await runAbsPushJob(deps(abs.fetch), { runId: s.runId })
    const run = await getAbsPushRun(t.db, s.runId)
    expect(run?.results.map((r) => [r.outcome, r.message])).toEqual([['failed', 'item gone'], ['sent', null]])
    expect(run?.status).toBe('succeeded')
  })

  it('ABS normalising a value reports it', async () => {
    const s = await setup(['Worm'])
    const abs = fakeAbs(s.items, () => 200, (m) => ({ ...m, title: String(m.title).toUpperCase() }))
    await runAbsPushJob(deps(abs.fetch), { runId: s.runId })
    const run = await getAbsPushRun(t.db, s.runId)
    expect(run?.results).toMatchObject([{ outcome: 'sent', message: 'sent, but Audiobookshelf stored Title differently' }])
  })

  it('a run not running is ignored', async () => {
    const s = await setup(['Worm'])
    const abs = fakeAbs(s.items, () => 200)
    await runAbsPushJob(deps(abs.fetch), { runId: s.runId })
    await runAbsPushJob(deps(abs.fetch), { runId: s.runId })
    expect(abs.patches).toHaveLength(1)
    expect((await getAbsPushRun(t.db, s.runId))?.results).toHaveLength(1)
  })
})
