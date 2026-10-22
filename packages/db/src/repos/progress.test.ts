import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { AddProgressInput, UpdateProgressInput } from '@mylib/domain'
import { dailyStats, editions, readingProgress, readingSessions, userHiddenWorks } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail } from './catalog'
import { addProgressPoint, listCurrentProgress, listProgressPoints, removeProgressPoint, updateProgressPoint } from './progress'
import { completeSession, deleteReadingSession, listInProgressSessions, startSession } from './reading-sessions'
import { loadUserScope, type UserScope } from './scope'
import { getDailyStats } from './stats'

const MISSING = '71111111-1111-4111-8111-000000000099'

/** The server's clock pinned to midday UTC of the client's "today", so the ±2-day client-date check passes. */
const serverAt = (day: string) => ({ now: new Date(`${day}T12:00:00Z`) })

describe('progress repository', () => {
  const t = useTestDb()

  const add = (scope: UserScope, input: AddProgressInput) => addProgressPoint(t.db, scope, input, serverAt(input.today))
  const update = (scope: UserScope, input: UpdateProgressInput) => updateProgressPoint(t.db, scope, input, serverAt(input.today))

  async function reading(
    edition: { format: 'physical' | 'ebook' | 'audiobook'; pageCount?: number; durationSec?: number; wordCount?: number },
    startedOn = '2026-03-01',
  ) {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const workId = await createWork(t.db, workInput({ title: 'P', series: [], editions: [edition] }))
    const [e] = await t.db.select({ id: editions.id }).from(editions).where(eq(editions.workId, workId))
    const mode = edition.format === 'audiobook' ? 'listen' : 'read'
    const sessionId = await startSession(t.db, scope, { workId, editionId: e?.id ?? null, mode, startedOn, startedPrecision: 'day' })
    return { user, scope, workId, editionId: e?.id ?? '', sessionId }
  }
  const storedDays = async (userId: string) => (await t.db.select().from(dailyStats).where(eq(dailyStats.userId, userId))).map((r) => r.date).sort()
  const totalWords = async (scope: UserScope) => (await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })).reduce((n, d) => n + d.words, 0)

  it('adds a page point (today by default), lists it with its fraction, and stats count it', async () => {
    const { scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 120 })
    const points = await listProgressPoints(t.db, scope, sessionId)
    expect(points).toHaveLength(1)
    expect(typeof points[0]?.id).toBe('string')
    expect(points[0]).toEqual({ id: points[0]?.id, sessionId, on: '2026-03-04', kind: 'page', value: 120, editionId: points[0]?.editionId, volume: null, fraction: 0.4 })
    const days = await getDailyStats(t.db, scope, { from: '2026-03-01', to: '2026-03-31' })
    expect(days.reduce((n, d) => n + d.words, 0)).toBeCloseTo(33_000, 6)
  })

  it('same day keeps the last entry', async () => {
    const { scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    const first = await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 100 })
    const second = await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 150 })
    expect(second).toBe(first)
    expect((await listProgressPoints(t.db, scope, sessionId)).map((p) => p.value)).toEqual([150])
  })

  it('two concurrent adds for the same session and day end with exactly one row and matching stats', async () => {
    const { user, scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    const ids = await Promise.all([
      add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 60 }),
      add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 150 }),
    ])
    expect(ids[0]).toBe(ids[1])
    const rows = await t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, sessionId))
    expect(rows).toHaveLength(1)
    const kept = rows[0]?.value ?? 0
    expect([60, 150]).toContain(kept)
    // the stored stats (from the writes' own range rebuilds) match the surviving row
    const stored = (await t.db.select().from(dailyStats).where(eq(dailyStats.userId, user.id))).reduce((n, d) => n + d.words, 0)
    expect(stored).toBeCloseTo(82_500 * (kept / 300), 6)
  })

  it('refuses future dates, dates before the start and kinds that do not fit the edition', async () => {
    const { scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    await expect(add(scope, { sessionId, today: '2026-03-04', on: '2026-03-05', kind: 'page', value: 1 })).rejects.toMatchObject({ code: 'INVALID' })
    await expect(add(scope, { sessionId, today: '2026-03-04', on: '2026-02-28', kind: 'page', value: 1 })).rejects.toMatchObject({ code: 'INVALID' })
    await expect(add(scope, { sessionId, today: '2026-03-04', kind: 'percent', value: 10 })).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('refuses a page or time past the end of a known length, on add and update; the last page is fine', async () => {
    const { scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    const pastEnd = add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 1200 })
    await expect(pastEnd).rejects.toMatchObject({ code: 'INVALID' })
    await expect(pastEnd).rejects.toThrow('This edition has 300 pages. If yours has more, update the page count on the book page.')
    const pointId = await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 300 })
    await expect(update(scope, { pointId, today: '2026-03-04', on: '2026-03-04', kind: 'page', value: 301 })).rejects.toMatchObject({ code: 'INVALID' })
    expect(await listProgressPoints(t.db, scope, sessionId)).toMatchObject([{ value: 300 }])

    const audio = await reading({ format: 'audiobook', durationSec: 3_600 })
    await expect(add(audio.scope, { sessionId: audio.sessionId, today: '2026-03-04', kind: 'seconds', value: 3_601 })).rejects.toThrow(/1:00:00 long/)
    await add(audio.scope, { sessionId: audio.sessionId, today: '2026-03-04', kind: 'seconds', value: 3_600 })
  })

  it('checks a point against the one-time length answer, and a refused point saves no length', async () => {
    const { scope, sessionId, workId } = await reading({ format: 'physical' })
    await expect(add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 1200, editionLength: 300 })).rejects.toMatchObject({ code: 'INVALID' })
    expect((await getWorkDetail(t.db, scope, workId)).editions[0]?.pageCount).toBeNull()
    // with the length still unknown, nothing changes: any page is accepted
    await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 1200 })
    expect(await listProgressPoints(t.db, scope, sessionId)).toMatchObject([{ value: 1200, fraction: null }])
  })

  it("refuses a client 'today' more than two days from the server's UTC date, on add and update", async () => {
    const { scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    const server = serverAt('2026-03-10')
    const wrongClock = addProgressPoint(t.db, scope, { sessionId, today: '2026-03-13', on: '2026-03-04', kind: 'page', value: 1 }, server)
    await expect(wrongClock).rejects.toMatchObject({ code: 'INVALID' })
    await expect(wrongClock).rejects.toThrow(/device's date/)
    const pointId = await addProgressPoint(t.db, scope, { sessionId, today: '2026-03-12', kind: 'page', value: 10 }, server)
    await expect(updateProgressPoint(t.db, scope, { pointId, today: '2026-03-07', on: '2026-03-04', kind: 'page', value: 20 }, server)).rejects.toMatchObject({
      code: 'INVALID',
    })
    await updateProgressPoint(t.db, scope, { pointId, today: '2026-03-08', on: '2026-03-04', kind: 'page', value: 20 }, server)
    expect(await listProgressPoints(t.db, scope, sessionId)).toMatchObject([{ on: '2026-03-04', value: 20 }])
  })

  it('the one-time length answer becomes a locked manual pageCount, and never overwrites a known one', async () => {
    const { scope, sessionId, workId } = await reading({ format: 'physical' })
    await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 120, editionLength: 300 })
    const edition = (await getWorkDetail(t.db, scope, workId)).editions[0]
    expect(edition?.pageCount).toBe(300)
    expect(edition?.provenance['pageCount']).toMatchObject({ origin: 'manual', locked: true })
    await add(scope, { sessionId, today: '2026-03-05', kind: 'page', value: 130, editionLength: 999 })
    expect((await getWorkDetail(t.db, scope, workId)).editions[0]?.pageCount).toBe(300)
  })

  it('an audiobook seconds point saves the one-time duration once, never overwriting it, and stats count its minutes', async () => {
    const { scope, sessionId, workId } = await reading({ format: 'audiobook' })
    await add(scope, { sessionId, today: '2026-03-04', kind: 'seconds', value: 3_600, editionLength: 36_000 })
    const edition = (await getWorkDetail(t.db, scope, workId)).editions[0]
    expect(edition?.durationSec).toBe(36_000)
    expect(edition?.provenance['durationSec']).toMatchObject({ origin: 'manual', locked: true })
    expect((await listProgressPoints(t.db, scope, sessionId))[0]?.fraction).toBeCloseTo(0.1, 9)
    await add(scope, { sessionId, today: '2026-03-05', kind: 'seconds', value: 7_200, editionLength: 99_999 })
    expect((await getWorkDetail(t.db, scope, workId)).editions[0]?.durationSec).toBe(36_000)
    const minutes = (await getDailyStats(t.db, scope, { from: '2026-03-01', to: '2026-03-31' })).reduce((n, d) => n + d.minutes, 0)
    expect(minutes).toBeCloseTo(120, 6) // 7,200 s of a 36,000 s book: 0.2 × 600 minutes
  })

  it('an editionless session takes percent points only, with a fraction', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    // two printed editions and none picked: the session has no edition
    const workId = await createWork(t.db, workInput({ title: 'Two', series: [], editions: [{ format: 'physical' }, { format: 'physical' }] }))
    const sessionId = await startSession(t.db, scope, { workId, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })
    await expect(add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 10 })).rejects.toMatchObject({ code: 'INVALID' })
    await add(scope, { sessionId, today: '2026-03-04', kind: 'percent', value: 25 })
    expect(await listProgressPoints(t.db, scope, sessionId)).toMatchObject([{ kind: 'percent', value: 25, fraction: 0.25 }])
    expect(await listCurrentProgress(t.db, scope)).toEqual([{ workId, sessionId, on: '2026-03-04', fraction: 0.25 }])
  })

  it('skipping the length saves the point without a fraction, and stats ignore it', async () => {
    const { scope, sessionId } = await reading({ format: 'physical' })
    await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 120 })
    expect((await listProgressPoints(t.db, scope, sessionId))[0]?.fraction).toBeNull()
    expect(await getDailyStats(t.db, scope, { from: '2026-03-01', to: '2026-03-31' })).toEqual([])
  })

  it("never touches another person's session, nor a hidden one", async () => {
    const { user, scope, sessionId, workId } = await reading({ format: 'physical' })
    const pointId = await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 120 })
    const other = await loadUserScope(t.db, await seedUser(t.db))
    await expect(add(other, { sessionId, today: '2026-03-04', kind: 'page', value: 1, editionLength: 50 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // a refused writer's length answer is not saved either
    expect((await getWorkDetail(t.db, scope, workId)).editions[0]?.pageCount).toBeNull()
    await expect(update(other, { pointId, today: '2026-03-04', on: '2026-03-04', kind: 'page', value: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(removeProgressPoint(t.db, other, pointId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(listProgressPoints(t.db, other, sessionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(removeProgressPoint(t.db, scope, MISSING)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId })
    const hidden = await loadUserScope(t.db, user)
    await expect(listProgressPoints(t.db, hidden, sessionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(add(hidden, { sessionId, today: '2026-03-05', kind: 'page', value: 130 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(update(hidden, { pointId, today: '2026-03-05', on: '2026-03-04', kind: 'page', value: 130 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(removeProgressPoint(t.db, hidden, pointId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await listCurrentProgress(t.db, hidden)).toEqual([])
  })

  it('points only on in-progress sessions; a finished one keeps its points, which stay correctable within its dates', async () => {
    const { scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    const pointId = await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 120 })
    await completeSession(t.db, scope, sessionId, { outcome: 'finished', finishedOn: '2026-03-06', finishedPrecision: 'day', fractionCompleted: null })
    const over = add(scope, { sessionId, today: '2026-03-07', kind: 'page', value: 200 })
    await expect(over).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(over).rejects.toThrow('This read has already ended — refresh to see the latest.')
    // past the end of the read: neutral words that fit an abandoned read as well
    await expect(update(scope, { pointId, today: '2026-03-08', on: '2026-03-07', kind: 'page', value: 150 })).rejects.toThrow('That date is after this read ended')
    await update(scope, { pointId, today: '2026-03-07', on: '2026-03-05', kind: 'page', value: 150 })
    expect(await listProgressPoints(t.db, scope, sessionId)).toMatchObject([{ on: '2026-03-05', value: 150, fraction: 0.5 }])
    await expect(update(scope, { pointId, today: '2026-03-08', on: '2026-03-07', kind: 'page', value: 150 })).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('moving a point onto a day that already has one is a conflict', async () => {
    const { scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    await add(scope, { sessionId, today: '2026-03-04', on: '2026-03-03', kind: 'page', value: 50 })
    const later = await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 80 })
    await expect(update(scope, { pointId: later, today: '2026-03-04', on: '2026-03-03', kind: 'page', value: 80 })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('an update keeping its kind is not re-checked against the edition (which may be gone); a changed kind is', async () => {
    const { scope, sessionId, editionId } = await reading({ format: 'physical', pageCount: 300 })
    const pointId = await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 120 })
    await t.db.delete(editions).where(eq(editions.id, editionId)) // the session's editionId becomes null
    await update(scope, { pointId, today: '2026-03-04', on: '2026-03-04', kind: 'page', value: 130 })
    expect(await listProgressPoints(t.db, scope, sessionId)).toMatchObject([{ kind: 'page', value: 130, fraction: null }])
    await expect(update(scope, { pointId, today: '2026-03-04', on: '2026-03-04', kind: 'seconds', value: 10 })).rejects.toMatchObject({ code: 'INVALID' })
    await update(scope, { pointId, today: '2026-03-04', on: '2026-03-04', kind: 'percent', value: 40 })
    expect(await listProgressPoints(t.db, scope, sessionId)).toMatchObject([{ kind: 'percent', value: 40, fraction: 0.4 }])
  })

  it('removing the latest point clears the days it covered (Review Focus 1)', async () => {
    const { user, scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    await add(scope, { sessionId, today: '2026-03-06', on: '2026-03-02', kind: 'page', value: 60 })
    const late = await add(scope, { sessionId, today: '2026-03-06', kind: 'page', value: 180 })
    expect((await storedDays(user.id)).at(-1)).toBe('2026-03-06')
    await removeProgressPoint(t.db, scope, late)
    expect(await storedDays(user.id)).toEqual(['2026-03-01', '2026-03-02'])
  })

  it('back-dating the latest point clears the days it no longer covers', async () => {
    const { user, scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    const pointId = await add(scope, { sessionId, today: '2026-03-06', kind: 'page', value: 180 })
    expect((await storedDays(user.id)).at(-1)).toBe('2026-03-06')
    await update(scope, { pointId, today: '2026-03-06', on: '2026-03-03', kind: 'page', value: 180 })
    expect(await storedDays(user.id)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03'])
  })

  it('replacing the latest point with one that has no fraction clears the days it covered', async () => {
    const { user, scope, sessionId } = await reading({ format: 'ebook', wordCount: 100_000 })
    await add(scope, { sessionId, today: '2026-03-04', on: '2026-03-02', kind: 'percent', value: 10 })
    await add(scope, { sessionId, today: '2026-03-04', kind: 'percent', value: 40 })
    expect((await storedDays(user.id)).at(-1)).toBe('2026-03-04')
    // same day, now a page of an ebook with no page count: no fraction, so the session counts only to 03-02
    await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 120 })
    expect(await storedDays(user.id)).toEqual(['2026-03-01', '2026-03-02'])
  })

  it('giving the only point of a finished read with an imprecise start a fraction clears the rest of the start range (Minor 3)', async () => {
    // started "March 2026": a read without a usable point spreads over the whole start range, through Mar 31
    const { user, scope, sessionId } = await reading({ format: 'ebook', wordCount: 100_000 })
    await t.db.update(readingSessions).set({ startedPrecision: 'month' }).where(eq(readingSessions.id, sessionId))
    const pointId = await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 120 })
    await completeSession(t.db, scope, sessionId, { outcome: 'finished', finishedOn: '2026-03-10', finishedPrecision: 'day', fractionCompleted: null })
    expect((await storedDays(user.id)).at(-1)).toBe('2026-03-31')
    // now a percentage: the read counts from its checkpoints, Mar 1 through its finish on Mar 10, and no later day keeps a row
    await update(scope, { pointId, today: '2026-03-12', on: '2026-03-04', kind: 'percent', value: 40 })
    expect((await storedDays(user.id)).at(-1)).toBe('2026-03-10')
  })

  it('deleting the session removes its points and clears the days they covered', async () => {
    const { user, scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 120 })
    expect(await storedDays(user.id)).not.toEqual([])
    await deleteReadingSession(t.db, scope, sessionId)
    expect(await t.db.select().from(readingProgress).where(eq(readingProgress.sessionId, sessionId))).toEqual([])
    expect(await totalWords(scope)).toBe(0)
    expect(await storedDays(user.id)).toEqual([])
  })

  it('completeSession refuses a finish before the latest progress update (Review Focus 2)', async () => {
    const { scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    await add(scope, { sessionId, today: '2026-03-06', kind: 'page', value: 180 })
    await expect(
      completeSession(t.db, scope, sessionId, { outcome: 'finished', finishedOn: '2026-03-05', finishedPrecision: 'day', fractionCompleted: null }),
    ).rejects.toMatchObject({ code: 'INVALID', message: 'The finish date is before your latest progress update' })
    await completeSession(t.db, scope, sessionId, { outcome: 'finished', finishedOn: '2026-03-06', finishedPrecision: 'day', fractionCompleted: null })
  })

  const abandonAt = (fractionCompleted: number | null) =>
    ({ outcome: 'abandoned', finishedOn: '2026-03-06', finishedPrecision: 'day', fractionCompleted }) as const
  const storedFraction = async (sessionId: string) =>
    (await t.db.select({ f: readingSessions.fractionCompleted }).from(readingSessions).where(eq(readingSessions.id, sessionId)))[0]?.f

  it('#7: an abandon below the highest point is refused, so the session and the stats agree', async () => {
    const { scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    await add(scope, { sessionId, today: '2026-03-04', on: '2026-03-03', kind: 'page', value: 180 }) // 60%
    await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 90 }) // a lower point: 30%
    await expect(completeSession(t.db, scope, sessionId, abandonAt(0.25))).rejects.toMatchObject({
      code: 'INVALID',
      message: 'You already got to 60% of this book. Pick at least that, or first edit that progress update on the book page.',
    })
    expect(await storedFraction(sessionId)).toBeNull()
    // at the high-water mark itself, as the client computes it (180 / 300)
    await completeSession(t.db, scope, sessionId, abandonAt(180 / 300))
    expect(await storedFraction(sessionId)).toBeCloseTo(0.6, 9)
    expect(await totalWords(scope)).toBeCloseTo(0.6 * 300 * 275, 6)
  })

  it('#7: "Not sure" is half the book, or the highest point when that is higher', async () => {
    const low = await reading({ format: 'physical', pageCount: 300 })
    await add(low.scope, { sessionId: low.sessionId, today: '2026-03-04', kind: 'page', value: 60 })
    await completeSession(t.db, low.scope, low.sessionId, abandonAt(null))
    expect(await storedFraction(low.sessionId)).toBe(0.5)
    const high = await reading({ format: 'physical', pageCount: 300 })
    await add(high.scope, { sessionId: high.sessionId, today: '2026-03-04', kind: 'page', value: 240 })
    await completeSession(t.db, high.scope, high.sessionId, abandonAt(null))
    expect(await storedFraction(high.sessionId)).toBeCloseTo(0.8, 9)
  })

  it('#7: a point of a set-aside read cannot be corrected past where it was set aside; lower is fine', async () => {
    const { scope, sessionId } = await reading({ format: 'physical', pageCount: 300 })
    const pointId = await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 90 })
    await completeSession(t.db, scope, sessionId, abandonAt(0.5))
    const edit = { pointId, today: '2026-03-06', on: '2026-03-04', kind: 'page' } as const
    await expect(update(scope, { ...edit, value: 180 })).rejects.toMatchObject({
      code: 'INVALID',
      message: "You set this book aside at 50%, so an update can't be past that.",
    })
    await update(scope, { ...edit, value: 150 })
    await update(scope, { ...edit, value: 30 })
    expect((await listProgressPoints(t.db, scope, sessionId)).map((p) => p.value)).toEqual([30])
  })

  it('#8: a point without a fraction (no length) sets no floor and gives the abandon no fraction', async () => {
    const { scope, sessionId } = await reading({ format: 'physical' })
    await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 250 })
    const [session] = await listInProgressSessions(t.db, scope, '2026-03-04')
    expect(session?.progress.highest).toBeNull()
    await completeSession(t.db, scope, sessionId, abandonAt(0.25))
    expect(await storedFraction(sessionId)).toBe(0.25)
  })

  it('in-progress sessions carry their latest point and count; current progress is one fraction per work', async () => {
    const { scope, sessionId, workId } = await reading({ format: 'physical', pageCount: 300 })
    await add(scope, { sessionId, today: '2026-03-04', on: '2026-03-02', kind: 'page', value: 30 })
    await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 150 })
    const [session] = await listInProgressSessions(t.db, scope, '2026-03-04')
    expect(session?.progress).toMatchObject({ editionFormat: 'physical', pageCount: 300, pointCount: 2, highest: 0.5, latest: { on: '2026-03-04', value: 150, fraction: 0.5 } })
    expect(await listCurrentProgress(t.db, scope)).toEqual([{ workId, sessionId, on: '2026-03-04', fraction: 0.5 }])
  })

  it('current progress uses the newest point that has a fraction, skipping newer ones without', async () => {
    const { scope, sessionId, workId } = await reading({ format: 'ebook' })
    await add(scope, { sessionId, today: '2026-03-04', on: '2026-03-02', kind: 'percent', value: 40 })
    await add(scope, { sessionId, today: '2026-03-04', kind: 'page', value: 120 }) // no page count: no fraction
    expect(await listCurrentProgress(t.db, scope)).toEqual([{ workId, sessionId, on: '2026-03-02', fraction: 0.4 }])
  })

  it('current progress of a work read and listened to at once is its newest usable point across both sessions', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const workId = await createWork(
      t.db,
      workInput({ title: 'Both', series: [], editions: [{ format: 'ebook', pageCount: 300 }, { format: 'audiobook', durationSec: 36_000 }] }),
    )
    const readId = await startSession(t.db, scope, { workId, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })
    const listenId = await startSession(t.db, scope, { workId, editionId: null, mode: 'listen', startedOn: '2026-03-01', startedPrecision: 'day' })
    await add(scope, { sessionId: readId, today: '2026-03-04', on: '2026-03-02', kind: 'page', value: 30 })
    await add(scope, { sessionId: listenId, today: '2026-03-04', on: '2026-03-03', kind: 'seconds', value: 18_000 })
    expect(await listCurrentProgress(t.db, scope)).toEqual([{ workId, sessionId: listenId, on: '2026-03-03', fraction: 0.5 }])
    await add(scope, { sessionId: readId, today: '2026-03-04', kind: 'page', value: 60 })
    expect(await listCurrentProgress(t.db, scope)).toEqual([{ workId, sessionId: readId, on: '2026-03-04', fraction: 0.2 }])
  })

  it('a session without points carries empty progress info', async () => {
    const { scope } = await reading({ format: 'physical', pageCount: 300 })
    const [session] = await listInProgressSessions(t.db, scope, '2026-03-04')
    expect(session?.progress).toEqual({ editionFormat: 'physical', pageCount: 300, durationSec: null, latest: null, pointCount: 0, highest: null, volume: null })
  })
})
