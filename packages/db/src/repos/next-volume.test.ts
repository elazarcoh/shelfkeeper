import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { EditionInput } from '@mylib/domain'
import { editions, readingProgress, readingSessions } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { addEdition, createWork } from './catalog'
import { completeSession, getCheckinState, nextVolume, startSession } from './reading-sessions'
import { loadUserScope } from './scope'

const today = '2026-10-13'
const now = new Date('2026-10-13T12:00:00Z')

describe('nextVolume', () => {
  const t = useTestDb()

  const vol = (volume: number, volumeCount: number | null, extra: Record<string, unknown> = {}) =>
    EditionInput.parse({ format: 'physical', language: 'he', volume, volumeCount, pageCount: 400, ...extra })

  async function setup(editionInputs = [vol(1, 2), vol(2, 2)]) {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const workId = await createWork(t.db, workInput({ editions: editionInputs }))
    const eds = await t.db.select({ id: editions.id, volume: editions.volume }).from(editions).where(eq(editions.workId, workId)).orderBy(asc(editions.volume))
    const sessionId = await startSession(t.db, scope, { workId, editionId: eds[0]?.id ?? null, mode: 'read', startedOn: '2026-10-01', startedPrecision: 'day' })
    const move = (editionId: string | undefined = eds[0]?.id, on?: string) =>
      nextVolume(t.db, scope, { sessionId, editionId: editionId ?? '', today, ...(on === undefined ? {} : { on }) }, { now })
    const sessionEditionId = async () => (await t.db.select().from(readingSessions).where(eq(readingSessions.id, sessionId)))[0]?.editionId
    const points = () => t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, sessionId))
    return { user, scope, admin, workId, eds, sessionId, move, sessionEditionId, points }
  }

  it('ends volume 1 with a page point and moves the session to volume 2', async () => {
    const { eds, move, sessionEditionId, points } = await setup()
    expect(await move()).toEqual({ moved: true, volume: 2 })
    expect(await sessionEditionId()).toBe(eds[1]?.id)
    expect(await points()).toMatchObject([{ editionId: eds[0]?.id, kind: 'page', value: 400, occurredOn: today }])
  })

  it('ends the volume on a picked day (#70)', async () => {
    const { eds, move, points } = await setup()
    expect(await move(undefined, '2026-10-12')).toEqual({ moved: true, volume: 2 })
    expect(await points()).toMatchObject([{ editionId: eds[0]?.id, kind: 'page', value: 400, occurredOn: '2026-10-12' }])
  })

  it('refuses a picked day in the future or before the session started (#70)', async () => {
    const { move, points } = await setup()
    await expect(move(undefined, '2026-10-14')).rejects.toMatchObject({ code: 'INVALID' })
    await expect(move(undefined, '2026-09-30')).rejects.toMatchObject({ code: 'INVALID' })
    expect(await points()).toHaveLength(0)
  })

  it('refuses a picked day before the latest update on this volume', async () => {
    const { sessionId, scope, move, points } = await setup()
    const { addProgressPoint } = await import('./progress')
    await addProgressPoint(t.db, scope, { sessionId, today, on: '2026-10-10', kind: 'page', value: 100 }, { now })
    await expect(move(undefined, '2026-10-09')).rejects.toMatchObject({ code: 'INVALID', message: 'You have an update on this volume after that day' })
    expect(await points()).toHaveLength(1)
    expect(await move(undefined, '2026-10-10')).toEqual({ moved: true, volume: 2 })
  })

  it('uses percent 100 without a page count, and seconds for an audiobook', async () => {
    const plain = await setup([vol(1, 2, { pageCount: null }), vol(2, 2)])
    await plain.move()
    expect(await plain.points()).toMatchObject([{ kind: 'percent', value: 100 }])
    const audio = await setup([
      EditionInput.parse({ format: 'audiobook', language: 'he', volume: 1, volumeCount: 2, durationSec: 3600 }),
      EditionInput.parse({ format: 'audiobook', language: 'he', volume: 2, volumeCount: 2 }),
    ])
    await audio.move()
    expect(await audio.points()).toMatchObject([{ kind: 'seconds', value: 3600 }])
  })

  it('replaces the same-day point', async () => {
    const { eds, sessionId, scope, move, points } = await setup()
    const { addProgressPoint } = await import('./progress')
    await addProgressPoint(t.db, scope, { sessionId, today, kind: 'page', value: 100 }, { now })
    await move()
    expect(await points()).toMatchObject([{ editionId: eds[0]?.id, kind: 'page', value: 400 }])
  })

  it('finishing a volume today keeps a volume 2 point of today beside it', async () => {
    const { sessionId, scope, move, points } = await setup()
    const { addProgressPoint } = await import('./progress')
    await move()
    await addProgressPoint(t.db, scope, { sessionId, today, kind: 'page', value: 10 }, { now })
    expect(await points()).toHaveLength(2)
  })

  it('refuses a double tap', async () => {
    const { move, points } = await setup()
    await move()
    await expect(move()).rejects.toMatchObject({ code: 'CONFLICT', message: "You've already moved on from this volume" })
    expect(await points()).toHaveLength(1)
  })

  it('waits when the next volume is not in the catalog, until an admin adds it', async () => {
    const { scope, admin, workId, eds, sessionId, move, sessionEditionId } = await setup([vol(1, 2)])
    expect(await move()).toEqual({ moved: false, waitingFor: 2 })
    expect(await sessionEditionId()).toBe(eds[0]?.id)
    expect((await getCheckinState(t.db, scope, today, now)).inProgress.map((s) => s.id)).not.toContain(sessionId)
    const second = await addEdition(t.db, admin, workId, vol(2, 2))
    expect((await getCheckinState(t.db, scope, today, now)).inProgress.map((s) => s.id)).toContain(sessionId)
    expect(await move()).toEqual({ moved: true, volume: 2 })
    expect(await sessionEditionId()).toBe(second)
  })

  it('refuses on the last volume and outside a set', async () => {
    const last = await setup()
    await last.move()
    await expect(last.move(last.eds[1]?.id)).rejects.toMatchObject({ code: 'INVALID', message: 'This is the last volume — finish the book instead' })
    const single = await setup([EditionInput.parse({ format: 'physical', language: 'he' })])
    await expect(single.move()).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('picks the copy in possession', async () => {
    const { admin, workId, eds, move, sessionEditionId } = await setup()
    const copy = await addEdition(t.db, admin, workId, vol(2, 2))
    // the copy in possession is the one that loses on id order, so only the in-possession ordering can pick it
    const [lower, higher] = [eds[1]?.id ?? '', copy].sort()
    await t.db.update(editions).set({ inPossession: false }).where(eq(editions.id, lower ?? ''))
    await t.db.update(editions).set({ inPossession: true }).where(eq(editions.id, higher ?? ''))
    await move()
    expect(await sessionEditionId()).toBe(higher)
  })

  it('starts without a picked edition on volume 1 of a lone set, but not beside another language', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const workId = await createWork(t.db, workInput({ editions: [vol(2, 2), vol(1, 2)] }))
    const [first] = await t.db.select({ id: editions.id }).from(editions).where(eq(editions.volume, 1))
    const id = await startSession(t.db, scope, { workId, editionId: null, mode: 'read', startedOn: '2026-10-01', startedPrecision: 'day' })
    expect((await t.db.select().from(readingSessions).where(eq(readingSessions.id, id)))[0]?.editionId).toBe(first?.id)

    const user2 = await loadUserScope(t.db, await seedUser(t.db))
    const mixed = await createWork(t.db, workInput({ editions: [vol(1, 2), vol(2, 2), EditionInput.parse({ format: 'physical', language: 'en' })] }))
    const id2 = await startSession(t.db, user2, { workId: mixed, editionId: null, mode: 'read', startedOn: '2026-10-01', startedPrecision: 'day' })
    expect((await t.db.select().from(readingSessions).where(eq(readingSessions.id, id2)))[0]?.editionId).toBeNull()
  })

  it("is NOT_FOUND for someone else's session and CONFLICT for a finished one", async () => {
    const { eds, sessionId, scope } = await setup()
    const other = await loadUserScope(t.db, await seedUser(t.db))
    await expect(nextVolume(t.db, other, { sessionId, editionId: eds[0]?.id ?? '', today }, { now })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await completeSession(t.db, scope, sessionId, { outcome: 'finished', finishedOn: today, finishedPrecision: 'day', fractionCompleted: null }, { now })
    await expect(nextVolume(t.db, scope, { sessionId, editionId: eds[0]?.id ?? '', today }, { now })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
