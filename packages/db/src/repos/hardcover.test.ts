import { describe, expect, it } from 'vitest'
import { ExternalItem, type HardcoverBookData } from '@mylib/domain'
import { createSecretBox, DEV_SECRET_KEY } from '../secrets'
import { eq } from 'drizzle-orm'
import { hardcoverAccounts, hardcoverBooks, hardcoverPushes, hardcoverRecommendations, readingSessions, sourceItems, sources, userHiddenWorks } from '../schema'
import { seedSession, seedUser, useTestDb, workInput } from '../testing'
import { setRating } from './tracking'
import { createWork } from './catalog'
import { loadUserScope } from './scope'
import { getHardcoverForWork, listMatchCandidates, listStaleHardcoverIds, rejectHardcoverMatch, saveBookData, saveMatch, touchHardcoverBooks, getHardcoverAccount, getHardcoverAccountWithToken, listUserAccountsWithToken, removeHardcoverAccount, saveHardcoverAccount, setHardcoverAccountStatus, setSendFinished, startHardcoverRun, finishHardcoverRun, lastHardcoverRun, saveRecommendations, queueFinishedPushes, listWaitingPushes, markPush, listMyPushes, failRunningHardcoverRuns, notePushError, countMyPushes, countPastPushes, queuePastPushes } from './hardcover'

const box = createSecretBox(DEV_SECRET_KEY)
const NOW = new Date('2026-10-19T10:00:00Z')
const HOUSEHOLD = { kind: 'household' } as const

describe('hardcover accounts', () => {
  const t = useTestDb()

  it('saves the household token sealed, replaces it, and never shows it in the view', async () => {
    await saveHardcoverAccount(t.db, box, HOUSEHOLD, { token: 'token-one-aaaaaaaaaaaaaaaa', hardcoverUserId: 7, username: 'home', now: NOW })
    const [row] = await t.db.select().from(hardcoverAccounts)
    expect(row?.token).not.toContain('token-one')
    const view = await getHardcoverAccount(t.db, HOUSEHOLD)
    expect(view).toMatchObject({ scope: 'household', username: 'home', status: 'ok' })
    expect(view).not.toHaveProperty('token')
    await saveHardcoverAccount(t.db, box, HOUSEHOLD, { token: 'token-two-bbbbbbbbbbbbbbbb', hardcoverUserId: 8, username: 'home2', now: NOW })
    expect(await t.db.select().from(hardcoverAccounts)).toHaveLength(1)
    expect((await getHardcoverAccountWithToken(t.db, box, HOUSEHOLD))?.token).toBe('token-two-bbbbbbbbbbbbbbbb')
  })

  it('keeps each person’s account apart and switches sending on with a start time', async () => {
    const a = await seedUser(t.db)
    const b = await seedUser(t.db)
    await saveHardcoverAccount(t.db, box, { kind: 'user', userId: a.id }, { token: 'token-a-cccccccccccccccccc', hardcoverUserId: 1, username: 'a', now: NOW })
    expect(await getHardcoverAccount(t.db, { kind: 'user', userId: b.id })).toBeNull()
    await setSendFinished(t.db, a.id, true, NOW)
    await setSendFinished(t.db, a.id, true, new Date('2026-10-20T00:00:00Z'))
    const [row] = await t.db.select().from(hardcoverAccounts)
    // turning it on again keeps the first start: books finished in between still go
    expect(row?.sendSince).toEqual(NOW)
    await setSendFinished(t.db, a.id, false, NOW)
    expect((await t.db.select().from(hardcoverAccounts))[0]).toMatchObject({ sendFinished: false, sendSince: null })
    expect((await listUserAccountsWithToken(t.db, box)).map((x) => x.username)).toEqual(['a'])
  })

  it('records a status and removes an account', async () => {
    const view = await saveHardcoverAccount(t.db, box, HOUSEHOLD, { token: 'token-one-aaaaaaaaaaaaaaaa', hardcoverUserId: 7, username: 'home', now: NOW })
    await setHardcoverAccountStatus(t.db, view.id, 'missing_scope', 'read:vibes', NOW)
    expect(await getHardcoverAccount(t.db, HOUSEHOLD)).toMatchObject({ status: 'missing_scope', statusDetail: 'read:vibes' })
    await removeHardcoverAccount(t.db, HOUSEHOLD)
    expect(await getHardcoverAccount(t.db, HOUSEHOLD)).toBeNull()
  })
})

const data = (id: number, similarIds: number[] = []): HardcoverBookData => ({ id, slug: `b-${id}`, title: `B${id}`, rating: 4.2, ratingsCount: 10, tags: { genre: ['Fantasy'], mood: ['dark'] }, similarIds })

