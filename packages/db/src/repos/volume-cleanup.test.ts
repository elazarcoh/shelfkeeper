import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { dailyStats, editions, readingProgress, readingSessions, userWorks, workSearch, works } from '../schema'
import { seedSession, seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail } from './catalog'
import { loadUserScope } from './scope'
import { rebuildDailyStats } from './stats'
import { listVolumeCatalog, mergeAsVolumes } from './volume-cleanup'

describe('volume cleanup', () => {
  const t = useTestDb()
  const adminUser = async () => seedUser(t.db, { role: 'admin' })
  const scopeOf = async (user: { id: string; role: 'admin' | 'member' }) => loadUserScope(t.db, user)
  const book = (title: string, over: Parameters<typeof workInput>[0] = {}) =>
    createWork(t.db, workInput({ title, series: [], editions: [{ format: 'physical', language: 'he' }], ...over }))
  const editionsOf = async (workId: string) =>
    t.db.select().from(editions).where(eq(editions.workId, workId)).orderBy(asc(editions.volume), asc(editions.id))
  const firstEdition = async (workId: string) => (await editionsOf(workId))[0]?.id ?? ''
  const pair = (one: string, two: string, over: { title?: string; volumeCount?: number | null } = {}) => ({
    survivorId: one,
    title: over.title ?? 'Saga',
    members: [
      { workId: one, volume: 1 },
      { workId: two, volume: 2 },
    ],
    volumeCount: over.volumeCount === undefined ? 2 : over.volumeCount,
  })

  it('lists visible works with authors, series and editions, for admins only', async () => {
    const admin = await adminUser()
    const member = await seedUser(t.db)
    const id = await book('Saga, Volume 1', {
      authors: ['Brian K. Vaughan', 'Fiona Staples'],
      series: [{ name: 'Saga', position: 1 }],
      editions: [
        { format: 'physical', language: 'he', isbn13: '9781534396425', volume: 2, volumeCount: 2 },
        { format: 'ebook', language: 'en', volume: 1, volumeCount: 2 },
        { format: 'audiobook' },
      ],
    })
    const catalog = await listVolumeCatalog(t.db, await scopeOf(admin))
    const entry = catalog.find((e) => e.id === id)
    expect(entry).toMatchObject({ title: 'Saga, Volume 1', subtitle: null, authors: ['Brian K. Vaughan', 'Fiona Staples'], series: [{ name: 'Saga', position: 1 }] })
    expect(entry?.editions.map((e) => [e.volume, e.volumeCount, e.format, e.isbn])).toEqual([
      [1, 2, 'ebook', null],
      [2, 2, 'physical', '9781534396425'],
      [null, null, 'audiobook', null],
    ])
    await expect(listVolumeCatalog(t.db, await scopeOf(member))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('merges Saga, Volume 1 and 2 into one book with volume editions', async () => {
    const scope = await scopeOf(await adminUser())
    const one = await book('Saga, Volume 1')
    const two = await book('Saga, Volume 2')
    const result = await mergeAsVolumes(t.db, scope, pair(one, two))
    expect(result.workId).toBe(one)
    const merged = await getWorkDetail(t.db, scope, one)
    expect(merged.title).toBe('Saga')
    expect(merged.editions.map((e) => [e.volume, e.volumeCount, e.format, e.language]).sort()).toEqual([
      [1, 2, 'physical', 'he'],
      [2, 2, 'physical', 'he'],
    ])
    expect(await t.db.select().from(works).where(eq(works.id, two))).toEqual([])
  })

  it('keeps volumes already on editions', async () => {
    const scope = await scopeOf(await adminUser())
    const survivor = await book('Saga', {
      editions: [
        { format: 'physical', language: 'he', volume: 1, volumeCount: 3 },
        { format: 'physical', language: 'he', volume: 2, volumeCount: 3 },
      ],
    })
    const stray = await book('Saga 3')
    await mergeAsVolumes(t.db, scope, {
      survivorId: survivor,
      title: 'Saga',
      members: [
        { workId: survivor, volume: null },
        { workId: stray, volume: 3 },
      ],
      volumeCount: null,
    })
    expect((await editionsOf(survivor)).map((e) => [e.volume, e.volumeCount])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })

  it('refuses a count below a volume in the catalog and changes nothing', async () => {
    const scope = await scopeOf(await adminUser())
    const one = await book('Saga 1')
    const two = await book('Saga 2', { editions: [{ format: 'physical', language: 'he', volume: 3 }] })
    await expect(mergeAsVolumes(t.db, scope, pair(one, two))).rejects.toMatchObject({ code: 'INVALID' })
    expect(await t.db.select().from(works).where(eq(works.id, two))).toHaveLength(1)
    expect((await editionsOf(one)).map((e) => e.volume)).toEqual([null])
    expect((await editionsOf(two)).map((e) => e.volume)).toEqual([3])
    expect((await getWorkDetail(t.db, scope, one)).title).toBe('Saga 1')
  })

  it('joins one person’s per-volume past reads into one and leaves others alone', async () => {
    const scope = await scopeOf(await adminUser())
    const ann = await seedUser(t.db, { username: 'ann' })
    const ben = await seedUser(t.db, { username: 'ben' })
    const one = await book('Saga 1')
    const two = await book('Saga 2')
    const e1 = await firstEdition(one)
    const e2 = await firstEdition(two)
    const a1 = await seedSession(t.db, { userId: ann.id, workId: one, editionId: e1, startedOn: '2026-01-10', outcome: 'finished', finishedOn: '2026-01-10' })
    const a2 = await seedSession(t.db, { userId: ann.id, workId: two, editionId: e2, startedOn: '2026-02-10', outcome: 'finished', finishedOn: '2026-02-10' })
    const b1 = await seedSession(t.db, { userId: ben.id, workId: one, editionId: e1, startedOn: '2026-03-01', outcome: 'finished', finishedOn: '2026-03-05' })

    const result = await mergeAsVolumes(t.db, scope, pair(one, two))

    expect(result.fused).toEqual(['ann: 2 reads joined into one (vols 1, 2)'])
    const annSessions = await t.db.select().from(readingSessions).where(eq(readingSessions.userId, ann.id))
    expect(annSessions).toHaveLength(1)
    expect(annSessions[0]).toMatchObject({ id: a1, workId: one, editionId: e2, startedOn: '2026-01-10', finishedOn: '2026-02-10', outcome: 'finished', fractionCompleted: 1 })
    expect(await t.db.select().from(readingSessions).where(eq(readingSessions.id, a2))).toEqual([])
    const benSessions = await t.db.select().from(readingSessions).where(eq(readingSessions.userId, ben.id))
    expect(benSessions.map((s) => s.id)).toEqual([b1])
  })

  it('chains reads with progress points, a shared day keeping both volumes and the later read winning within one volume', async () => {
    const scope = await scopeOf(await adminUser())
    const ann = await seedUser(t.db, { username: 'ann' })
    const one = await book('Saga 1')
    const two = await book('Saga 2')
    const e1 = await firstEdition(one)
    const e2 = await firstEdition(two)
    const s1 = await seedSession(t.db, { userId: ann.id, workId: one, editionId: e1, startedOn: '2026-01-01', outcome: 'finished', finishedOn: '2026-01-10' })
    const s2 = await seedSession(t.db, { userId: ann.id, workId: two, editionId: e2, startedOn: '2026-01-10' })
    await t.db.insert(readingProgress).values([
      { sessionId: s1, occurredOn: '2026-01-05', kind: 'percent', value: 50, editionId: e1 },
      { sessionId: s1, occurredOn: '2026-01-10', kind: 'percent', value: 100, editionId: e1 },
      { sessionId: s1, occurredOn: '2026-01-15', kind: 'percent', value: 20, editionId: e2 },
      { sessionId: s2, occurredOn: '2026-01-10', kind: 'percent', value: 10, editionId: e2 },
      { sessionId: s2, occurredOn: '2026-01-15', kind: 'percent', value: 40, editionId: e2 },
    ])

    await mergeAsVolumes(t.db, scope, pair(one, two))

    const sessions = await t.db.select().from(readingSessions).where(eq(readingSessions.userId, ann.id))
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: s1, editionId: e2, outcome: 'in_progress', finishedOn: null })
    const points = await t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, s1)).orderBy(asc(readingProgress.occurredOn))
    expect(points.map((p) => [p.occurredOn, p.value, p.editionId])).toEqual([
      ['2026-01-05', 50, e1],
      ['2026-01-10', 100, e1],
      ['2026-01-10', 10, e2],
      ['2026-01-15', 40, e2],
    ])
  })

  it('cleans a volume marker out of the survivor’s subtitle and reindexes the title', async () => {
    const scope = await scopeOf(await adminUser())
    const one = await book('Saga', { subtitle: "כרך א'" })
    const two = await book('Saga', { subtitle: "כרך ב'" })
    await mergeAsVolumes(t.db, scope, pair(one, two, { title: 'Saga Complete', volumeCount: null }))
    const merged = await getWorkDetail(t.db, scope, one)
    expect(merged.title).toBe('Saga Complete')
    expect(merged.subtitle).toBeNull()
    const [row] = await t.db.select().from(workSearch).where(eq(workSearch.workId, one))
    expect(row?.titleText).toContain('saga complete')
    expect(row?.document).not.toContain('כרך')
  })

  it('leaves daily stats as a fresh rebuild would', async () => {
    const scope = await scopeOf(await adminUser())
    const ann = await seedUser(t.db, { username: 'ann' })
    const one = await book('Saga 1')
    const two = await book('Saga 2')
    await seedSession(t.db, { userId: ann.id, workId: one, editionId: await firstEdition(one), startedOn: '2026-01-10', outcome: 'finished', finishedOn: '2026-01-10' })
    await seedSession(t.db, { userId: ann.id, workId: two, editionId: await firstEdition(two), startedOn: '2026-02-10', outcome: 'finished', finishedOn: '2026-02-10' })
    await t.db.insert(dailyStats).values({ userId: ann.id, date: '2026-01-10', mode: 'read', minutes: 9999, words: 9999, estimated: true })
    await mergeAsVolumes(t.db, scope, pair(one, two))
    const read = () => t.db.select().from(dailyStats).where(eq(dailyStats.userId, ann.id)).orderBy(asc(dailyStats.date), asc(dailyStats.mode))
    const after = await read()
    await rebuildDailyStats(t.db, await scopeOf(ann))
    expect(await read()).toEqual(after)
  })

  it('leaves the status of a chained finished-then-abandoned read as abandoned', async () => {
    const scope = await scopeOf(await adminUser())
    const ann = await seedUser(t.db, { username: 'ann' })
    const one = await book('Saga 1')
    const two = await book('Saga 2')
    await seedSession(t.db, { userId: ann.id, workId: one, editionId: await firstEdition(one), startedOn: '2026-01-01', outcome: 'finished', finishedOn: '2026-01-10' })
    await seedSession(t.db, { userId: ann.id, workId: two, editionId: await firstEdition(two), startedOn: '2026-01-11', outcome: 'abandoned', finishedOn: '2026-01-15' })
    await t.db.insert(userWorks).values({ userId: ann.id, workId: one, status: 'read', rating: 4 })
    await mergeAsVolumes(t.db, scope, pair(one, two))
    const sessions = await t.db.select().from(readingSessions).where(eq(readingSessions.userId, ann.id))
    expect(sessions.map((s) => s.outcome)).toEqual(['abandoned'])
    const [tracking] = await t.db.select().from(userWorks).where(eq(userWorks.userId, ann.id))
    expect(tracking).toMatchObject({ workId: one, status: 'abandoned', rating: 4 })
  })

  it('rebuilds stats for people whose reads did not fuse', async () => {
    const scope = await scopeOf(await adminUser())
    const ben = await seedUser(t.db, { username: 'ben' })
    const one = await book('Saga 1')
    const two = await book('Saga 2')
    await seedSession(t.db, { userId: ben.id, workId: one, editionId: await firstEdition(one), startedOn: '2026-03-01', outcome: 'finished', finishedOn: '2026-03-05' })
    await t.db.insert(dailyStats).values({ userId: ben.id, date: '2026-03-05', mode: 'read', minutes: 9999, words: 9999, estimated: true })
    await mergeAsVolumes(t.db, scope, pair(one, two))
    const read = () => t.db.select().from(dailyStats).where(eq(dailyStats.userId, ben.id)).orderBy(asc(dailyStats.date), asc(dailyStats.mode))
    const after = await read()
    await rebuildDailyStats(t.db, await scopeOf(ben))
    expect(await read()).toEqual(after)
  })

  it('sets the volume count only on the sets the merge touched', async () => {
    const scope = await scopeOf(await adminUser())
    const survivor = await book('Saga', {
      editions: [
        { format: 'physical', language: 'he' },
        { format: 'ebook', language: 'en', volume: 1, volumeCount: 3 },
        { format: 'ebook', language: 'en', volume: 2, volumeCount: 3 },
        { format: 'ebook', language: 'en', volume: 3, volumeCount: 3 },
      ],
    })
    const stray = await book('Saga 2')
    await mergeAsVolumes(t.db, scope, pair(survivor, stray))
    const rows = await editionsOf(survivor)
    expect(rows.filter((e) => e.format === 'ebook').map((e) => [e.volume, e.volumeCount])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
    expect(rows.filter((e) => e.format === 'physical').map((e) => [e.volume, e.volumeCount])).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it('does not report the members’ differing titles as lost', async () => {
    const scope = await scopeOf(await adminUser())
    const one = await book('Saga, Volume 1')
    const two = await book('Saga, Volume 2')
    const result = await mergeAsVolumes(t.db, scope, pair(one, two))
    expect(result.dropped.filter((line) => line.startsWith('Title “'))).toEqual([])
  })
})
