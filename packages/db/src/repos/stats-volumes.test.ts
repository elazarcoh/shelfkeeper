import { and, asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { EditionInput } from '@mylib/domain'
import { editions, readingSessions } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, splitEdition } from './catalog'
import { addProgressPoint } from './progress'
import { completeSession, startSession } from './reading-sessions'
import { loadUserScope, type UserScope } from './scope'
import { getDailyStats, getStatsSummary } from './stats'

const today = '2026-10-13'
const now = new Date('2026-10-13T12:00:00Z')
const range = { from: '2026-01-01', to: '2026-12-31' }

describe('stats across volumes', () => {
  const t = useTestDb()

  const vol = (volume: number, pageCount: number, wordCount: number) =>
    EditionInput.parse({ format: 'physical', language: 'he', volume, volumeCount: 2, pageCount, wordCount })
  const page = (scope: UserScope, sessionId: string, value: number, on: string) =>
    addProgressPoint(t.db, scope, { sessionId, today, on, kind: 'page', value }, { now })
  const finish = (scope: UserScope, sessionId: string, finishedOn: string) =>
    completeSession(t.db, scope, sessionId, { outcome: 'finished', finishedOn, finishedPrecision: 'day', fractionCompleted: 1 }, { now })

  async function setup() {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const workId = await createWork(t.db, workInput({ editions: [vol(1, 400, 100_000), vol(2, 600, 150_000)] }))
    const eds = await t.db.select({ id: editions.id }).from(editions).where(eq(editions.workId, workId)).orderBy(asc(editions.volume))
    const sessionId = await startSession(t.db, scope, { workId, editionId: eds[0]?.id ?? null, mode: 'read', startedOn: '2026-10-01', startedPrecision: 'day' })
    const moveToVolume2 = () => t.db.update(readingSessions).set({ editionId: eds[1]?.id ?? null }).where(eq(readingSessions.id, sessionId))
    return { scope, workId, eds, sessionId, moveToVolume2 }
  }

  it('counts a finished two-volume read once, with both volumes words', async () => {
    const { scope, sessionId, moveToVolume2 } = await setup()
    await page(scope, sessionId, 200, '2026-10-02')
    await page(scope, sessionId, 400, '2026-10-04')
    await moveToVolume2()
    await page(scope, sessionId, 300, '2026-10-06')
    await finish(scope, sessionId, '2026-10-08')

    const summary = await getStatsSummary(t.db, scope, range)
    expect(summary.booksFinished).toBe(1)
    expect(summary.totalWords).toBe(250_000)
    const days = await getDailyStats(t.db, scope, range)
    for (const d of days) {
      expect(d.words).toBeGreaterThanOrEqual(0)
      expect(d.words).toBeLessThanOrEqual(250_000)
    }
  })

  it('a same-day point on the next volume counts progress up to the new point, never past the whole book', async () => {
    const { scope, sessionId, moveToVolume2 } = await setup()
    await page(scope, sessionId, 200, '2026-10-02')
    await page(scope, sessionId, 400, '2026-10-04')
    await moveToVolume2()
    await page(scope, sessionId, 10, '2026-10-04') // beside the volume 1 point of the same day

    // the second point is the latest of the day: the book went 0.2 -> (400 + 10) / 1000 = 0.41, spread over the days between
    const days = await getDailyStats(t.db, scope, range)
    const total = days.reduce((sum, d) => sum + d.words, 0)
    expect(total).toBeCloseTo(0.41 * 250_000, 0)
    expect(total).toBeLessThanOrEqual(250_000)
    for (const d of days) expect(d.words).toBeGreaterThanOrEqual(0)
  })

  it('a finished read without points on volume 2 uses the summed word count', async () => {
    const { scope, sessionId, moveToVolume2 } = await setup()
    await moveToVolume2()
    await finish(scope, sessionId, '2026-10-08')
    const summary = await getStatsSummary(t.db, scope, range)
    expect(summary.totalWords).toBe(250_000)
  })

  it('a point split out of the set does not credit the whole book', async () => {
    const { scope, eds, sessionId, moveToVolume2 } = await setup()
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    await page(scope, sessionId, 400, '2026-10-04')
    await moveToVolume2()
    await page(scope, sessionId, 300, '2026-10-06')
    await splitEdition(t.db, admin, eds[0]?.id ?? '')
    const days = await getDailyStats(t.db, scope, range)
    const total = days.reduce((sum, d) => sum + d.words, 0)
    expect(total).toBeLessThanOrEqual(250_000)
    // volume 2 alone (its lengths are incomplete): (1 + 300 / 600) / 2 of volume 2's words x 2, no whole-book credit for the split point
    expect(total).toBeCloseTo(0.75 * 300_000, 0)
  })

  it('the work-wide audiobook duration fallback is one volume, scaled to the set', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const audio = (volume: number) => EditionInput.parse({ format: 'audiobook', language: 'he', volume, volumeCount: 2 })
    // neither volume has a duration; the work's longest audiobook (another language) is 10 hours
    const workId = await createWork(t.db, workInput({ editions: [audio(1), audio(2), EditionInput.parse({ format: 'audiobook', language: 'en', durationSec: 36_000 })] }))
    const [first] = await t.db.select({ id: editions.id }).from(editions).where(and(eq(editions.workId, workId), eq(editions.volume, 1)))
    const sessionId = await startSession(t.db, scope, { workId, editionId: first?.id ?? null, mode: 'listen', startedOn: '2026-10-01', startedPrecision: 'day' })
    await finish(scope, sessionId, '2026-10-08')
    const summary = await getStatsSummary(t.db, scope, range)
    expect(summary.totalMinutes).toBeCloseTo((36_000 * 2) / 60, 5)
  })
})