describe('hardcover matching and panel data', () => {
  const t = useTestDb()

  it('offers unmatched books with their ISBNs; skips matched, rejected, and none until a week passes', async () => {
    const a = await createWork(t.db, workInput({ title: 'A', authors: ['Ann'], editions: [{ format: 'physical', isbn13: '9780141439518' }] }))
    const b = await createWork(t.db, workInput({ title: 'B', authors: ['Bo'] }))
    const c = await createWork(t.db, workInput({ title: 'C' }))
    expect((await listMatchCandidates(t.db, NOW, 10)).map((m) => [m.title, m.isbns])).toEqual([
      ['A', ['9780141439518']],
      ['B', []],
      ['C', []],
    ])
    await saveMatch(t.db, a, { kind: 'isbn', book: data(1) }, NOW)
    await saveMatch(t.db, b, { kind: 'none' }, NOW)
    await t.db.insert(hardcoverBooks).values({ workId: c, match: 'rejected' })
    expect(await listMatchCandidates(t.db, NOW, 10)).toEqual([])
    const weekLater = new Date(NOW.getTime() + 7 * 86_400_000)
    expect((await listMatchCandidates(t.db, weekLater, 10)).map((m) => m.title)).toEqual(['B'])
  })

  it('carries the work’s series names', async () => {
    await createWork(t.db, workInput({ title: 'The Final Empire', series: [{ name: 'Mistborn', position: 1 }] }))
    await createWork(t.db, workInput({ title: 'Standalone', series: [] }))
    expect((await listMatchCandidates(t.db, NOW, 10)).map((m) => [m.title, m.series])).toEqual([
      ['The Final Empire', ['Mistborn']],
      ['Standalone', []],
    ])
  })

  it('carries the Open Library id of a linked source item', async () => {
    const w = await createWork(t.db, workInput({ title: 'ספר' }))
    const [source] = await t.db.insert(sources).values({ kind: 'shelf', name: 'Shelf', config: { kind: 'shelf' }, schedule: null }).returning({ id: sources.id })
    const normalized = ExternalItem.parse({ externalId: 'x1', format: 'physical', title: 'ספר', identifiers: { others: { openlibrary: 'OL45W' } } })
    await t.db.insert(sourceItems).values({ sourceId: source?.id ?? '', externalId: 'x1', normalized, contentHash: 'h', workId: w, state: 'linked' })
    expect((await listMatchCandidates(t.db, NOW, 10)).map((m) => m.openLibraryId)).toEqual(['OL45W'])
  })

  it('refreshes stale data on every work sharing a Hardcover book', async () => {
    const a = await createWork(t.db, workInput({ title: 'A' }))
    const a2 = await createWork(t.db, workInput({ title: 'A again' }))
    await saveMatch(t.db, a, { kind: 'isbn', book: data(1) }, NOW)
    await saveMatch(t.db, a2, { kind: 'isbn', book: data(1) }, NOW)
    expect(await listStaleHardcoverIds(t.db, NOW, 10)).toEqual([])
    const later = new Date(NOW.getTime() + 8 * 86_400_000)
    expect(await listStaleHardcoverIds(t.db, later, 10)).toEqual([1])
    await saveBookData(t.db, { ...data(1), rating: 3.1 }, later)
    expect((await t.db.select().from(hardcoverBooks)).map((r) => r.rating)).toEqual([3.1, 3.1])
    const evenLater = new Date(later.getTime() + 8 * 86_400_000)
    await touchHardcoverBooks(t.db, [1], evenLater)
    expect(await listStaleHardcoverIds(t.db, evenLater, 10)).toEqual([])
    expect((await t.db.select().from(hardcoverBooks)).map((r) => r.slug)).toEqual(['b-1', 'b-1'])
  })

  it('panel: rating, tags and up to 6 similar books the viewer can see, in Hardcover order', async () => {
    const admin = await seedUser(t.db, { role: 'admin' })
    const member = await seedUser(t.db, { role: 'member' })
    const scope = await loadUserScope(t.db, admin)
    const main = await createWork(t.db, workInput({ title: 'Main' }))
    const ids: string[] = []
    for (let i = 2; i <= 9; i++) {
      const id = await createWork(t.db, workInput({ title: `S${i}` }))
      ids.push(id)
      await saveMatch(t.db, id, { kind: 'isbn', book: data(i) }, NOW)
    }
    await saveMatch(t.db, main, { kind: 'isbn', book: data(1, [9, 404, 3, 2, 4, 5, 6, 7, 8]) }, NOW)
    const view = await getHardcoverForWork(t.db, scope, main)
    expect(view).toMatchObject({ match: 'isbn', hardcoverId: 1, slug: 'b-1', rating: 4.2, ratingsCount: 10, tags: { genre: ['Fantasy'], mood: ['dark'] } })
    expect(view?.similar.map((w) => w.title)).toEqual(['S9', 'S3', 'S2', 'S4', 'S5', 'S6'])
    await t.db.insert(userHiddenWorks).values({ userId: member.id, workId: ids[7] ?? '' })
    const memberView = await getHardcoverForWork(t.db, await loadUserScope(t.db, member), main)
    expect(memberView?.similar.map((w) => w.title)).toEqual(['S3', 'S2', 'S4', 'S5', 'S6', 'S7'])
  })

  it('panel: no row is null; Not this book leaves a rejected row that is never offered again', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const w = await createWork(t.db, workInput({ title: 'W' }))
    expect(await getHardcoverForWork(t.db, scope, w)).toBeNull()
    await saveMatch(t.db, w, { kind: 'title', book: data(1) }, NOW)
    await rejectHardcoverMatch(t.db, scope, w)
    expect(await getHardcoverForWork(t.db, scope, w)).toMatchObject({ match: 'rejected', rating: null, similar: [] })
    expect(await listMatchCandidates(t.db, new Date('2030-01-01'), 10)).toEqual([])
  })
})

