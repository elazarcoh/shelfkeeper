import { describe, expect, it } from 'vitest'
import { GoalInput } from '@mylib/domain'
import { userHiddenWorks } from '../schema'
import { libraryTitles, seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail } from './catalog'
import { createGoal, listGoals } from './goals'
import {
  completeSession,
  deleteReadingSession,
  dismissCheckin,
  getCheckinState,
  listInProgressSessions,
  listSessionsForWork,
  markCheckedIn,
  markFinished,
  setStatusFromMenu,
  snoozeCheckin,
  startReading,
  startSession,
} from './reading-sessions'
import { loadUserScope } from './scope'
import { addProgressPoint } from './progress'
import { getDailyStats, getFinishedBooks, getStatsSummary } from './stats'
import { addToQueue, listQueueIds } from './tracking'

describe('reading sessions repository', () => {
  const t = useTestDb()

  it('starts a session, marks the book reading, and adds it to the personal library', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    await startSession(t.db, scope, { workId: work, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })
    expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('reading')
    expect(await libraryTitles(t.db, await loadUserScope(t.db, user))).toEqual(['A'])
  })

  it('rejects a second in-progress session in the same mode, but allows a different mode', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    await startSession(t.db, scope, { workId: work, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })
    await expect(
      startSession(t.db, scope, { workId: work, editionId: null, mode: 'read', startedOn: '2026-03-02', startedPrecision: 'day' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      startSession(t.db, scope, { workId: work, editionId: null, mode: 'listen', startedOn: '2026-03-02', startedPrecision: 'day' }),
    ).resolves.toEqual(expect.any(String))
  })

  it('finishing sets status to read; a second finish of the same book is a reread', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const first = await startSession(t.db, scope, {
      workId: work,
      editionId: null,
      mode: 'read',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
    })
    await completeSession(t.db, scope, first, {
      outcome: 'finished',
      finishedOn: '2026-01-05',
      finishedPrecision: 'day',
      fractionCompleted: null,
    })
    expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('read')

    const second = await startSession(t.db, scope, {
      workId: work,
      editionId: null,
      mode: 'read',
      startedOn: '2026-06-01',
      startedPrecision: 'day',
    })
    await completeSession(t.db, scope, second, {
      outcome: 'finished',
      finishedOn: '2026-06-03',
      finishedPrecision: 'day',
      fractionCompleted: null,
    })

    const sessions = await listSessionsForWork(t.db, scope, work)
    expect(sessions.find((s) => s.id === first)?.isReread).toBe(false)
    expect(sessions.find((s) => s.id === second)?.isReread).toBe(true)
  })

  it('rejects completing the same session twice', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const session = await startSession(t.db, scope, {
      workId: work,
      editionId: null,
      mode: 'read',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
    })
    await completeSession(t.db, scope, session, {
      outcome: 'finished',
      finishedOn: '2026-01-02',
      finishedPrecision: 'day',
      fractionCompleted: null,
    })
    await expect(
      completeSession(t.db, scope, session, {
        outcome: 'abandoned',
        finishedOn: '2026-01-03',
        finishedPrecision: 'day',
        fractionCompleted: 0.2,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('treats a hidden work as missing for starting, completing and listing sessions', async () => {
    const user = await seedUser(t.db)
    const before = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const session = await startSession(t.db, before, {
      workId: work,
      editionId: null,
      mode: 'read',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
    })
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: work })
    const scope = await loadUserScope(t.db, user)
    await expect(
      startSession(t.db, scope, { workId: work, editionId: null, mode: 'listen', startedOn: '2026-01-02', startedPrecision: 'day' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      completeSession(t.db, scope, session, {
        outcome: 'finished',
        finishedOn: '2026-01-02',
        finishedPrecision: 'day',
        fractionCompleted: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(listSessionsForWork(t.db, scope, work)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(snoozeCheckin(t.db, scope, session, '2999-01-01')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(markCheckedIn(t.db, scope, session)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('excludes hidden works from listInProgressSessions and getCheckinState', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const session = await startSession(t.db, scope, {
      workId: work,
      editionId: null,
      mode: 'read',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
    })
    expect((await listInProgressSessions(t.db, scope, '2026-03-01')).map((s) => s.id)).toEqual([session])
    expect((await getCheckinState(t.db, scope, '2026-03-01')).inProgress.map((s) => s.id)).toEqual([session])
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: work })
    const hiddenScope = await loadUserScope(t.db, user)
    expect(await listInProgressSessions(t.db, hiddenScope, '2026-03-01')).toEqual([])
    expect((await getCheckinState(t.db, hiddenScope, '2026-03-01')).inProgress).toEqual([])
  })

  // Bug B2 (task 20): the check-in flow was seen opening straight on "started anything new?" instead
  // of a session's card. Spec §7 says check-in shows a card "per in-progress session", with no
  // exception for one started today — listInProgressSessions filters only on outcome, visibility and
  // snooze (not startedOn), so this pins that a same-day session is included alongside the cases that
  // must still be skipped (already resolved today, or snoozed through today).
  it('includes an in-progress session started the same day as the check-in, but not one already resolved or snoozed today', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const ongoing = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const resolved = await createWork(t.db, workInput({ title: 'B', series: [] }))
    const snoozed = await createWork(t.db, workInput({ title: 'C', series: [] }))

    const ongoingSession = await startSession(t.db, scope, { workId: ongoing, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })
    const resolvedSession = await startSession(t.db, scope, { workId: resolved, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })
    await completeSession(t.db, scope, resolvedSession, { outcome: 'finished', finishedOn: '2026-03-01', finishedPrecision: 'day', fractionCompleted: null })
    const snoozedSession = await startSession(t.db, scope, { workId: snoozed, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })
    await snoozeCheckin(t.db, scope, snoozedSession, '2026-03-01')

    expect((await getCheckinState(t.db, scope, '2026-03-01')).inProgress.map((s) => s.id)).toEqual([ongoingSession])
  })

  it('excludes a snoozed session from check-in until the snooze date passes', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const session = await startSession(t.db, scope, {
      workId: work,
      editionId: null,
      mode: 'read',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
    })
    // the client's local date decides, not the server clock
    await snoozeCheckin(t.db, scope, session, '2026-03-05')
    expect(await listInProgressSessions(t.db, scope, '2026-03-05')).toEqual([])
    expect((await listInProgressSessions(t.db, scope, '2026-03-06')).map((s) => s.id)).toEqual([session])
  })

  it('is due once per (client-local) day and not due again right after dismissal', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    expect((await getCheckinState(t.db, scope, '2026-03-01')).dueToday).toBe(true)
    await dismissCheckin(t.db, scope, '2026-03-01')
    expect((await getCheckinState(t.db, scope, '2026-03-01')).dueToday).toBe(false)
    expect((await getCheckinState(t.db, scope, '2026-03-02')).dueToday).toBe(true)
  })

  // #45: a book checked in on (a "Still going", or a point saved anywhere) is left alone for 12 hours
  it('skips a book checked in on within 12 hours, and waits when every book was', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const start = (workId: string) => startSession(t.db, scope, { workId, editionId: null, mode: 'read', startedOn: '2026-01-01', startedPrecision: 'day' })
    const a = await start(await createWork(t.db, workInput({ title: 'A', series: [] })))
    const b = await start(await createWork(t.db, workInput({ title: 'B', series: [] })))
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const state = (at = now) => getCheckinState(t.db, scope, '2026-03-01', at)

    expect(await state()).toMatchObject({ dueToday: true, recentlyCheckedIn: [] })
    await markCheckedIn(t.db, scope, a)
    // B is still left to ask about; both stay in inProgress for a check-in the reader opens by hand
    expect(await state()).toMatchObject({ dueToday: true, recentlyCheckedIn: [a] })
    expect((await state()).inProgress.map((s) => s.id).sort()).toEqual([a, b].sort())
    await addProgressPoint(t.db, scope, { sessionId: b, today, kind: 'page', value: 10 }, { now })
    expect((await state()).dueToday).toBe(false)
    expect((await state()).recentlyCheckedIn.sort()).toEqual([a, b].sort())
    // a second "Still going" on the same book just moves its time
    await markCheckedIn(t.db, scope, a)
    expect((await state(new Date(now.getTime() + 13 * 3600_000))).dueToday).toBe(true)
    expect((await state(new Date(now.getTime() + 13 * 3600_000))).recentlyCheckedIn).toEqual([])
    expect((await state(new Date(now.getTime() + 11 * 3600_000))).recentlyCheckedIn.sort()).toEqual([a, b].sort())

    await completeSession(t.db, scope, a, { outcome: 'finished', finishedOn: today, finishedPrecision: 'day', fractionCompleted: null })
    await expect(markCheckedIn(t.db, scope, a)).rejects.toMatchObject({ code: 'CONFLICT' })
    const other = await loadUserScope(t.db, await seedUser(t.db))
    await expect(markCheckedIn(t.db, other, b)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('infers the edition when exactly one edition matches the mode, and leaves it null when two match', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(
      t.db,
      workInput({ title: 'A', series: [], editions: [{ format: 'audiobook' }, { format: 'physical' }, { format: 'ebook' }] }),
    )
    const audiobook = (await getWorkDetail(t.db, scope, work)).editions.find((e) => e.format === 'audiobook')?.id
    await startSession(t.db, scope, { workId: work, editionId: null, mode: 'listen', startedOn: '2026-03-01', startedPrecision: 'day' })
    await startSession(t.db, scope, { workId: work, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })
    const sessions = await listSessionsForWork(t.db, scope, work)
    expect(sessions.find((s) => s.mode === 'listen')?.editionId).toBe(audiobook)
    expect(sessions.find((s) => s.mode === 'read')?.editionId).toBeNull()
  })

  const finish = { outcome: 'finished', finishedOn: '2026-02-01', finishedPrecision: 'day', fractionCompleted: null } as const
  const abandon = { outcome: 'abandoned', finishedOn: '2026-02-01', finishedPrecision: 'day', fractionCompleted: 0.3 } as const
  const begin = (workId: string, mode: 'read' | 'listen', startedOn = '2026-01-01') =>
    ({ workId, editionId: null, mode, startedOn, startedPrecision: 'day' }) as const

  it('keeps the status "reading" when another session of the work is still in progress', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const reading = await startSession(t.db, scope, begin(work, 'read'))
    await startSession(t.db, scope, begin(work, 'listen'))
    await completeSession(t.db, scope, reading, finish)
    expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('reading')
  })

  it('keeps the status "read" when abandoning a reread of a finished book', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    await completeSession(t.db, scope, await startSession(t.db, scope, begin(work, 'read')), finish)
    const reread = await startSession(t.db, scope, begin(work, 'read', '2026-03-01'))
    await completeSession(t.db, scope, reread, { ...abandon, finishedOn: '2026-03-05' })
    expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('read')
  })

  describe('markFinished (the one-tap "Mark as read")', () => {
    const thisYear = { from: '2026-01-01', to: '2026-12-31' }

    it('a read on an unknown date sets the status read but changes neither this year\'s daily_stat nor goal progress', async () => {
      const user = await seedUser(t.db)
      const scope = await loadUserScope(t.db, user)
      const other = await createWork(t.db, workInput({ title: 'Read this year', series: [], editions: [{ format: 'physical', wordCount: 50_000 }] }))
      await completeSession(t.db, scope, await startSession(t.db, scope, begin(other, 'read', '2026-10-01')), { ...finish, finishedOn: '2026-10-05' })
      await createGoal(t.db, scope, GoalInput.parse({ periodStart: '2026-01-01', periodEnd: '2026-12-31', metric: 'books', target: 10 }))
      await createGoal(t.db, scope, GoalInput.parse({ periodStart: '2026-01-01', periodEnd: '2026-12-31', metric: 'words', target: 100_000 }))
      const dailyBefore = await getDailyStats(t.db, scope, thisYear)
      const goalsBefore = (await listGoals(t.db, scope)).map((g) => [g.metric, g.total])

      const work = await createWork(t.db, workInput({ title: 'Long ago', series: [], editions: [{ format: 'physical', wordCount: 80_000 }] }))
      const id = await markFinished(t.db, scope, { workId: work, editionId: null, mode: 'read', finishedOn: '2026-10-07', finishedPrecision: 'unknown' })

      expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('read')
      expect(await libraryTitles(t.db, scope)).toContain('Long ago')
      const [session] = await listSessionsForWork(t.db, scope, work)
      expect(session).toMatchObject({
        id,
        outcome: 'finished',
        startedOn: '2026-10-07',
        startedPrecision: 'unknown',
        finishedOn: '2026-10-07',
        finishedPrecision: 'unknown',
        fractionCompleted: 1,
        isReread: false,
      })
      expect(session?.editionId).not.toBeNull() // the only reading edition, as a start would pick
      expect(await getDailyStats(t.db, scope, thisYear)).toEqual(dailyBefore)
      expect((await listGoals(t.db, scope)).map((g) => [g.metric, g.total])).toEqual(goalsBefore)
      expect((await getStatsSummary(t.db, scope, thisYear)).booksFinished).toBe(1)
      expect((await getFinishedBooks(t.db, scope, thisYear)).map((b) => b.title)).toEqual(['Read this year'])
    })

    it('a read in a year counts in that year (yearly total, shelf, spread over the year) but not in one of its months', async () => {
      const user = await seedUser(t.db)
      const scope = await loadUserScope(t.db, user)
      const work = await createWork(t.db, workInput({ title: 'Heard in 2019', series: [], editions: [{ format: 'audiobook', durationSec: 365 * 1800 }] }))
      await markFinished(t.db, scope, { workId: work, editionId: null, mode: 'listen', finishedOn: '2019-06-15', finishedPrecision: 'year' })

      const [session] = await listSessionsForWork(t.db, scope, work)
      expect(session).toMatchObject({ mode: 'listen', startedOn: '2019-01-01', startedPrecision: 'year', finishedOn: '2019-01-01', finishedPrecision: 'year' })
      const year = { from: '2019-01-01', to: '2019-12-31' }
      expect((await getStatsSummary(t.db, scope, year)).booksFinished).toBe(1)
      expect((await getFinishedBooks(t.db, scope, year)).map((b) => b.title)).toEqual(['Heard in 2019'])
      expect((await getStatsSummary(t.db, scope, { from: '2019-01-01', to: '2019-01-31' })).booksFinished).toBe(0)
      const days = await getDailyStats(t.db, scope, year)
      expect(days).toHaveLength(365)
      expect(days.every((d) => d.estimated && Math.abs(d.minutes - 30) < 1e-9)).toBe(true)
    })

    it('an exact-date read has an unknown start: it counts in its finish month and year, its words estimated on that day', async () => {
      const user = await seedUser(t.db)
      const scope = await loadUserScope(t.db, user)
      const work = await createWork(t.db, workInput({ title: 'On a day', series: [], editions: [{ format: 'physical', wordCount: 80_000 }] }))
      await markFinished(t.db, scope, { workId: work, editionId: null, mode: 'read', finishedOn: '2024-02-29', finishedPrecision: 'day' })

      expect((await listSessionsForWork(t.db, scope, work))[0]).toMatchObject({
        startedOn: '2024-02-29',
        startedPrecision: 'unknown',
        finishedOn: '2024-02-29',
        finishedPrecision: 'day',
      })
      expect(await getDailyStats(t.db, scope, { from: '2024-01-01', to: '2024-12-31' })).toEqual([
        { date: '2024-02-29', mode: 'read', minutes: 0, words: 80_000, estimated: true },
      ])
      expect((await getStatsSummary(t.db, scope, { from: '2024-01-01', to: '2024-12-31' })).booksFinished).toBe(1)
      expect((await getStatsSummary(t.db, scope, { from: '2024-02-01', to: '2024-02-29' })).booksFinished).toBe(1)
      await createGoal(t.db, scope, GoalInput.parse({ periodStart: '2024-02-01', periodEnd: '2024-02-29', metric: 'books', target: 1 }))
      expect((await listGoals(t.db, scope)).map((g) => g.total)).toEqual([1])
    })

    it('refuses a finish in the future (past the client-today tolerance), but not an unknown date', async () => {
      const user = await seedUser(t.db)
      const scope = await loadUserScope(t.db, user)
      const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
      const now = new Date('2026-10-07T12:00:00Z')
      const at = (finishedOn: string, finishedPrecision: 'day' | 'month' | 'year' | 'unknown') =>
        markFinished(t.db, scope, { workId: work, editionId: null, mode: 'read', finishedOn, finishedPrecision }, { now })
      await expect(at('2026-10-10', 'day')).rejects.toMatchObject({ code: 'INVALID', message: 'That date is in the future' })
      await expect(at('2026-11-01', 'month')).rejects.toMatchObject({ code: 'INVALID' })
      await expect(at('2027-01-01', 'year')).rejects.toMatchObject({ code: 'INVALID' })
      expect(await listSessionsForWork(t.db, scope, work)).toEqual([])
      await expect(at('2026-10-09', 'day')).resolves.toEqual(expect.any(String))
      await expect(at('2030-01-01', 'unknown')).resolves.toEqual(expect.any(String))
    })

    it('an identical submit within minutes returns the same session instead of a second read', async () => {
      const user = await seedUser(t.db)
      const scope = await loadUserScope(t.db, user)
      const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
      const input = { workId: work, editionId: null, mode: 'read', finishedOn: '2019-01-01', finishedPrecision: 'year' } as const
      const first = await markFinished(t.db, scope, input)
      expect(await markFinished(t.db, scope, input)).toBe(first)
      expect(await listSessionsForWork(t.db, scope, work)).toHaveLength(1)
      // much later, the same answer is a deliberate second read
      const later = new Date(Date.now() + 10 * 60_000)
      expect(await markFinished(t.db, scope, input, { now: later })).not.toBe(first)
      // a different date or mode is a different read
      await markFinished(t.db, scope, { ...input, finishedOn: '2020-01-01' })
      await markFinished(t.db, scope, { ...input, mode: 'listen' })
      expect(await listSessionsForWork(t.db, scope, work)).toHaveLength(4)
    })

    it('saves the optional rating with the read, and leaves a rating alone when none is given', async () => {
      const user = await seedUser(t.db)
      const scope = await loadUserScope(t.db, user)
      const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
      await markFinished(t.db, scope, { workId: work, editionId: null, mode: 'read', finishedOn: '2019-01-01', finishedPrecision: 'year', rating: 4.5 })
      expect((await getWorkDetail(t.db, scope, work)).me.rating).toBe(4.5)
      await markFinished(t.db, scope, { workId: work, editionId: null, mode: 'read', finishedOn: '2021-01-01', finishedPrecision: 'year', rating: null })
      expect((await getWorkDetail(t.db, scope, work)).me.rating).toBe(4.5)
      // a refused read saves no rating either
      await expect(
        markFinished(t.db, scope, { workId: work, editionId: null, mode: 'read', finishedOn: '2999-01-01', finishedPrecision: 'year', rating: 1 }),
      ).rejects.toMatchObject({ code: 'INVALID' })
      expect((await getWorkDetail(t.db, scope, work)).me.rating).toBe(4.5)
    })

    it('uses the picked edition, refuses one of another work, and treats a hidden work as missing', async () => {
      const user = await seedUser(t.db)
      const scope = await loadUserScope(t.db, user)
      const work = await createWork(t.db, workInput({ title: 'A', series: [], editions: [{ format: 'physical' }, { format: 'ebook' }] }))
      const ebook = (await getWorkDetail(t.db, scope, work)).editions.find((e) => e.format === 'ebook')?.id ?? null
      await markFinished(t.db, scope, { workId: work, editionId: ebook, mode: 'read', finishedOn: '2020-03-01', finishedPrecision: 'month' })
      expect((await listSessionsForWork(t.db, scope, work))[0]?.editionId).toBe(ebook)

      const elsewhere = await createWork(t.db, workInput({ title: 'B', series: [] }))
      await expect(
        markFinished(t.db, scope, { workId: elsewhere, editionId: ebook, mode: 'read', finishedOn: '2020-03-01', finishedPrecision: 'month' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: elsewhere })
      const hidden = await loadUserScope(t.db, user)
      await expect(
        markFinished(t.db, hidden, { workId: elsewhere, editionId: null, mode: 'read', finishedOn: '2020-03-01', finishedPrecision: 'day' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('is a reread only after an earlier dated finish, and keeps "reading" while another session is open', async () => {
      const user = await seedUser(t.db)
      const scope = await loadUserScope(t.db, user)
      const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
      await completeSession(t.db, scope, await startSession(t.db, scope, begin(work, 'read')), finish) // finished 2026-02-01
      const later = await markFinished(t.db, scope, { workId: work, editionId: null, mode: 'read', finishedOn: '2026-05-01', finishedPrecision: 'month' })
      const longAgo = await markFinished(t.db, scope, { workId: work, editionId: null, mode: 'read', finishedOn: '2026-10-07', finishedPrecision: 'unknown' })
      const sessions = await listSessionsForWork(t.db, scope, work)
      expect(sessions.find((s) => s.id === later)?.isReread).toBe(true)
      expect(sessions.find((s) => s.id === longAgo)?.isReread).toBe(false)

      await startSession(t.db, scope, begin(work, 'listen', '2026-10-01'))
      await markFinished(t.db, scope, { workId: work, editionId: null, mode: 'read', finishedOn: '2015-01-01', finishedPrecision: 'year' })
      expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('reading')
    })
  })

  describe('setStatusFromMenu (the book page’s status menu, #152)', () => {
    const now = new Date('2026-10-21T08:00:00Z')

    it('Read records one finished read with an unknown date; picking Read again adds none', async () => {
      const user = await seedUser(t.db)
      const scope = await loadUserScope(t.db, user)
      const work = await createWork(t.db, workInput({ title: 'Menu read', series: [] }))
      await setStatusFromMenu(t.db, scope, work, 'read', { now })
      await setStatusFromMenu(t.db, scope, work, 'read', { now })
      expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('read')
      const sessions = await listSessionsForWork(t.db, scope, work)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({ mode: 'read', outcome: 'finished', finishedOn: '2026-10-21', finishedPrecision: 'unknown', isReread: false })
      expect(sessions[0]?.editionId).not.toBeNull()
    })

    it('listened for a book with only audiobooks; none added when a finished read exists; other statuses add none', async () => {
      const user = await seedUser(t.db)
      const scope = await loadUserScope(t.db, user)
      const audio = await createWork(t.db, workInput({ title: 'Audio only', series: [], editions: [{ format: 'audiobook' }] }))
      await setStatusFromMenu(t.db, scope, audio, 'read', { now })
      expect((await listSessionsForWork(t.db, scope, audio)).map((s) => s.mode)).toEqual(['listen'])

      const done = await createWork(t.db, workInput({ title: 'Done before', series: [] }))
      await completeSession(t.db, scope, await startSession(t.db, scope, begin(done, 'read', '2026-10-01')), { ...finish, finishedOn: '2026-10-05' })
      await setStatusFromMenu(t.db, scope, done, 'abandoned', { now })
      await setStatusFromMenu(t.db, scope, done, 'read', { now })
      expect(await listSessionsForWork(t.db, scope, done)).toHaveLength(1)

      const wanted = await createWork(t.db, workInput({ title: 'Wanted', series: [] }))
      await setStatusFromMenu(t.db, scope, wanted, 'want_to_read', { now })
      expect((await getWorkDetail(t.db, scope, wanted)).me.status).toBe('want_to_read')
      expect(await listSessionsForWork(t.db, scope, wanted)).toEqual([])
    })

    it('keeps Read even with a read still open', async () => {
      const user = await seedUser(t.db)
      const scope = await loadUserScope(t.db, user)
      const work = await createWork(t.db, workInput({ title: 'Open', series: [], editions: [{ format: 'physical' }, { format: 'audiobook' }] }))
      await startSession(t.db, scope, begin(work, 'listen', '2026-10-01'))
      await setStatusFromMenu(t.db, scope, work, 'read', { now })
      expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('read')
      expect((await listSessionsForWork(t.db, scope, work)).map((s) => [s.mode, s.outcome]).sort()).toEqual([['listen', 'in_progress'], ['read', 'finished']])
    })
  })

  it('refuses a start or a finish in the future (past the client-today tolerance); an unknown date is exempt', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const now = new Date('2026-10-07T12:00:00Z')
    await expect(startSession(t.db, scope, { ...begin(work, 'read', '2026-10-10') }, { now })).rejects.toMatchObject({
      code: 'INVALID',
      message: 'That date is in the future',
    })
    await expect(startSession(t.db, scope, { ...begin(work, 'read', '2026-11-01'), startedPrecision: 'month' }, { now })).rejects.toMatchObject({ code: 'INVALID' })
    const session = await startSession(t.db, scope, { ...begin(work, 'read', '2026-10-01') }, { now })
    await expect(completeSession(t.db, scope, session, { ...finish, finishedOn: '2027-01-01', finishedPrecision: 'year' }, { now })).rejects.toMatchObject({
      code: 'INVALID',
      message: 'That date is in the future',
    })
    await expect(completeSession(t.db, scope, session, { ...finish, finishedOn: '2030-01-01', finishedPrecision: 'unknown' }, { now })).resolves.toBeUndefined()
  })

  it('rejects a finish date range that ends before the start range begins', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const session = await startSession(t.db, scope, { ...begin(work, 'read', '2026-03-10') })
    await expect(completeSession(t.db, scope, session, { ...finish, finishedOn: '2026-03-09' })).rejects.toMatchObject({
      code: 'INVALID',
    })
    // an imprecise finish whose range still reaches the start is fine
    await expect(
      completeSession(t.db, scope, session, { ...finish, finishedOn: '2026-03-01', finishedPrecision: 'month' }),
    ).resolves.toBeUndefined()
  })

  it("deletes the owner's session, restoring status from the latest remaining one", async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    await completeSession(t.db, scope, await startSession(t.db, scope, begin(work, 'read')), finish)
    const mistaken = await startSession(t.db, scope, begin(work, 'read', '2026-03-01'))
    await snoozeCheckin(t.db, scope, mistaken, '2026-03-05')
    expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('reading')

    const other = await loadUserScope(t.db, await seedUser(t.db))
    await expect(deleteReadingSession(t.db, other, mistaken)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await deleteReadingSession(t.db, scope, mistaken)
    expect((await listSessionsForWork(t.db, scope, work)).map((s) => s.outcome)).toEqual(['finished'])
    expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('read')
    await expect(deleteReadingSession(t.db, scope, mistaken)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('leaves the status unchanged when the last session is deleted, and hides sessions of hidden works', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const only = await startSession(t.db, scope, begin(work, 'read'))
    await deleteReadingSession(t.db, scope, only)
    expect(await listSessionsForWork(t.db, scope, work)).toEqual([])
    expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('reading')

    const again = await startSession(t.db, scope, begin(work, 'read'))
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: work })
    await expect(deleteReadingSession(t.db, await loadUserScope(t.db, user), again)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('after a delete, status stays reading while another session is in progress', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const listening = await startSession(t.db, scope, { workId: work, editionId: null, mode: 'listen', startedOn: '2026-01-01', startedPrecision: 'day' })
    const first = await startSession(t.db, scope, { workId: work, editionId: null, mode: 'read', startedOn: '2026-01-02', startedPrecision: 'day' })
    await completeSession(t.db, scope, first, { outcome: 'finished', finishedOn: '2026-01-03', finishedPrecision: 'day', fractionCompleted: null })
    const mistake = await startSession(t.db, scope, { workId: work, editionId: null, mode: 'read', startedOn: '2026-01-04', startedPrecision: 'day' })

    await deleteReadingSession(t.db, scope, mistake)
    expect((await getWorkDetail(t.db, scope, work)).me.status).toBe('reading')
    expect((await listSessionsForWork(t.db, scope, work)).map((s) => s.id).sort()).toEqual([first, listening].sort())
  })

  it('starting a book takes it off Up next and returns where it was (#85)', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const a = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const b = await createWork(t.db, workInput({ title: 'B', series: [] }))
    const c = await createWork(t.db, workInput({ title: 'C', series: [] }))
    for (const w of [a, b, c]) await addToQueue(t.db, scope, w, 'bottom')
    const started = await startReading(t.db, scope, { workId: b, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })
    expect(started.queuePosition).toBe(2)
    expect(typeof started.sessionId).toBe('string')
    expect(await listQueueIds(t.db, scope)).toEqual([a, c])
    expect((await getWorkDetail(t.db, scope, b)).me).toMatchObject({ status: 'reading', inQueue: false })
  })

  it('starting a book not in Up next leaves Up next alone (#85)', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const a = await createWork(t.db, workInput({ title: 'A', series: [] }))
    const b = await createWork(t.db, workInput({ title: 'B', series: [] }))
    await addToQueue(t.db, scope, a, 'bottom')
    const started = await startReading(t.db, scope, { workId: b, editionId: null, mode: 'listen', startedOn: '2026-03-01', startedPrecision: 'day' })
    expect(started.queuePosition).toBeNull()
    expect(await listQueueIds(t.db, scope)).toEqual([a])
  })

  it('a start that is refused keeps the book in Up next (#85)', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    await startSession(t.db, scope, { workId: work, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })
    await addToQueue(t.db, scope, work, 'bottom')
    await expect(startReading(t.db, scope, { workId: work, editionId: null, mode: 'read', startedOn: '2026-03-02', startedPrecision: 'day' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await listQueueIds(t.db, scope)).toEqual([work])
  })
})
