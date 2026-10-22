import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { finishCountsInRange, GoalInput } from '@mylib/domain'
import { dailyStats, editions, readingProgress, userHiddenWorks, userWorks } from '../schema'
import { seedProgress, seedSession, seedUser, useTestDb, workInput } from '../testing'
import { createWork } from './catalog'
import { createGoal, listGoals } from './goals'
import { loadUserScope } from './scope'
import { getDailyStats, getFinishedBooks, getSessionsOnDate, getStatsSummary, rebuildDailyStats } from './stats'

describe('stats repository', () => {
  const t = useTestDb()

  it('spreads a finished session across its date range and rebuilding is idempotent', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    await seedSession(t.db, {
      userId: user.id,
      workId: work,
      startedOn: '2026-03-01',
      outcome: 'finished',
      finishedOn: '2026-03-02',
      fractionCompleted: 1,
    })

    const days = await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    expect(days).toHaveLength(2)
    expect(days[0]).toMatchObject({ date: '2026-03-01', mode: 'read' })

    await rebuildDailyStats(t.db, scope) // re-running must replace, not duplicate
    expect(await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })).toHaveLength(2)
  })

  it('contributes nothing for an in-progress session', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    await seedSession(t.db, { userId: user.id, workId: work, startedOn: '2026-03-01' })

    expect(await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })).toEqual([])
  })

  it('summarizes books finished and format split, excluding a hidden work', async () => {
    const user = await seedUser(t.db)
    const a = await createWork(t.db, workInput({ title: 'A', series: [], editions: [{ format: 'physical' }] }))
    const b = await createWork(t.db, workInput({ title: 'B', series: [], editions: [{ format: 'audiobook' }] }))
    await seedSession(t.db, { userId: user.id, workId: a, outcome: 'finished', startedOn: '2026-03-01', finishedOn: '2026-03-01', fractionCompleted: 1 })
    await seedSession(t.db, { userId: user.id, workId: b, outcome: 'finished', startedOn: '2026-03-05', finishedOn: '2026-03-05', fractionCompleted: 1 })
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: b })

    const scope = await loadUserScope(t.db, user)
    const summary = await getStatsSummary(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    expect(summary.booksFinished).toBe(1)
    expect(summary.byFormat).toMatchObject({ physical: 1, audiobook: 0 })
  })

  it('lists finished books in the range, oldest finish first, with format, size and rating, excluding a hidden work', async () => {
    const user = await seedUser(t.db)
    const a = await createWork(t.db, workInput({ title: 'A', authors: ['Ann'], series: [], editions: [{ format: 'physical', pageCount: 320 }] }))
    const b = await createWork(t.db, workInput({ title: 'B', series: [], editions: [{ format: 'audiobook', durationSec: 36_000 }] }))
    const hidden = await createWork(t.db, workInput({ title: 'Hidden', series: [], editions: [{ format: 'ebook' }] }))
    const c = await createWork(t.db, workInput({ title: 'C', series: [], editions: [{ format: 'physical' }, { format: 'ebook' }] }))
    await seedSession(t.db, { userId: user.id, workId: b, mode: 'listen', outcome: 'finished', startedOn: '2026-02-01', finishedOn: '2026-05-01', finishedPrecision: 'month', fractionCompleted: 1 })
    await seedSession(t.db, { userId: user.id, workId: a, outcome: 'finished', startedOn: '2026-03-01', finishedOn: '2026-03-04', fractionCompleted: 1, isReread: true })
    await seedSession(t.db, { userId: user.id, workId: c, outcome: 'finished', startedOn: '2026-06-01', finishedOn: '2026-06-02', fractionCompleted: 1 })
    await seedSession(t.db, { userId: user.id, workId: hidden, outcome: 'finished', startedOn: '2026-03-01', finishedOn: '2026-03-02', fractionCompleted: 1 })
    await seedSession(t.db, { userId: user.id, workId: a, outcome: 'finished', startedOn: '2025-03-01', finishedOn: '2025-03-02', fractionCompleted: 1 }) // other year
    await seedSession(t.db, { userId: user.id, workId: a, outcome: 'abandoned', startedOn: '2026-07-01', finishedOn: '2026-07-02', fractionCompleted: 0.5 })
    await seedSession(t.db, { userId: user.id, workId: c, startedOn: '2026-08-01' }) // in progress
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: hidden })
    await t.db.insert(userWorks).values({ userId: user.id, workId: a, status: 'read', rating: 4.5 })

    const scope = await loadUserScope(t.db, user)
    const books = await getFinishedBooks(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    expect(books.map((x) => x.title)).toEqual(['A', 'B', 'C'])
    expect(books[0]).toMatchObject({ workId: a, authors: ['Ann'], format: 'physical', pageCount: 320, rating: 4.5, isReread: true, mode: 'read' })
    expect(books[1]).toMatchObject({ format: 'audiobook', durationSec: 36_000, rating: null, finishedPrecision: 'month', mode: 'listen' })
    expect(books[2]?.format).toBe('unspecified') // no edition on the session and two formats on the work
    // agrees with the summary's format split
    const summary = await getStatsSummary(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    expect(summary.booksFinished).toBe(books.length)
    expect(summary.byFormat).toEqual({ physical: 1, ebook: 0, audiobook: 1, unspecified: 1 })
    expect(await getFinishedBooks(t.db, scope, { from: '2024-01-01', to: '2024-12-31' })).toEqual([])
  })

  it('drills down to the sessions covering a given date', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [] }))
    await seedSession(t.db, {
      userId: user.id,
      workId: work,
      outcome: 'finished',
      startedOn: '2026-03-01',
      finishedOn: '2026-03-05',
      fractionCompleted: 1,
    })
    expect((await getSessionsOnDate(t.db, scope, '2026-03-03')).map((s) => s.title)).toEqual(['A'])
    expect(await getSessionsOnDate(t.db, scope, '2026-04-01')).toEqual([])
  })

  it('excludes hidden work word count from totalWords after visibility change', async () => {
    const user = await seedUser(t.db)
    const work1 = await createWork(t.db, workInput({ title: 'Visible Work', series: [], editions: [{ format: 'physical', wordCount: 50000 }] }))
    const work2 = await createWork(t.db, workInput({ title: 'Hidden Work', series: [], editions: [{ format: 'ebook', wordCount: 60000 }] }))

    await seedSession(t.db, {
      userId: user.id,
      workId: work1,
      outcome: 'finished',
      startedOn: '2026-03-01',
      finishedOn: '2026-03-01',
      fractionCompleted: 1,
    })
    await seedSession(t.db, {
      userId: user.id,
      workId: work2,
      outcome: 'finished',
      startedOn: '2026-03-02',
      finishedOn: '2026-03-02',
      fractionCompleted: 1,
    })

    // Before hiding: both works' stats included
    let scope = await loadUserScope(t.db, user)
    let summary = await getStatsSummary(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    const totalWordsBefore = summary.totalWords

    // Hide work2
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: work2 })

    // After hiding: only work1's stats included
    scope = await loadUserScope(t.db, user)
    summary = await getStatsSummary(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    expect(summary.totalWords).toBeLessThan(totalWordsBefore)
    expect(summary.booksFinished).toBe(1)
    expect((await getDailyStats(t.db, scope, { from: '2026-03-02', to: '2026-03-02' })).length).toBe(0)
  })

  it('counts edition-less session as unspecified when work has multiple formats', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    // Create work with two editions (physical and audiobook)
    const work = await createWork(t.db, workInput({ title: 'Multi-format', series: [], editions: [{ format: 'physical' }, { format: 'audiobook' }] }))
    // Create session without specifying edition
    await seedSession(t.db, { userId: user.id, workId: work, outcome: 'finished', startedOn: '2026-03-01', finishedOn: '2026-03-01', fractionCompleted: 1 })

    const summary = await getStatsSummary(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    expect(summary.booksFinished).toBe(1)
    expect(summary.byFormat.unspecified).toBe(1)
    expect(summary.byFormat.physical).toBe(0)
    expect(summary.byFormat.audiobook).toBe(0)
  })

  it('listen session with no edition counts minutes (work-level duration, estimated)', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(
      t.db,
      workInput({ title: 'A', series: [], editions: [{ format: 'audiobook', durationSec: 7200 }, { format: 'physical' }] }),
    )
    await seedSession(t.db, {
      userId: user.id,
      workId: work,
      mode: 'listen',
      outcome: 'finished',
      startedOn: '2026-03-01',
      finishedOn: '2026-03-01',
      fractionCompleted: 1,
    })
    const days = await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    expect(days).toEqual([{ date: '2026-03-01', mode: 'listen', minutes: 120, words: 0, estimated: true }])
    expect((await getStatsSummary(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })).totalMinutes).toBe(120)
  })

  it('rebuilds a session spread over more days than one insert chunk holds', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const work = await createWork(t.db, workInput({ title: 'A', series: [], editions: [{ format: 'physical', wordCount: 36_000 }] }))
    await seedSession(t.db, {
      userId: user.id,
      workId: work,
      outcome: 'finished',
      startedOn: '2020-01-01',
      finishedOn: '2025-12-31',
      fractionCompleted: 1,
    })
    const days = await getDailyStats(t.db, scope, { from: '2020-01-01', to: '2025-12-31' })
    expect(days).toHaveLength(2192)
    expect(days.reduce((sum, d) => sum + d.words, 0)).toBeCloseTo(36_000, 3)
  })

  /** A work with one edition of `format`, and that edition's id. */
  async function bookWith(edition: { format: 'physical' | 'ebook' | 'audiobook'; pageCount?: number; wordCount?: number; durationSec?: number }, title = 'P') {
    const workId = await createWork(t.db, workInput({ title, series: [], editions: [edition] }))
    const [row] = await t.db.select({ id: editions.id }).from(editions).where(eq(editions.workId, workId))
    if (!row) throw new Error('no edition')
    return { workId, editionId: row.id }
  }
  const storedDays = async (userId: string) =>
    (await t.db.select().from(dailyStats).where(eq(dailyStats.userId, userId))).map((r) => r.date).sort()

  it('an in-progress session with a page point counts up to that point (reading progress spec §4.3)', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const { workId, editionId } = await bookWith({ format: 'physical', pageCount: 300 })
    const sessionId = await seedSession(t.db, { userId: user.id, workId, editionId, startedOn: '2026-03-01' })
    await seedProgress(t.db, { sessionId, on: '2026-03-04', kind: 'page', value: 120 })

    const days = await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    // 300 pages × 275 words (estimated) × 0.4 = 33,000 words over Mar 1–4
    expect(days.map((d) => [d.date, Math.round(d.words), d.estimated])).toEqual([
      ['2026-03-01', 8250, true],
      ['2026-03-02', 8250, true],
      ['2026-03-03', 8250, true],
      ['2026-03-04', 8250, true],
    ])
  })

  it('points without a length are ignored until the edition has one', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const { workId, editionId } = await bookWith({ format: 'physical' })
    const sessionId = await seedSession(t.db, { userId: user.id, workId, editionId, startedOn: '2026-03-01' })
    await seedProgress(t.db, { sessionId, on: '2026-03-04', kind: 'page', value: 120 })
    expect(await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })).toEqual([])

    await t.db.update(editions).set({ pageCount: 300 }).where(eq(editions.id, editionId))
    expect(await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })).toHaveLength(4)
  })

  it('a finished session with points spreads by segments, and its total matches the whole book', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const { workId, editionId } = await bookWith({ format: 'ebook', wordCount: 100_000 })
    const sessionId = await seedSession(t.db, {
      userId: user.id,
      workId,
      editionId,
      startedOn: '2026-03-01',
      outcome: 'finished',
      finishedOn: '2026-03-06',
      fractionCompleted: 1,
    })
    await seedProgress(t.db, { sessionId, on: '2026-03-03', kind: 'percent', value: 30 })
    await seedProgress(t.db, { sessionId, on: '2026-03-05', kind: 'percent', value: 50 })

    const days = await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    expect(days.map((d) => [d.date.slice(5), Math.round(d.words)])).toEqual([
      ['03-01', 10_000],
      ['03-02', 10_000],
      ['03-03', 10_000],
      ['03-04', 10_000],
      ['03-05', 10_000],
      ['03-06', 50_000],
    ])
    expect(days.every((d) => !d.estimated)).toBe(true)
  })

  it('a session without points keeps the even spread (regression)', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const { workId, editionId } = await bookWith({ format: 'ebook', wordCount: 100_000 })
    await seedSession(t.db, { userId: user.id, workId, editionId, startedOn: '2026-03-01', outcome: 'finished', finishedOn: '2026-03-04', fractionCompleted: 1 })
    const days = await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    expect(days.map((d) => d.words)).toEqual([25_000, 25_000, 25_000, 25_000])
  })

  it('stores exactly the same daily_stat rows as before for sessions without points (regression pin)', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const ebook = await bookWith({ format: 'ebook', wordCount: 100_000 }, 'Ebook')
    const short = await bookWith({ format: 'ebook', wordCount: 10_000 }, 'Short')
    const paper = await bookWith({ format: 'physical', pageCount: 200 }, 'Paper')
    const audio = await bookWith({ format: 'audiobook', durationSec: 36_000 }, 'Audio')
    const monthly = await bookWith({ format: 'ebook', wordCount: 28_000 }, 'Monthly')
    const unread = await bookWith({ format: 'ebook', wordCount: 50_000 }, 'Unread')
    const u = user.id
    await seedSession(t.db, { userId: u, ...ebook, startedOn: '2026-03-01', outcome: 'finished', finishedOn: '2026-03-04', fractionCompleted: 1 })
    await seedSession(t.db, { userId: u, ...short, startedOn: '2026-03-02', outcome: 'finished', finishedOn: '2026-03-02', fractionCompleted: 1 })
    await seedSession(t.db, { userId: u, ...paper, startedOn: '2026-04-10', outcome: 'abandoned', finishedOn: '2026-04-11', fractionCompleted: 0.5 })
    await seedSession(t.db, { userId: u, ...audio, mode: 'listen', startedOn: '2026-05-01', outcome: 'finished', finishedOn: '2026-05-03', fractionCompleted: 1 })
    await seedSession(t.db, {
      userId: u,
      ...monthly,
      startedOn: '2026-02-01',
      startedPrecision: 'month',
      outcome: 'finished',
      finishedOn: '2026-02-01',
      finishedPrecision: 'month',
      fractionCompleted: 1,
    })
    // in progress without points: contributes nothing, as before
    await seedSession(t.db, { userId: u, ...unread, startedOn: '2026-03-01' })
    // a legacy completed row without a fraction: no amounts, but the drill-down still lists it, as before
    const legacy = await bookWith({ format: 'ebook', wordCount: 40_000 }, 'Legacy')
    await seedSession(t.db, { userId: u, ...legacy, startedOn: '2026-06-01', outcome: 'abandoned', finishedOn: '2026-06-02' })
    // sessions without an edition: the work's audiobook duration (estimated) and the work's word count
    const noEditionListen = await bookWith({ format: 'audiobook', durationSec: 7_200 }, 'No-edition listen')
    await seedSession(t.db, { userId: u, workId: noEditionListen.workId, mode: 'listen', startedOn: '2026-07-01', outcome: 'finished', finishedOn: '2026-07-02', fractionCompleted: 1 })
    const noEditionRead = await bookWith({ format: 'ebook', wordCount: 8_000 }, 'No-edition read')
    await seedSession(t.db, { userId: u, workId: noEditionRead.workId, startedOn: '2026-07-10', outcome: 'abandoned', finishedOn: '2026-07-11', fractionCompleted: 0.25 })

    await rebuildDailyStats(t.db, scope)
    const rows = await t.db
      .select({ date: dailyStats.date, mode: dailyStats.mode, minutes: dailyStats.minutes, words: dailyStats.words, estimated: dailyStats.estimated })
      .from(dailyStats)
      .where(eq(dailyStats.userId, u))
      .orderBy(dailyStats.date, dailyStats.mode)
    // 28,000 words over the 28 days of February 2026, estimated (month precision)
    const february = Array.from({ length: 28 }, (_, i) => ({
      date: `2026-02-${String(i + 1).padStart(2, '0')}`,
      mode: 'read',
      minutes: 0,
      words: 1000,
      estimated: true,
    }))
    expect(rows).toEqual([
      ...february,
      { date: '2026-03-01', mode: 'read', minutes: 0, words: 25_000, estimated: false },
      { date: '2026-03-02', mode: 'read', minutes: 0, words: 35_000, estimated: false },
      { date: '2026-03-03', mode: 'read', minutes: 0, words: 25_000, estimated: false },
      { date: '2026-03-04', mode: 'read', minutes: 0, words: 25_000, estimated: false },
      { date: '2026-04-10', mode: 'read', minutes: 0, words: 13_750, estimated: true },
      { date: '2026-04-11', mode: 'read', minutes: 0, words: 13_750, estimated: true },
      { date: '2026-05-01', mode: 'listen', minutes: 200, words: 0, estimated: false },
      { date: '2026-05-02', mode: 'listen', minutes: 200, words: 0, estimated: false },
      { date: '2026-05-03', mode: 'listen', minutes: 200, words: 0, estimated: false },
      { date: '2026-07-01', mode: 'listen', minutes: 60, words: 0, estimated: true },
      { date: '2026-07-02', mode: 'listen', minutes: 60, words: 0, estimated: true },
      { date: '2026-07-10', mode: 'read', minutes: 0, words: 1000, estimated: false },
      { date: '2026-07-11', mode: 'read', minutes: 0, words: 1000, estimated: false },
    ])
    expect((await getSessionsOnDate(t.db, scope, '2026-03-02')).map((s) => s.title).sort()).toEqual(['Ebook', 'Short'])
    expect(await getSessionsOnDate(t.db, scope, '2026-03-05')).toEqual([])
    expect((await getSessionsOnDate(t.db, scope, '2026-06-02')).map((s) => s.title)).toEqual(['Legacy'])
  })

  it('the drill-down lists an in-progress session only on days it adds reading', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const zero = await bookWith({ format: 'ebook', wordCount: 100_000 }, 'Zero')
    const zeroSession = await seedSession(t.db, { userId: user.id, ...zero, startedOn: '2026-03-01' })
    await seedProgress(t.db, { sessionId: zeroSession, on: '2026-03-03', kind: 'percent', value: 0 })

    const { workId, editionId } = await bookWith({ format: 'ebook', wordCount: 100_000 }, 'Back')
    const sessionId = await seedSession(t.db, { userId: user.id, workId, editionId, startedOn: '2026-03-01' })
    await seedProgress(t.db, { sessionId, on: '2026-03-03', kind: 'percent', value: 50 })
    // a lower point: nothing more is read on Mar 4–5 while the high-water mark holds
    await seedProgress(t.db, { sessionId, on: '2026-03-05', kind: 'percent', value: 30 })
    await seedProgress(t.db, { sessionId, on: '2026-03-07', kind: 'percent', value: 60 })

    const heatmap = (await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })).map((d) => d.date)
    expect(heatmap).toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-06', '2026-03-07'])
    for (const date of ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']) {
      const titles = (await getSessionsOnDate(t.db, scope, date)).map((s) => s.title)
      expect(titles, date).toEqual(heatmap.includes(date) ? ['Back'] : [])
    }
  })

  it('a stored session finished on an unknown date leaves every dated stat, and its old daily_stat rows go on the next rebuild', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const { workId, editionId } = await bookWith({ format: 'physical', wordCount: 90_000 }, 'Long ago')
    // as "Don't remember" stored it before: today's date, precision unknown
    await seedSession(t.db, {
      userId: user.id,
      workId,
      editionId,
      startedOn: '2026-09-20',
      outcome: 'finished',
      finishedOn: '2026-10-01',
      finishedPrecision: 'unknown',
      fractionCompleted: 1,
    })
    const abandoned = await bookWith({ format: 'physical', wordCount: 90_000 }, 'Set aside long ago')
    await seedSession(t.db, {
      userId: user.id,
      workId: abandoned.workId,
      editionId: abandoned.editionId,
      startedOn: '2026-10-01',
      startedPrecision: 'unknown',
      outcome: 'abandoned',
      finishedOn: '2026-10-01',
      finishedPrecision: 'unknown',
      fractionCompleted: 0.5,
    })
    // what the old rule had written for it
    await t.db.insert(dailyStats).values({ userId: user.id, date: '2026-10-01', mode: 'read', minutes: 0, words: 90_000, estimated: true })

    const year = { from: '2026-01-01', to: '2026-12-31' }
    expect(await getDailyStats(t.db, scope, year)).toEqual([])
    expect(await storedDays(user.id)).toEqual([])
    expect(await getStatsSummary(t.db, scope, year)).toMatchObject({ totalWords: 0, booksFinished: 0 })
    expect(await getFinishedBooks(t.db, scope, year)).toEqual([])
    expect(await getSessionsOnDate(t.db, scope, '2026-10-01')).toEqual([])
    expect(await getSessionsOnDate(t.db, scope, '2026-09-25')).toEqual([])
    await createGoal(t.db, scope, GoalInput.parse({ periodStart: '2026-01-01', periodEnd: '2026-12-31', metric: 'books', target: 2 }))
    expect((await listGoals(t.db, scope)).map((g) => g.total)).toEqual([0])
  })

  it('counts books finished in a range exactly as the domain rule finishCountsInRange does', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const finishes = [
      { on: '2019-03-14', precision: 'day' },
      { on: '2019-03-01', precision: 'month' },
      { on: '2019-01-01', precision: 'year' },
      { on: '2019-06-01', precision: 'unknown' },
      { on: '2020-01-01', precision: 'day' },
    ] as const
    for (const [i, f] of finishes.entries()) {
      const work = await createWork(t.db, workInput({ title: `F${i}`, series: [] }))
      await seedSession(t.db, { userId: user.id, workId: work, startedOn: f.on, startedPrecision: f.precision, outcome: 'finished', finishedOn: f.on, finishedPrecision: f.precision, fractionCompleted: 1 })
    }
    const ranges = [
      { from: '2019-01-01', to: '2019-12-31' },
      { from: '2019-03-01', to: '2019-03-31' },
      { from: '2019-01-01', to: '2019-10-07' },
      { from: '2018-07-01', to: '2020-06-30' },
      { from: '2019-12-31', to: '2020-01-01' },
      { from: '2018-01-01', to: '2018-12-31' },
    ]
    for (const range of ranges) {
      const expected = finishes.filter((f) => finishCountsInRange(f.on, f.precision, range)).length
      expect((await getStatsSummary(t.db, scope, range)).booksFinished, `${range.from}..${range.to}`).toBe(expected)
      expect(await getFinishedBooks(t.db, scope, range), `${range.from}..${range.to}`).toHaveLength(expected)
    }
  })

  it('a session with points finished on an unknown date counts its points\' days only', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const { workId, editionId } = await bookWith({ format: 'physical', pageCount: 300 })
    const sessionId = await seedSession(t.db, {
      userId: user.id,
      workId,
      editionId,
      startedOn: '2026-03-01',
      outcome: 'finished',
      finishedOn: '2026-10-01',
      finishedPrecision: 'unknown',
      fractionCompleted: 1,
    })
    await seedProgress(t.db, { sessionId, on: '2026-03-04', kind: 'page', value: 120 })

    const days = await getDailyStats(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    expect(days.map((d) => d.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'])
    expect(Math.round(days.reduce((n, d) => n + d.words, 0))).toBe(33_000)
    expect((await getStatsSummary(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })).booksFinished).toBe(0)
    expect(await getSessionsOnDate(t.db, scope, '2026-10-01')).toEqual([])
    expect((await getSessionsOnDate(t.db, scope, '2026-03-02')).map((s) => s.title)).toEqual(['P'])
  })

  it("the summary and goals pick up an in-progress session's words, and books finished stays 0", async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const { workId, editionId } = await bookWith({ format: 'physical', pageCount: 300 })
    const sessionId = await seedSession(t.db, { userId: user.id, workId, editionId, startedOn: '2026-03-01' })
    await seedProgress(t.db, { sessionId, on: '2026-03-04', kind: 'page', value: 120 })

    const summary = await getStatsSummary(t.db, scope, { from: '2026-01-01', to: '2026-12-31' })
    expect(Math.round(summary.totalWords)).toBe(33_000)
    expect(summary.booksFinished).toBe(0)

    await createGoal(t.db, scope, GoalInput.parse({ periodStart: '2026-01-01', periodEnd: '2026-12-31', metric: 'pages', target: 240 }))
    await createGoal(t.db, scope, GoalInput.parse({ periodStart: '2026-01-01', periodEnd: '2026-12-31', metric: 'books', target: 2 }))
    const goals = await listGoals(t.db, scope)
    expect(goals.map((g) => [g.metric, Math.round(g.total)]).sort()).toEqual([
      ['books', 0],
      ['pages', 120],
    ])
  })

  it("a hidden work's progress never reaches stats or the day drill-down", async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const { workId, editionId } = await bookWith({ format: 'physical', pageCount: 300 })
    const sessionId = await seedSession(t.db, { userId: user.id, workId, editionId, startedOn: '2026-03-01' })
    await seedProgress(t.db, { sessionId, on: '2026-03-04', kind: 'page', value: 120 })
    expect(await getSessionsOnDate(t.db, scope, '2026-03-03')).toEqual([{ workId, title: 'P', mode: 'read' }])
    expect(await getSessionsOnDate(t.db, scope, '2026-03-05')).toEqual([])

    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId })
    const hidden = await loadUserScope(t.db, user)
    expect(await getDailyStats(t.db, hidden, { from: '2026-01-01', to: '2026-12-31' })).toEqual([])
    expect(await getSessionsOnDate(t.db, hidden, '2026-03-03')).toEqual([])
  })

  it("another user's progress never reaches this user's stats or drill-down, hidden work or not", async () => {
    const reader = await seedUser(t.db)
    const other = await seedUser(t.db)
    const { workId, editionId } = await bookWith({ format: 'physical', pageCount: 300 })
    const sessionId = await seedSession(t.db, { userId: reader.id, workId, editionId, startedOn: '2026-03-01' })
    await seedProgress(t.db, { sessionId, on: '2026-03-04', kind: 'page', value: 120 })

    const otherScope = await loadUserScope(t.db, other)
    expect(await getDailyStats(t.db, otherScope, { from: '2026-01-01', to: '2026-12-31' })).toEqual([])
    expect(await getSessionsOnDate(t.db, otherScope, '2026-03-03')).toEqual([])

    // the other user has the work hidden: still nothing for them, and the reader keeps their own numbers
    await t.db.insert(userHiddenWorks).values({ userId: other.id, workId })
    expect(await getDailyStats(t.db, await loadUserScope(t.db, other), { from: '2026-01-01', to: '2026-12-31' })).toEqual([])
    expect(await getDailyStats(t.db, await loadUserScope(t.db, reader), { from: '2026-01-01', to: '2026-12-31' })).toHaveLength(4)
  })

  it('a range rebuild with `include` clears the days a removed point used to cover', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const { workId, editionId } = await bookWith({ format: 'physical', pageCount: 300 })
    const sessionId = await seedSession(t.db, { userId: user.id, workId, editionId, startedOn: '2026-03-01' })
    await seedProgress(t.db, { sessionId, on: '2026-03-02', kind: 'page', value: 60 })
    const late = await seedProgress(t.db, { sessionId, on: '2026-03-06', kind: 'page', value: 180 })
    await rebuildDailyStats(t.db, scope)
    expect((await storedDays(user.id)).at(-1)).toBe('2026-03-06')

    await t.db.delete(readingProgress).where(eq(readingProgress.id, late))
    // workIds alone would rebuild only the session's new span (Mar 1–2) and leave Mar 3–6 behind
    await rebuildDailyStats(t.db, scope, { workIds: [workId], include: { from: '2026-03-01', to: '2026-03-06' } })
    expect(await storedDays(user.id)).toEqual(['2026-03-01', '2026-03-02'])
  })

  it('a range rebuild with `include` clears the days a back-dated point no longer covers', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const { workId, editionId } = await bookWith({ format: 'physical', pageCount: 300 })
    const sessionId = await seedSession(t.db, { userId: user.id, workId, editionId, startedOn: '2026-03-01' })
    const point = await seedProgress(t.db, { sessionId, on: '2026-03-06', kind: 'page', value: 180 })
    await rebuildDailyStats(t.db, scope)
    expect(await storedDays(user.id)).toHaveLength(6)

    await t.db.update(readingProgress).set({ occurredOn: '2026-03-03' }).where(eq(readingProgress.id, point))
    await rebuildDailyStats(t.db, scope, { workIds: [workId], include: { from: '2026-03-01', to: '2026-03-06' } })
    expect(await storedDays(user.id)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03'])
    const rows = await t.db.select({ words: dailyStats.words }).from(dailyStats).where(eq(dailyStats.userId, user.id))
    // 180 of 300 pages × 275 words (estimated) = 49,500 words over Mar 1–3
    expect(rows.map((r) => Math.round(r.words))).toEqual([16_500, 16_500, 16_500])
  })

  it('removing the only point of an in-progress session clears its days with `include`', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const { workId, editionId } = await bookWith({ format: 'physical', pageCount: 300 })
    const sessionId = await seedSession(t.db, { userId: user.id, workId, editionId, startedOn: '2026-03-01' })
    const point = await seedProgress(t.db, { sessionId, on: '2026-03-03', kind: 'page', value: 90 })
    await rebuildDailyStats(t.db, scope)
    expect(await storedDays(user.id)).toHaveLength(3)

    await t.db.delete(readingProgress).where(eq(readingProgress.id, point))
    await rebuildDailyStats(t.db, scope, { workIds: [workId], include: { from: '2026-03-01', to: '2026-03-03' } })
    expect(await storedDays(user.id)).toEqual([])
  })
})

