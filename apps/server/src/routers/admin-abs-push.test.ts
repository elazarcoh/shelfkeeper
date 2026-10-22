import { describe, expect, it } from 'vitest'
import { editions, getAbsPushRun, sourceItems, sources } from '@mylib/db'
import { absPushFields } from '@mylib/domain'
import { useServerHarness } from '../testing/harness'

describe('admin Audiobookshelf send router (#115)', () => {
  const h = useServerHarness()

  /** A linked ABS audiobook whose title differs from the book's, so it is out of sync. */
  async function outOfSync(admin: Awaited<ReturnType<typeof h.asNewUser>>, title: string, externalId: string) {
    const { workId } = await admin.api.catalog.create({ work: { title, authors: ['Wildbow'], editions: [{ format: 'audiobook' }] } })
    const [edition] = await h.db.select({ id: editions.id }).from(editions)
    let [source] = await h.db.select().from(sources)
    source ??= (await h.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning())[0]
    const [item] = await h.db
      .insert(sourceItems)
      .values({
        sourceId: source?.id ?? '',
        externalId,
        raw: { id: externalId, media: { metadata: { title: `${title} (audio)`, authors: [{ name: 'Wildbow' }], narrators: [], series: [] } } },
        normalized: { externalId, format: 'audiobook', title, authors: [], narrators: [], series: [], identifiers: { others: {} }, tags: [] } as never,
        contentHash: 'h',
        editionId: edition?.id ?? '',
        workId,
        state: 'linked',
      })
      .returning({ id: sourceItems.id })
    return item?.id ?? ''
  }

  async function sendInput(admin: Awaited<ReturnType<typeof h.asNewUser>>) {
    const { rows } = await admin.api.admin.absPush.list({ showIgnored: false })
    return { books: rows.map((r) => ({ sourceItemId: r.sourceItemId, fields: r.diffs.map((d) => ({ field: d.field, hash: d.hash })) })) }
  }

  it('member is forbidden', async () => {
    const member = await h.asNewUser()
    await expect(member.api.admin.absPush.list({ showIgnored: false })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.absPush.setFields({ fields: ['title'] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.absPush.send({ books: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(member.api.admin.absPush.run({ runId: '00000000-0000-4000-8000-000000000001' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('list returns rows and the person’s fields', async () => {
    const admin = await h.asNewUser('admin')
    const id = await outOfSync(admin, 'Worm', 'li_1')
    const res = await admin.api.admin.absPush.list({ showIgnored: false })
    expect(res.rows).toMatchObject([{ sourceItemId: id, title: 'Worm', diffs: [{ field: 'title' }] }])
    expect(res.fields).toEqual([...absPushFields])
    expect(res.run).toBeNull()
  })

  it('setFields is per person', async () => {
    const a = await h.asNewUser('admin')
    const b = await h.asNewUser('admin')
    await a.api.admin.absPush.setFields({ fields: ['title', 'authors'] })
    expect((await a.api.admin.absPush.list({ showIgnored: false })).fields).toEqual(['title', 'authors'])
    expect((await b.api.admin.absPush.list({ showIgnored: false })).fields).toEqual([...absPushFields])
  })

  it('send queues one job', async () => {
    const admin = await h.asNewUser('admin')
    await outOfSync(admin, 'Worm', 'li_1')
    const { runId } = await admin.api.admin.absPush.send(await sendInput(admin))
    expect(h.absPushEnqueued).toEqual([{ runId }])
    expect(await admin.api.admin.absPush.run({ runId })).toMatchObject({ id: runId, status: 'running', request: [{ fields: [{ field: 'title' }] }] })
    expect((await admin.api.admin.absPush.list({ showIgnored: false })).run).toMatchObject({ id: runId })
  })

  it('second send while running is CONFLICT', async () => {
    const admin = await h.asNewUser('admin')
    await outOfSync(admin, 'Worm', 'li_1')
    const input = await sendInput(admin)
    await admin.api.admin.absPush.send(input)
    await expect(admin.api.admin.absPush.send(input)).rejects.toMatchObject({ code: 'CONFLICT', message: 'A send is already running' })
    expect(h.absPushEnqueued).toHaveLength(1)
  })

  it('a failed enqueue finishes the run as failed so the next send is not blocked', async () => {
    const admin = await h.asNewUser('admin')
    await outOfSync(admin, 'Worm', 'li_1')
    const input = await sendInput(admin)
    h.queue.failWith = new Error('redis down')
    await expect(admin.api.admin.absPush.send(input)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
    const last = (await admin.api.admin.absPush.list({ showIgnored: false })).run
    expect(last).toMatchObject({ status: 'failed', error: 'redis down' })
    expect(await getAbsPushRun(h.db, last?.id ?? '')).toMatchObject({ status: 'failed' })
    h.queue.failWith = null
    await admin.api.admin.absPush.send(input)
    expect(h.absPushEnqueued).toHaveLength(1)
  })

  it('run of an unknown id is NOT_FOUND', async () => {
    const admin = await h.asNewUser('admin')
    await expect(admin.api.admin.absPush.run({ runId: '00000000-0000-4000-8000-000000000001' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('ignore hides a row', async () => {
    const admin = await h.asNewUser('admin')
    const id = await outOfSync(admin, 'Worm', 'li_1')
    await admin.api.admin.health.ignore({ check: 'abs_out_of_sync', subjectKey: id })
    expect((await admin.api.admin.absPush.list({ showIgnored: false })).rows).toEqual([])
    expect((await admin.api.admin.absPush.list({ showIgnored: true })).rows).toHaveLength(1)
    await admin.api.admin.health.unignore({ check: 'abs_out_of_sync', subjectKey: id })
    expect((await admin.api.admin.absPush.list({ showIgnored: false })).rows).toHaveLength(1)
  })
})
