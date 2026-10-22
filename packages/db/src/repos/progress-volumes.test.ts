import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { EditionInput } from '@mylib/domain'
import { editions, readingProgress, readingSessions } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, deleteEdition, splitEdition, updateEdition } from './catalog'
import { addProgressPoint, listCurrentProgress, listProgressPoints, updateProgressPoint } from './progress'
import { completeSession, listSessionsForWork, startSession } from './reading-sessions'
import { loadUserScope, type UserScope } from './scope'

const today = '2026-10-13'
const now = new Date('2026-10-13T12:00:00Z')

describe('progress across volumes', () => {
  const t = useTestDb()

  const vol = (volume: number, volumeCount: number | null, pageCount: number | null) =>
    EditionInput.parse({ format: 'physical', language: 'he', volume, volumeCount, pageCount })
  const page = (scope: UserScope, sessionId: string, value: number, on = today) =>
    addProgressPoint(t.db, scope, { sessionId, today, on, kind: 'page', value }, { now })

  async function setup(editionInputs = [vol(1, 2, 400), vol(2, 2, 600)]) {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const workId = await createWork(t.db, workInput({ editions: editionInputs }))
    const eds = await t.db.select({ id: editions.id, volume: editions.volume }).from(editions).where(eq(editions.workId, workId)).orderBy(asc(editions.volume))
    const sessionId = await startSession(t.db, scope, { workId, editionId: eds[0]?.id ?? null, mode: 'read', startedOn: '2026-10-01', startedPrecision: 'day' })
    const progress = async () => (await listSessionsForWork(t.db, scope, workId))[0]?.progress
    return { scope, admin, workId, eds, sessionId, progress }
  }

  it('stores the session edition on a new point', async () => {
    const { scope, eds, sessionId } = await setup()
    await page(scope, sessionId, 100)
    const [row] = await t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, sessionId))
    expect(row?.editionId).toBe(eds[0]?.id)
  })

  it('shows the volume and the book fraction', async () => {
    const { scope, sessionId, progress } = await setup()
    await page(scope, sessionId, 200)
    const p = await progress()
    expect(p?.volume).toMatchObject({ volume: 1, size: 2, waiting: false })
    expect(p?.latest).toMatchObject({ volume: 1, fraction: 0.2 })
  })

  it('keeps earlier points on their volume after the session moves on', async () => {
    const { scope, eds, sessionId, progress } = await setup()
    await page(scope, sessionId, 400, '2026-10-05')
    await t.db.update(readingSessions).set({ editionId: eds[1]?.id ?? null }).where(eq(readingSessions.id, sessionId))
    await page(scope, sessionId, 100)
    const p = await progress()
    expect(p?.highest).toBeCloseTo(0.5, 9)
    const points = await listProgressPoints(t.db, scope, sessionId)
    const first = points.find((x) => x.value === 400)
    expect(first).toMatchObject({ volume: 1 })
    expect(first?.fraction).toBeCloseTo(0.4, 9)
    expect(points.find((x) => x.value === 100)).toMatchObject({ volume: 2 })
    expect((await listCurrentProgress(t.db, scope))[0]?.fraction).toBeCloseTo(0.5, 9)
  })

  it('is waiting at the end of a volume whose next one is not in the catalog', async () => {
    const { scope, sessionId, progress } = await setup([vol(1, 2, 400)])
    await page(scope, sessionId, 399, '2026-10-05')
    expect((await progress())?.volume?.waiting).toBe(false)
    await page(scope, sessionId, 400)
    expect((await progress())?.volume).toMatchObject({ volume: 1, size: 2, waiting: true })
  })

  it('an abandon cannot go below the book high-water mark', async () => {
    const { scope, sessionId } = await setup()
    await page(scope, sessionId, 400)
    const finish = (fractionCompleted: number) =>
      completeSession(t.db, scope, sessionId, { outcome: 'abandoned', finishedOn: today, finishedPrecision: 'day', fractionCompleted })
    await expect(finish(0.3)).rejects.toMatchObject({ code: 'INVALID' })
    await finish(0.5)
  })

  it('without an edition a percent point is the plain percent fraction', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const workId = await createWork(t.db, workInput({ editions: [vol(1, null, null), EditionInput.parse({ format: 'ebook', language: 'en' })] }))
    const sessionId = await startSession(t.db, scope, { workId, editionId: null, mode: 'read', startedOn: '2026-10-01', startedPrecision: 'day' })
    await addProgressPoint(t.db, scope, { sessionId, today, kind: 'percent', value: 40 }, { now })
    const p = (await listSessionsForWork(t.db, scope, workId))[0]?.progress
    expect(p?.volume).toBeNull()
    expect(p?.highest).toBeCloseTo(0.4, 9)
    expect(p?.latest).toMatchObject({ editionId: null, volume: null })
  })

  it('a point whose volume was deleted has no book fraction and is ignored by the high-water mark', async () => {
    const s = await setup()
    await page(s.scope, s.sessionId, 400, '2026-10-05')
    await t.db.update(readingSessions).set({ editionId: s.eds[1]?.id ?? null }).where(eq(readingSessions.id, s.sessionId))
    await page(s.scope, s.sessionId, 100, '2026-10-06')
    await deleteEdition(t.db, s.admin, s.eds[0]?.id ?? '')
    const rows = await t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, s.sessionId))
    expect(rows.find((r) => r.value === 400)?.editionId).toBeNull()
    const points = await listProgressPoints(t.db, s.scope, s.sessionId)
    expect(points.find((x) => x.value === 400)).toMatchObject({ editionId: null, volume: null, fraction: null })
    // volume 2 alone: its lengths are incomplete, so (1 + 100 / 600) / 2
    expect(points.find((x) => x.value === 100)?.fraction).toBeCloseTo((1 + 100 / 600) / 2, 9)
    expect((await s.progress())?.highest).toBeCloseTo((1 + 100 / 600) / 2, 9)
    expect((await s.progress())?.latest).toMatchObject({ value: 100, volume: 2 })
  })

  it('a point on the next volume the same day sits beside the volume 1 point; the latest is the new volume', async () => {
    const { scope, eds, sessionId, progress } = await setup()
    await page(scope, sessionId, 400) // finished volume 1 today
    await t.db.update(readingSessions).set({ editionId: eds[1]?.id ?? null }).where(eq(readingSessions.id, sessionId))
    await page(scope, sessionId, 10)
    const rows = await t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, sessionId))
    expect(rows).toHaveLength(2)
    const points = await listProgressPoints(t.db, scope, sessionId)
    expect(points[0]).toMatchObject({ value: 10, volume: 2 })
    expect(points[1]).toMatchObject({ value: 400, volume: 1 })
    const p = await progress()
    expect(p?.latest).toMatchObject({ value: 10, volume: 2 })
    // volume 2 alone: (400 + 10) / 1000, never below volume 1's end (0.4)
    expect(p?.highest).toBeCloseTo(0.41, 9)
    expect((await listCurrentProgress(t.db, scope))[0]?.fraction).toBeCloseTo(0.41, 9)
  })

  it('a volume 2 point moved onto the day of volume 1 end is still the latest', async () => {
    const { scope, eds, sessionId, progress } = await setup()
    await t.db.update(readingSessions).set({ editionId: eds[1]?.id ?? null }).where(eq(readingSessions.id, sessionId))
    const second = await page(scope, sessionId, 100, '2026-10-06')
    await addProgressPoint(t.db, scope, { sessionId, today, on: '2026-10-05', kind: 'page', value: 400, editionId: eds[0]?.id }, { now })
    await updateProgressPoint(t.db, scope, { pointId: second, today, on: '2026-10-05', kind: 'page', value: 100 }, { now })
    expect((await progress())?.latest).toMatchObject({ value: 100, volume: 2 })
    const points = await listProgressPoints(t.db, scope, sessionId)
    expect(points[0]).toMatchObject({ value: 100, volume: 2 })
    expect((await listCurrentProgress(t.db, scope))[0]?.fraction).toBeCloseTo(0.5, 9)
  })

  it('deleting the volumes of a day keeps one point without a volume', async () => {
    const { scope, admin, eds, sessionId } = await setup([vol(1, 3, 400), vol(2, 3, 600), vol(3, 3, 500)])
    await addProgressPoint(t.db, scope, { sessionId, today, kind: 'page', value: 400 }, { now })
    await addProgressPoint(t.db, scope, { sessionId, today, kind: 'page', value: 100, editionId: eds[1]?.id }, { now })
    await deleteEdition(t.db, admin, eds[0]?.id ?? '')
    await deleteEdition(t.db, admin, eds[1]?.id ?? '')
    const rows = await t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, sessionId))
    expect(rows).toMatchObject([{ editionId: null, occurredOn: today }])
  })

  it('saving the new volume again the same day replaces only its own point', async () => {
    const { scope, eds, sessionId } = await setup()
    await page(scope, sessionId, 400)
    await t.db.update(readingSessions).set({ editionId: eds[1]?.id ?? null }).where(eq(readingSessions.id, sessionId))
    await page(scope, sessionId, 10)
    await page(scope, sessionId, 150)
    const rows = await t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, sessionId)).orderBy(asc(readingProgress.value))
    expect(rows).toMatchObject([
      { editionId: eds[1]?.id, value: 150 },
      { editionId: eds[0]?.id, value: 400 },
    ])
  })

  it('a point without a volume still clashes with another one the same day', async () => {
    const { scope, sessionId } = await setup()
    const percent = (value: number) => addProgressPoint(t.db, scope, { sessionId, today, kind: 'percent', value }, { now })
    await t.db.update(readingSessions).set({ editionId: null }).where(eq(readingSessions.id, sessionId))
    await percent(10)
    await percent(20)
    const rows = await t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, sessionId))
    expect(rows).toMatchObject([{ editionId: null, value: 20 }])
  })

  it("moving a point onto a day with another volume's point is allowed, onto its own volume's is not", async () => {
    const { scope, eds, sessionId } = await setup()
    await page(scope, sessionId, 400, '2026-10-05')
    await t.db.update(readingSessions).set({ editionId: eds[1]?.id ?? null }).where(eq(readingSessions.id, sessionId))
    const second = await page(scope, sessionId, 100, '2026-10-06')
    const move = (pointId: string, on: string, value: number) => updateProgressPoint(t.db, scope, { pointId, today, on, kind: 'page', value }, { now })
    await move(second, '2026-10-05', 100)
    expect(await t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, sessionId))).toHaveLength(2)
    const third = await page(scope, sessionId, 50, '2026-10-07')
    await expect(move(third, '2026-10-05', 50)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('is not waiting once the session is on the next volume', async () => {
    const { scope, eds, sessionId, progress } = await setup()
    await page(scope, sessionId, 400)
    expect((await progress())?.volume?.waiting).toBe(false)
    await t.db.update(readingSessions).set({ editionId: eds[1]?.id ?? null }).where(eq(readingSessions.id, sessionId))
    expect((await progress())?.volume).toMatchObject({ volume: 2, waiting: false })
  })

  it('an old point is checked against the length of its own volume', async () => {
    const { scope, eds, sessionId } = await setup()
    const pointId = await page(scope, sessionId, 400, '2026-10-05')
    await t.db.update(readingSessions).set({ editionId: eds[1]?.id ?? null }).where(eq(readingSessions.id, sessionId))
    const edit = (value: number) => updateProgressPoint(t.db, scope, { pointId, today, on: '2026-10-05', kind: 'page', value }, { now })
    await expect(edit(401)).rejects.toMatchObject({ code: 'INVALID' })
    await edit(399)
  })

  async function pointOnVolume1ThenMoveOn() {
    const s = await setup()
    await page(s.scope, s.sessionId, 400, '2026-10-05')
    await t.db.update(readingSessions).set({ editionId: s.eds[1]?.id ?? null }).where(eq(readingSessions.id, s.sessionId))
    await page(s.scope, s.sessionId, 100, '2026-10-06')
    return s
  }

  it('a point whose edition was split out of the set has no book fraction', async () => {
    const s = await pointOnVolume1ThenMoveOn()
    await splitEdition(t.db, s.admin, s.eds[0]?.id ?? '')
    const points = await listProgressPoints(t.db, s.scope, s.sessionId)
    expect(points.find((x) => x.value === 400)).toMatchObject({ volume: null, fraction: null })
    expect((await s.progress())?.highest).toBeCloseTo((1 + 100 / 600) / 2, 9)
  })

  it('a point whose edition changed language leaves the set the same way', async () => {
    const s = await pointOnVolume1ThenMoveOn()
    await updateEdition(t.db, s.admin, s.eds[0]?.id ?? '', { language: 'en' })
    const points = await listProgressPoints(t.db, s.scope, s.sessionId)
    expect(points.find((x) => x.value === 400)).toMatchObject({ volume: null, fraction: null })
    expect((await s.progress())?.highest).toBeCloseTo((1 + 100 / 600) / 2, 9)
  })

  describe('choosing the volume of a point (#69)', () => {
    const addOn = (scope: UserScope, sessionId: string, editionId: string | undefined, value: number, on = today) =>
      addProgressPoint(t.db, scope, { sessionId, today, on, kind: 'page', value, editionId }, { now })

    async function onVolume2() {
      const s = await setup()
      await t.db.update(readingSessions).set({ editionId: s.eds[1]?.id ?? null }).where(eq(readingSessions.id, s.sessionId))
      return s
    }

    it('stores a point on the chosen volume of the set and computes its fraction from it', async () => {
      const s = await onVolume2()
      await addOn(s.scope, s.sessionId, s.eds[0]?.id, 100, '2026-10-12')
      const [row] = await t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, s.sessionId))
      expect(row?.editionId).toBe(s.eds[0]?.id)
      const [view] = await listProgressPoints(t.db, s.scope, s.sessionId)
      expect(view).toMatchObject({ volume: 1 })
      expect(view?.fraction).toBeCloseTo(0.1, 9)
    })

    it('checks the value against the chosen volume, not the session one', async () => {
      const s = await onVolume2()
      await expect(addOn(s.scope, s.sessionId, s.eds[0]?.id, 500)).rejects.toMatchObject({ code: 'INVALID' })
      await addOn(s.scope, s.sessionId, s.eds[1]?.id, 500)
    })

    it('saves a missing length on the chosen volume', async () => {
      const s = await setup([vol(1, 2, null), vol(2, 2, 600)])
      await t.db.update(readingSessions).set({ editionId: s.eds[1]?.id ?? null }).where(eq(readingSessions.id, s.sessionId))
      await addProgressPoint(t.db, s.scope, { sessionId: s.sessionId, today, kind: 'page', value: 50, editionLength: 300, editionId: s.eds[0]?.id }, { now })
      const rows = await t.db.select({ id: editions.id, pageCount: editions.pageCount }).from(editions).where(eq(editions.workId, s.workId))
      expect(rows.find((r) => r.id === s.eds[0]?.id)?.pageCount).toBe(300)
      expect(rows.find((r) => r.id === s.eds[1]?.id)?.pageCount).toBe(600)
    })

    it('refuses an edition of another book, or of another format, as a volume of this one', async () => {
      const s = await onVolume2()
      const other = await createWork(t.db, workInput({ editions: [vol(1, 2, 400)] }))
      const [foreign] = await t.db.select({ id: editions.id }).from(editions).where(eq(editions.workId, other))
      await expect(addOn(s.scope, s.sessionId, foreign?.id, 10)).rejects.toMatchObject({ code: 'INVALID', message: 'Pick a volume of this book' })
      const [ebook] = await t.db
        .insert(editions)
        .values({ workId: s.workId, format: 'ebook', language: 'he', volume: 3, pageCount: 100 })
        .returning({ id: editions.id })
      await expect(addOn(s.scope, s.sessionId, ebook?.id, 10)).rejects.toMatchObject({ code: 'INVALID' })
    })

    it('moves a point to another volume of the set', async () => {
      const s = await onVolume2()
      const pointId = await addOn(s.scope, s.sessionId, undefined, 100, '2026-10-05')
      await updateProgressPoint(t.db, s.scope, { pointId, today, on: '2026-10-05', kind: 'page', value: 100, editionId: s.eds[0]?.id }, { now })
      const [row] = await t.db.select().from(readingProgress).where(eq(readingProgress.id, pointId))
      expect(row?.editionId).toBe(s.eds[0]?.id)
      await expect(
        updateProgressPoint(t.db, s.scope, { pointId, today, on: '2026-10-05', kind: 'page', value: 100, editionId: randomUUID() }, { now }),
      ).rejects.toMatchObject({ code: 'INVALID' })
    })

    it('refuses to move a point onto a day where the chosen volume already has one', async () => {
      const s = await onVolume2()
      await addOn(s.scope, s.sessionId, s.eds[0]?.id, 300, '2026-10-05')
      const pointId = await addOn(s.scope, s.sessionId, undefined, 100, '2026-10-05')
      await expect(
        updateProgressPoint(t.db, s.scope, { pointId, today, on: '2026-10-05', kind: 'page', value: 100, editionId: s.eds[0]?.id }, { now }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('keeps the point on its own volume when no edition is given', async () => {
      const s = await onVolume2()
      const pointId = await addOn(s.scope, s.sessionId, s.eds[0]?.id, 100, '2026-10-05')
      await updateProgressPoint(t.db, s.scope, { pointId, today, on: '2026-10-06', kind: 'page', value: 120 }, { now })
      const [row] = await t.db.select().from(readingProgress).where(eq(readingProgress.id, pointId))
      expect(row?.editionId).toBe(s.eds[0]?.id)
    })
  })
})