describe('rebuildDailyStats for some works only (3b carry-over)', () => {
  const t = useTestDb()
  async function listenedBook(title: string) {
    return createWork(t.db, workInput({ title, series: [], editions: [{ format: 'audiobook', durationSec: 36_000 }] }))
  }
  const listen = (userId: string, workId: string, on: string) => ({ userId, workId, mode: 'listen' as const, startedOn: on, outcome: 'finished' as const, finishedOn: on, fractionCompleted: 1 })

  it("rebuilds only the dates the given works' sessions cover, leaving other days alone", async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const old = await listenedBook('Old Listen')
    const recent = await listenedBook('Recent Listen')
    await seedSession(t.db, listen(user.id, old, '2020-01-10'))
    await seedSession(t.db, listen(user.id, recent, '2024-05-14'))
    await rebuildDailyStats(t.db, scope)
    // a marker the partial rebuild must not touch
    await t.db.update(dailyStats).set({ minutes: 999 }).where(and(eq(dailyStats.userId, user.id), eq(dailyStats.date, '2020-01-10')))

    await seedSession(t.db, listen(user.id, recent, '2024-05-15'))
    await rebuildDailyStats(t.db, scope, { workIds: [recent] })

    const rows = await t.db.select({ date: dailyStats.date, minutes: dailyStats.minutes }).from(dailyStats).where(eq(dailyStats.userId, user.id)).orderBy(dailyStats.date)
    expect(rows).toEqual([
      { date: '2020-01-10', minutes: 999 },
      { date: '2024-05-14', minutes: 600 },
      { date: '2024-05-15', minutes: 600 },
    ])
  })

  it('changes nothing when the given works have no finished session', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const listened = await listenedBook('Listened')
    await seedSession(t.db, listen(user.id, listened, '2024-05-14'))
    await rebuildDailyStats(t.db, scope)
    const before = await t.db.select().from(dailyStats)
    await rebuildDailyStats(t.db, scope, { workIds: [await listenedBook('Never listened')] })
    expect(await t.db.select().from(dailyStats)).toEqual(before)
  })

  /**
   * R12: the marker (an "old" work's day, hand-corrupted to a sentinel a full rebuild would
   * overwrite) proves the partial rebuild leaves other dates alone; comparing the affected dates
   * against a baseline full rebuild (taken before any corruption) proves the partial rebuild
   * produces exactly what a full rebuild would for those dates — for month- and year-precision
   * reads (whose ranges span a whole month/year) and a session crossing a month boundary.
   */
  it('matches a full rebuild for a whole-month-precision session, leaving other days alone', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const old = await listenedBook('Old Listen')
    const monthly = await listenedBook('Monthly Listen')
    await seedSession(t.db, listen(user.id, old, '2018-01-01'))
    await seedSession(t.db, {
      userId: user.id,
      workId: monthly,
      mode: 'listen' as const,
      startedOn: '2024-07-10',
      startedPrecision: 'month',
      outcome: 'finished' as const,
      finishedOn: '2024-07-10',
      finishedPrecision: 'month',
      fractionCompleted: 1,
    })
    await rebuildDailyStats(t.db, scope)
    const baseline = await t.db.select({ date: dailyStats.date, minutes: dailyStats.minutes, words: dailyStats.words, estimated: dailyStats.estimated }).from(dailyStats).where(eq(dailyStats.userId, user.id)).orderBy(dailyStats.date)
    const july = baseline.filter((r) => r.date >= '2024-07-01' && r.date <= '2024-07-31')
    expect(july).toHaveLength(31) // a whole month's range

    // a marker the partial rebuild must not touch
    await t.db.update(dailyStats).set({ minutes: 999 }).where(and(eq(dailyStats.userId, user.id), eq(dailyStats.date, '2018-01-01')))
    await rebuildDailyStats(t.db, scope, { workIds: [monthly] })

    const rows = await t.db.select({ date: dailyStats.date, minutes: dailyStats.minutes, words: dailyStats.words, estimated: dailyStats.estimated }).from(dailyStats).where(eq(dailyStats.userId, user.id)).orderBy(dailyStats.date)
    expect(rows.find((r) => r.date === '2018-01-01')?.minutes).toBe(999) // untouched
    expect(rows.filter((r) => r.date >= '2024-07-01' && r.date <= '2024-07-31')).toEqual(july) // == full rebuild
  })

  it('matches a full rebuild for a whole-year-precision session, leaving other days alone', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const old = await listenedBook('Old Listen')
    const yearly = await listenedBook('Yearly Listen')
    await seedSession(t.db, listen(user.id, old, '2018-01-01'))
    await seedSession(t.db, {
      userId: user.id,
      workId: yearly,
      mode: 'listen' as const,
      startedOn: '2023-06-15',
      startedPrecision: 'year',
      outcome: 'finished' as const,
      finishedOn: '2023-06-15',
      finishedPrecision: 'year',
      fractionCompleted: 1,
    })
    await rebuildDailyStats(t.db, scope)
    const baseline = await t.db.select({ date: dailyStats.date, minutes: dailyStats.minutes, words: dailyStats.words, estimated: dailyStats.estimated }).from(dailyStats).where(eq(dailyStats.userId, user.id)).orderBy(dailyStats.date)
    const year2023 = baseline.filter((r) => r.date >= '2023-01-01' && r.date <= '2023-12-31')
    expect(year2023).toHaveLength(365) // a whole year's range

    await t.db.update(dailyStats).set({ minutes: 999 }).where(and(eq(dailyStats.userId, user.id), eq(dailyStats.date, '2018-01-01')))
    await rebuildDailyStats(t.db, scope, { workIds: [yearly] })

    const rows = await t.db.select({ date: dailyStats.date, minutes: dailyStats.minutes, words: dailyStats.words, estimated: dailyStats.estimated }).from(dailyStats).where(eq(dailyStats.userId, user.id)).orderBy(dailyStats.date)
    expect(rows.find((r) => r.date === '2018-01-01')?.minutes).toBe(999) // untouched
    expect(rows.filter((r) => r.date >= '2023-01-01' && r.date <= '2023-12-31')).toEqual(year2023) // == full rebuild
  })

  it('matches a full rebuild for a session spanning two months, leaving other days alone', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const old = await listenedBook('Old Listen')
    const spanning = await listenedBook('Spanning Listen')
    await seedSession(t.db, listen(user.id, old, '2018-01-01'))
    await seedSession(t.db, {
      userId: user.id,
      workId: spanning,
      mode: 'listen' as const,
      startedOn: '2024-01-25',
      startedPrecision: 'day',
      outcome: 'finished' as const,
      finishedOn: '2024-02-05',
      finishedPrecision: 'day',
      fractionCompleted: 1,
    })
    await rebuildDailyStats(t.db, scope)
    const baseline = await t.db.select({ date: dailyStats.date, minutes: dailyStats.minutes, words: dailyStats.words, estimated: dailyStats.estimated }).from(dailyStats).where(eq(dailyStats.userId, user.id)).orderBy(dailyStats.date)
    const spanRows = baseline.filter((r) => r.date >= '2024-01-25' && r.date <= '2024-02-05')
    expect(spanRows).toHaveLength(12) // Jan 25..31 + Feb 1..5

    await t.db.update(dailyStats).set({ minutes: 999 }).where(and(eq(dailyStats.userId, user.id), eq(dailyStats.date, '2018-01-01')))
    await rebuildDailyStats(t.db, scope, { workIds: [spanning] })

    const rows = await t.db.select({ date: dailyStats.date, minutes: dailyStats.minutes, words: dailyStats.words, estimated: dailyStats.estimated }).from(dailyStats).where(eq(dailyStats.userId, user.id)).orderBy(dailyStats.date)
    expect(rows.find((r) => r.date === '2018-01-01')?.minutes).toBe(999) // untouched
    expect(rows.filter((r) => r.date >= '2024-01-25' && r.date <= '2024-02-05')).toEqual(spanRows) // == full rebuild
  })
})
