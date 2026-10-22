import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { CreateSourceInput, UpdateSourceInput } from '@mylib/domain'
import { editions, jobRuns, proposals, sourceItems, sources, works } from '../schema'
import { createSecretBox, DEV_SECRET_KEY } from '../secrets'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork } from './catalog'
import { requestSync } from './job-runs'
import { loadUserScope } from './scope'
import { createSource, deleteSource, getSourceConfig, listScheduledSources, listSources, loadSourceForSync, resealSourceSecrets, sourceRemovalInfo, updateSource } from './sources'

const box = createSecretBox(randomBytes(32).toString('base64'))
const input = (over: Record<string, unknown> = {}) =>
  CreateSourceInput.parse({
    name: 'Home ABS',
    config: { kind: 'audiobookshelf', baseUrl: 'http://abs.local:13378', apiToken: 'secret-token' },
    ...over,
  })

describe('sources repository', () => {
  const t = useTestDb()
  const admin = async () => loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))

  it('stores the token encrypted and never lists it', async () => {
    const scope = await admin()
    const id = await createSource(t.db, scope, box, input())
    const [row] = await t.db.select({ config: sources.config }).from(sources).where(eq(sources.id, id))
    expect(JSON.stringify(row?.config)).not.toContain('secret-token')

    const list = await listSources(t.db, scope, box)
    expect(list).toMatchObject([{ id, kind: 'audiobookshelf', name: 'Home ABS', schedule: null, config: { baseUrl: 'http://abs.local:13378', hasSecret: true } }])
    expect(JSON.stringify(list)).not.toContain('secret-token')
    expect(await getSourceConfig(t.db, scope, box, id)).toMatchObject({ apiToken: 'secret-token' })
  })

  it('keeps the stored token when an update omits it, and replaces it when given', async () => {
    const scope = await admin()
    const id = await createSource(t.db, scope, box, input())
    await updateSource(t.db, scope, box, id, UpdateSourceInput.parse({ name: 'ABS', config: { kind: 'audiobookshelf', baseUrl: 'http://abs.lan' } }))
    expect(await getSourceConfig(t.db, scope, box, id)).toMatchObject({ baseUrl: 'http://abs.lan', apiToken: 'secret-token' })
    await updateSource(t.db, scope, box, id, UpdateSourceInput.parse({ config: { kind: 'audiobookshelf', baseUrl: 'http://abs.lan', apiToken: 'new-token' } }))
    expect(await getSourceConfig(t.db, scope, box, id)).toMatchObject({ apiToken: 'new-token' })
    expect((await listSources(t.db, scope, box))[0]?.name).toBe('ABS')
  })

  it('is admin-only', async () => {
    const member = await loadUserScope(t.db, await seedUser(t.db))
    await expect(createSource(t.db, member, box, input())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(listSources(t.db, member, box)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('gives the worker the decrypted config and the scheduled sources', async () => {
    const scope = await admin()
    const daily = await createSource(t.db, scope, box, input({ schedule: 'daily' }))
    await createSource(t.db, scope, box, input({ name: 'Manual only' }))
    expect(await loadSourceForSync(t.db, box, daily)).toMatchObject({ id: daily, name: 'Home ABS', config: { apiToken: 'secret-token' } })
    expect(await loadSourceForSync(t.db, box, '11111111-1111-4111-8111-111111111111')).toBeNull()
    expect(await listScheduledSources(t.db)).toEqual([{ id: daily, schedule: 'daily' }])
  })

  it('survives a changed APP_SECRET_KEY: lists the source flagged, accepts a re-entered token, explains the failure', async () => {
    const scope = await admin()
    const id = await createSource(t.db, scope, box, input())
    const otherBox = createSecretBox(randomBytes(32).toString('base64'))
    const unreadable = "The stored API token can't be read (APP_SECRET_KEY changed?) — re-enter it."

    expect(await listSources(t.db, scope, otherBox)).toMatchObject([
      { id, credentialsUnreadable: true, config: { baseUrl: 'http://abs.local:13378', hasSecret: true } },
    ])
    expect((await listSources(t.db, scope, box))[0]?.credentialsUnreadable).toBe(false)
    await expect(getSourceConfig(t.db, scope, otherBox, id)).rejects.toMatchObject({ code: 'INVALID', message: unreadable })
    await expect(loadSourceForSync(t.db, otherBox, id)).rejects.toThrow(unreadable)
    await expect(
      updateSource(t.db, scope, otherBox, id, UpdateSourceInput.parse({ config: { kind: 'audiobookshelf', baseUrl: 'http://abs.lan' } })),
    ).rejects.toMatchObject({ code: 'INVALID', message: unreadable })

    await updateSource(
      t.db,
      scope,
      otherBox,
      id,
      UpdateSourceInput.parse({ config: { kind: 'audiobookshelf', baseUrl: 'http://abs.lan', apiToken: 're-entered' } }),
    )
    expect(await getSourceConfig(t.db, scope, otherBox, id)).toMatchObject({ apiToken: 're-entered' })
    expect((await listSources(t.db, scope, otherBox))[0]?.credentialsUnreadable).toBe(false)
  })

  it('answers NOT_FOUND for an unknown source', async () => {
    const scope = await admin()
    await expect(getSourceConfig(t.db, scope, box, '11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('seals each kind\'s own secret and keeps it when an update leaves it blank', async () => {
    const scope = await admin()
    const id = await createSource(
      t.db,
      scope,
      box,
      CreateSourceInput.parse({ name: 'Calibre', config: { kind: 'calibre', baseUrl: 'http://calibre.lan', username: 'me', password: 'pw-secret' } }),
    )
    const [row] = await t.db.select({ config: sources.config }).from(sources).where(eq(sources.id, id))
    expect(JSON.stringify(row?.config)).not.toContain('pw-secret')
    expect((await listSources(t.db, scope, box))[0]?.config).toEqual({
      kind: 'calibre',
      baseUrl: 'http://calibre.lan',
      username: 'me',
      libraryId: null,
      wordCountColumn: null,
      hasSecret: true,
    })

    await updateSource(t.db, scope, box, id, UpdateSourceInput.parse({ config: { kind: 'calibre', baseUrl: 'http://calibre.lan', username: 'me', wordCountColumn: '#words' } }))
    expect(await getSourceConfig(t.db, scope, box, id)).toMatchObject({ password: 'pw-secret', wordCountColumn: '#words' })
    await updateSource(t.db, scope, box, id, UpdateSourceInput.parse({ config: { kind: 'calibre', baseUrl: 'http://calibre.lan', username: null, password: null } }))
    expect(await getSourceConfig(t.db, scope, box, id)).toMatchObject({ username: null, password: null })
  })

  it('keeps CSV imports out of the sources list and the sync paths', async () => {
    const scope = await admin()
    const [csv] = await t.db
      .insert(sources)
      .values({ kind: 'csv', name: 'CSV: goodreads.csv', config: { kind: 'csv', ownerUserId: scope.userId, fileName: 'goodreads.csv' } })
      .returning({ id: sources.id })
    expect(await listSources(t.db, scope, box)).toEqual([])
    await expect(getSourceConfig(t.db, scope, box, csv?.id ?? '')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(requestSync(t.db, scope, csv?.id ?? '')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('resealSourceSecrets', () => {
  const t = useTestDb()
  const backupKey = createSecretBox(DEV_SECRET_KEY)
  const installKey = createSecretBox(Buffer.from('other-secret-key-for-restore-32!').toString('base64'))
  const strayKey = createSecretBox(Buffer.from('third-secret-key-for-the-tests!!').toString('base64'))

  async function admin() {
    return loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
  }

  it("re-seals every source secret from the backup's key to this install's key", async () => {
    const scope = await admin()
    const abs = await createSource(t.db, scope, backupKey, CreateSourceInput.parse({ name: 'ABS', config: { kind: 'audiobookshelf', baseUrl: 'http://abs.local:13378', apiToken: 'abs-token' } }))
    const readarr = await createSource(t.db, scope, backupKey, CreateSourceInput.parse({ name: 'Readarr', config: { kind: 'readarr', baseUrl: 'http://readarr:8787', apiKey: 'arr-key' } }))
    expect(await resealSourceSecrets(t.db, backupKey, installKey)).toEqual({ resealed: 2, unreadable: 0, unreadableSources: [] })
    expect((await loadSourceForSync(t.db, installKey, abs))?.config).toMatchObject({ apiToken: 'abs-token' })
    expect((await loadSourceForSync(t.db, installKey, readarr))?.config).toMatchObject({ apiKey: 'arr-key' })
    // a second pass finds nothing left to do
    expect(await resealSourceSecrets(t.db, backupKey, installKey)).toEqual({ resealed: 0, unreadable: 0, unreadableSources: [] })
  })

  it('changes nothing when the backup and this install share the key', async () => {
    const scope = await admin()
    const id = await createSource(t.db, scope, backupKey, CreateSourceInput.parse({ name: 'ABS', config: { kind: 'audiobookshelf', baseUrl: 'http://abs.local:13378', apiToken: 'abs-token' } }))
    const [before] = await t.db.select({ config: sources.config }).from(sources).where(eq(sources.id, id))
    expect(await resealSourceSecrets(t.db, backupKey, backupKey)).toEqual({ resealed: 0, unreadable: 0, unreadableSources: [] })
    const [after] = await t.db.select({ config: sources.config }).from(sources).where(eq(sources.id, id))
    expect(after).toEqual(before)
  })

  it('keeps a secret that was already unreadable and reports it', async () => {
    const scope = await admin()
    const stray = await createSource(t.db, scope, strayKey, CreateSourceInput.parse({ name: 'Old ABS', config: { kind: 'audiobookshelf', baseUrl: 'http://old.local', apiToken: 'lost' } }))
    const [before] = await t.db.select({ config: sources.config }).from(sources).where(eq(sources.id, stray))
    expect(await resealSourceSecrets(t.db, backupKey, installKey)).toEqual({ resealed: 0, unreadable: 1, unreadableSources: ['Old ABS'] })
    const [after] = await t.db.select({ config: sources.config }).from(sources).where(eq(sources.id, stray))
    expect(after).toEqual(before)
    await expect(loadSourceForSync(t.db, installKey, stray)).rejects.toMatchObject({ code: 'INVALID' })
  })
})

describe('removing a source (#103)', () => {
  const t = useTestDb()

  it('counts pending proposals and books, then drops the source with its items and proposals but keeps the books', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const id = await createSource(t.db, scope, box, input())
    const work = await createWork(t.db, workInput({ title: 'Synced', series: [] }))
    const normalized = { title: 'Synced' } as never
    const [linked, pending] = await t.db.insert(sourceItems).values([
      { sourceId: id, externalId: 'a', normalized, contentHash: 'a', workId: work, state: 'linked' },
      { sourceId: id, externalId: 'b', normalized, contentHash: 'b' },
    ]).returning({ id: sourceItems.id })
    await t.db.insert(proposals).values([
      { kind: 'new_work', payload: {}, scope: 'catalog', createdBy: 'sync', sourceItemId: pending?.id },
      { kind: 'source_match', payload: {}, scope: 'catalog', createdBy: 'sync', sourceItemId: linked?.id, status: 'accepted' },
    ])
    expect(await sourceRemovalInfo(t.db, scope, id)).toEqual({ pendingProposals: 1, books: 1 })

    // refused while a sync runs
    const run = await requestSync(t.db, scope, id)
    await t.db.update(jobRuns).set({ status: 'running' }).where(eq(jobRuns.id, run.runId))
    await expect(deleteSource(t.db, scope, id)).rejects.toMatchObject({ code: 'CONFLICT' })
    await t.db.update(jobRuns).set({ status: 'failed' }).where(eq(jobRuns.id, run.runId))

    await deleteSource(t.db, scope, id)
    expect(await t.db.select().from(sources)).toEqual([])
    expect(await t.db.select().from(sourceItems)).toEqual([])
    expect(await t.db.select().from(proposals)).toEqual([])
    expect(await t.db.select().from(jobRuns)).toEqual([])
    expect((await t.db.select().from(works)).map((w) => w.id)).toEqual([work])
    expect(await t.db.select().from(editions)).toHaveLength(1)
    await expect(deleteSource(t.db, scope, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(sourceRemovalInfo(t.db, scope, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