describe('hardcover runs, recommendations and sends', () => {
  const t = useTestDb()

  it('allows one running run per kind', async () => {
    const first = await startHardcoverRun(t.db, { kind: 'refresh', trigger: 'manual', requestedBy: null })
    expect(first).not.toBeNull()
    expect(await startHardcoverRun(t.db, { kind: 'refresh', trigger: 'schedule', requestedBy: null })).toBeNull()
    expect(await startHardcoverRun(t.db, { kind: 'send', trigger: 'schedule', requestedBy: null })).not.toBeNull()
    await finishHardcoverRun(t.db, first ?? '', { status: 'succeeded', stats: { matched: 2 }, error: null })
    expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'succeeded', stats: { matched: 2 } })
  })

  it('queues only books finished since sending was turned on, once each, and carries the rating', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const account = await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: 'token-a-cccccccccccccccccc', hardcoverUserId: 1, username: 'a', now: NOW })
    const before = await createWork(t.db, workInput({ title: 'Before' }))
    const after = await createWork(t.db, workInput({ title: 'After' }))
    const reading = await createWork(t.db, workInput({ title: 'Reading' }))
    const beforeSession = await seedSession(t.db, { userId: user.id, workId: before, startedOn: '2026-01-01', outcome: 'finished', finishedOn: '2026-01-10' })
    await t.db.update(readingSessions).set({ updatedAt: new Date('2026-01-10') }).where(eq(readingSessions.id, beforeSession))
    await setSendFinished(t.db, user.id, true, new Date())
    const today = new Date().toISOString().slice(0, 10)
    await seedSession(t.db, { userId: user.id, workId: after, startedOn: '2026-10-01', outcome: 'finished', finishedOn: today })
    await seedSession(t.db, { userId: user.id, workId: reading, startedOn: '2026-10-01' })
    await setRating(t.db, scope, after, 4.5)
    await saveMatch(t.db, after, { kind: 'isbn', book: data(7) }, NOW)
    expect(await queueFinishedPushes(t.db)).toBe(1)
    expect(await queueFinishedPushes(t.db)).toBe(0)
    expect(await listWaitingPushes(t.db, 10)).toEqual([{ accountId: account.id, userId: user.id, workId: after, hardcoverId: 7, finishedOn: today, rating: 4.5 }])
    await markPush(t.db, account.id, after, 'sent', null, NOW)
    expect(await listWaitingPushes(t.db, 10)).toEqual([])
    expect((await listMyPushes(t.db, { userId: user.id, languages: ['en', 'he'] }, 10)).map((p) => [p.title, p.status])).toEqual([['After', 'sent']])
  })

  it('fails every run left running, so the kind can start again (C1)', async () => {
    expect(await startHardcoverRun(t.db, { kind: 'refresh', trigger: 'schedule', requestedBy: null })).not.toBeNull()
    expect(await startHardcoverRun(t.db, { kind: 'send', trigger: 'schedule', requestedBy: null })).not.toBeNull()
    expect(await failRunningHardcoverRuns(t.db, 'The worker restarted')).toBe(2)
    expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'failed', error: 'The worker restarted' })
    expect((await lastHardcoverRun(t.db, 'refresh'))?.finishedAt).not.toBeNull()
    expect(await failRunningHardcoverRuns(t.db, 'again')).toBe(0)
    expect(await startHardcoverRun(t.db, { kind: 'refresh', trigger: 'schedule', requestedBy: null })).not.toBeNull()
  })

  it('does not queue a past read added or edited after sending was turned on (I1, no backfill)', async () => {
    const user = await seedUser(t.db)
    await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: 'token-a-cccccccccccccccccc', hardcoverUserId: 1, username: 'a', now: NOW })
    const old = await createWork(t.db, workInput({ title: 'Old' }))
    const fresh = await createWork(t.db, workInput({ title: 'Fresh' }))
    await setSendFinished(t.db, user.id, true, new Date())
    await seedSession(t.db, { userId: user.id, workId: old, startedOn: '2019-01-01', outcome: 'finished', finishedOn: '2019-02-01' })
    await seedSession(t.db, { userId: user.id, workId: fresh, startedOn: '2026-10-01', outcome: 'finished', finishedOn: new Date().toISOString().slice(0, 10) })
    expect(await queueFinishedPushes(t.db)).toBe(1)
    expect((await listMyPushes(t.db, { userId: user.id, languages: ['en', 'he'] }, 10)).map((p) => p.title)).toEqual(['Fresh'])
  })

  it('does not queue a read finished on an unknown date, even one entered after sending was turned on (#152)', async () => {
    const user = await seedUser(t.db)
    await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: 'token-a-cccccccccccccccccc', hardcoverUserId: 1, username: 'a', now: NOW })
    const old = await createWork(t.db, workInput({ title: 'Long ago' }))
    await setSendFinished(t.db, user.id, true, new Date())
    const today = new Date().toISOString().slice(0, 10)
    await seedSession(t.db, { userId: user.id, workId: old, startedOn: today, startedPrecision: 'unknown', outcome: 'finished', finishedOn: today, finishedPrecision: 'unknown' })
    expect(await queueFinishedPushes(t.db)).toBe(0)
  })

  it('queues past reads on request: one per book (latest finish), matched counted, existing rows kept, repeatable (#140)', async () => {
    const user = await seedUser(t.db)
    const other = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const account = await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: 'token-a-cccccccccccccccccc', hardcoverUserId: 1, username: 'a', now: NOW })
    const twice = await createWork(t.db, workInput({ title: 'Twice' }))
    const unmatched = await createWork(t.db, workInput({ title: 'Unmatched' }))
    const reading = await createWork(t.db, workInput({ title: 'Reading' }))
    const sent = await createWork(t.db, workInput({ title: 'Sent' }))
    await seedSession(t.db, { userId: user.id, workId: twice, startedOn: '2019-01-01', outcome: 'finished', finishedOn: '2019-02-01' })
    await seedSession(t.db, { userId: user.id, workId: twice, startedOn: '2023-01-01', outcome: 'finished', finishedOn: '2023-02-01' })
    await seedSession(t.db, { userId: user.id, workId: unmatched, startedOn: '2020-01-01', outcome: 'finished', finishedOn: '2020-02-01' })
    await seedSession(t.db, { userId: user.id, workId: reading, startedOn: '2026-10-01' })
    await seedSession(t.db, { userId: user.id, workId: sent, startedOn: '2021-01-01', outcome: 'finished', finishedOn: '2021-02-01' })
    await seedSession(t.db, { userId: other.id, workId: unmatched, startedOn: '2020-01-01', outcome: 'finished', finishedOn: '2020-03-01' })
    await setRating(t.db, scope, twice, 4)
    for (const [w, id] of [[twice, 1], [sent, 2]] as const) await saveMatch(t.db, w, { kind: 'isbn', book: data(id) }, NOW)
    // sending off: nothing to offer
    expect(await countPastPushes(t.db, user.id)).toEqual({ total: 0, matched: 0 })
    expect(await queuePastPushes(t.db, user.id)).toBe(0)
    await setSendFinished(t.db, user.id, true, NOW)
    await t.db.insert(hardcoverPushes).values({ accountId: account.id, workId: sent, finishedOn: '2021-02-01', status: 'sent' })
    expect(await countPastPushes(t.db, user.id)).toEqual({ total: 2, matched: 1 })
    expect(await queuePastPushes(t.db, user.id)).toBe(2)
    expect(await queuePastPushes(t.db, user.id)).toBe(0)
    expect(await countPastPushes(t.db, user.id)).toEqual({ total: 0, matched: 0 })
    // the unmatched book waits for a match; the sent row is untouched
    expect(await listWaitingPushes(t.db, 10)).toEqual([{ accountId: account.id, userId: user.id, workId: twice, hardcoverId: 1, finishedOn: '2023-02-01', rating: 4 }])
    expect(await countMyPushes(t.db, user.id)).toEqual({ waiting: 2, sent: 1, skipped: 0 })
    expect(await countMyPushes(t.db, other.id)).toEqual({ waiting: 0, sent: 0, skipped: 0 })
  })

  it('notePushError stores the reason and the row stays waiting (I2b)', async () => {
    const user = await seedUser(t.db)
    const account = await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: 'token-a-cccccccccccccccccc', hardcoverUserId: 1, username: 'a', now: NOW })
    const w = await createWork(t.db, workInput({ title: 'W' }))
    await saveMatch(t.db, w, { kind: 'isbn', book: data(9) }, NOW)
    await setSendFinished(t.db, user.id, true, new Date('2026-01-01'))
    await seedSession(t.db, { userId: user.id, workId: w, startedOn: '2026-10-01', outcome: 'finished', finishedOn: '2026-10-18' })
    await queueFinishedPushes(t.db)
    await notePushError(t.db, account.id, w, 'Hardcover answered 400')
    expect(await listWaitingPushes(t.db, 10)).toHaveLength(1)
    expect((await listMyPushes(t.db, { userId: user.id, languages: ['en', 'he'] }, 10))[0]).toMatchObject({ status: 'waiting', reason: 'Hardcover answered 400' })
  })

  it('nobody with sending off gets rows; recommendations replace the last list', async () => {
    const user = await seedUser(t.db)
    const account = await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: 'token-a-cccccccccccccccccc', hardcoverUserId: 1, username: 'a', now: NOW })
    const w = await createWork(t.db, workInput({ title: 'W' }))
    await seedSession(t.db, { userId: user.id, workId: w, startedOn: '2026-10-01', outcome: 'finished', finishedOn: '2026-10-18' })
    expect(await queueFinishedPushes(t.db)).toBe(0)
    await saveRecommendations(t.db, account.id, [3, 2], NOW)
    await saveRecommendations(t.db, account.id, [5], NOW)
    expect((await t.db.select().from(hardcoverRecommendations)).map((r) => r.hardcoverIds)).toEqual([[5]])
  })

  it('lists only pushes whose book is matched, so unmatched ones never fill the page', async () => {
    const user = await seedUser(t.db)
    const account = await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: 'token-a-cccccccccccccccccc', hardcoverUserId: 1, username: 'a', now: NOW })
    const older = await createWork(t.db, workInput({ title: 'Older' }))
    const newer = await createWork(t.db, workInput({ title: 'Newer' }))
    await saveMatch(t.db, older, { kind: 'none' }, NOW)
    await saveMatch(t.db, newer, { kind: 'isbn', book: data(9) }, NOW)
    await setSendFinished(t.db, user.id, true, new Date('2026-01-01'))
    await seedSession(t.db, { userId: user.id, workId: older, startedOn: '2026-10-01', outcome: 'finished', finishedOn: '2026-10-17' })
    await queueFinishedPushes(t.db)
    await seedSession(t.db, { userId: user.id, workId: newer, startedOn: '2026-10-01', outcome: 'finished', finishedOn: '2026-10-18' })
    await queueFinishedPushes(t.db)
    expect((await listWaitingPushes(t.db, 1)).map((p) => [p.accountId, p.workId, p.hardcoverId])).toEqual([[account.id, newer, 9]])
  })

  it('does not list the pushes of an account that is not ok', async () => {
    const user = await seedUser(t.db)
    const account = await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: 'token-a-cccccccccccccccccc', hardcoverUserId: 1, username: 'a', now: NOW })
    const w = await createWork(t.db, workInput({ title: 'W' }))
    await saveMatch(t.db, w, { kind: 'isbn', book: data(9) }, NOW)
    await setSendFinished(t.db, user.id, true, new Date('2026-01-01'))
    await seedSession(t.db, { userId: user.id, workId: w, startedOn: '2026-10-01', outcome: 'finished', finishedOn: '2026-10-18' })
    await queueFinishedPushes(t.db)
    expect(await listWaitingPushes(t.db, 10)).toHaveLength(1)
    await setHardcoverAccountStatus(t.db, account.id, 'needs_token', 'bad', NOW)
    expect(await listWaitingPushes(t.db, 10)).toEqual([])
  })
})
