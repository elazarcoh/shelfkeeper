import { describe, expect, it } from 'vitest'
import { createHardcoverClient, type PostLike } from '@mylib/connectors'
import { hardcoverFixturePost, type HardcoverFixtures } from '@mylib/connectors/testing'
import { createSecretBox, createWork, DEV_SECRET_KEY, getHardcoverAccount, hardcoverAuthors, hardcoverBooks, hardcoverExternalBooks, hardcoverMissingBooks, hardcoverReads, hardcoverSeries, loadUserScope, saveMatch, setStatus, hardcoverPushes, hardcoverRecommendations, lastHardcoverRun, saveHardcoverAccount, setHardcoverAccountStatus, setSendFinished, sourceItems, sources } from '@mylib/db'
import { ExternalItem } from '@mylib/domain'
import { seedSession, seedUser, useTestDb, workInput } from '@mylib/db/testing'
import { runHardcoverJob, type HardcoverDeps } from './run-hardcover'

const box = createSecretBox(DEV_SECRET_KEY)
const HOUSE = 'house-token-aaaaaaaaaaaaaaaa'
const MINE = 'mine-token-bbbbbbbbbbbbbbbbb'
const NOW = new Date('2026-10-19T03:00:00Z')
const book = (id: number, title: string, similar: number[] = []) => ({ id, slug: `b-${id}`, title, rating: 4, ratings_count: 5, cached_tags: {}, cached_similar_book_ids: similar })

describe('runHardcoverJob', () => {
  const t = useTestDb()
  function deps(
    fixtures: Partial<HardcoverFixtures> & { personal?: Partial<HardcoverFixtures> },
    budget?: number,
    openLibrary: Record<string, { title: string; authors: string[] }> = {},
  ): HardcoverDeps & { posts: ReturnType<typeof hardcoverFixturePost>[] } {
    const house = hardcoverFixturePost({ token: HOUSE, ...fixtures })
    const mine = hardcoverFixturePost({ token: MINE, ...fixtures.personal })
    return {
      db: t.db,
      box,
      client: (token) => createHardcoverClient({ token, post: token === HOUSE ? house : mine, sleep: () => Promise.resolve() }),
      openLibraryWork: (id) => Promise.resolve(openLibrary[id] ?? null),
      now: () => NOW,
      log: () => undefined,
      ...(budget === undefined ? {} : { budget }),
      posts: [house, mine],
    }
  }
  const refresh = { kind: 'refresh', trigger: 'manual', requestedBy: null } as const
  const send = { kind: 'send', trigger: 'schedule', requestedBy: null } as const

  it('does nothing without a household token', async () => {
    await createWork(t.db, workInput({ title: 'A' }))
    expect(await runHardcoverJob(deps({}), refresh)).toBe('skipped')
  })

  it('matches by ISBN, then by exact title and author, else none; stores data and recommendations', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    const user = await seedUser(t.db)
    await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: MINE, hardcoverUserId: 42, username: 'me', now: NOW })
    const byIsbn = await createWork(t.db, workInput({ title: 'Pride', authors: ['Jane Austen'], editions: [{ format: 'physical', isbn13: '9780141439518' }] }))
    const byTitle = await createWork(t.db, workInput({ title: 'Cities', authors: ['Charles Dickens'] }))
    const nearMiss = await createWork(t.db, workInput({ title: 'Cities', authors: ['Someone Else'] }))
    const d = deps({
      editions: [{ isbn_13: '9780141439518', isbn_10: null, book_id: 1 }],
      search: [{ id: '2', title: 'Cities', author_names: ['Charles Dickens'] }],
      books: { 1: book(1, 'Pride', [2]), 2: book(2, 'Cities') },
      personal: { vibes: [2, 1] },
    })
    expect(await runHardcoverJob(d, refresh)).toBe('done')
    const rows = await t.db.select().from(hardcoverBooks)
    const byWork = new Map(rows.map((r) => [r.workId, r]))
    expect(byWork.get(byIsbn)).toMatchObject({ match: 'isbn', hardcoverId: 1, similarIds: [2] })
    expect(byWork.get(byTitle)).toMatchObject({ match: 'title', hardcoverId: 2 })
    expect(byWork.get(nearMiss)).toMatchObject({ match: 'none', hardcoverId: null })
    expect((await t.db.select().from(hardcoverRecommendations))[0]?.hardcoverIds).toEqual([2, 1])
    expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'succeeded', stats: { matched: 2, unmatched: 1 } })
  })

  it('searches by title alone and matches a series-prefixed Hardcover title', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    const w = await createWork(t.db, workInput({ title: 'The Final Empire', authors: ['Brandon Sanderson'], series: [{ name: 'Mistborn', position: 1 }] }))
    const d = deps({
      search: [{ id: '7', title: 'Mistborn: The Final Empire', author_names: ['Brandon Sanderson'] }],
      books: { 7: book(7, 'Mistborn: The Final Empire') },
    })
    await runHardcoverJob(d, refresh)
    expect((await t.db.select().from(hardcoverBooks)).find((r) => r.workId === w)).toMatchObject({ match: 'title', hardcoverId: 7 })
    const searches = d.posts.flatMap((p) => p.calls).filter((c) => /SearchBooks/.test(c.query))
    expect(searches.map((c) => c.variables)).toEqual([{ q: 'The Final Empire' }])
  })

  it('matches a Hebrew book through its Open Library work’s English title; an unreadable work falls back to its own title', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    const [source] = await t.db.insert(sources).values({ kind: 'shelf', name: 'Shelf', config: { kind: 'shelf' }, schedule: null }).returning({ id: sources.id })
    const linkOl = async (workId: string, olId: string) => {
      const normalized = ExternalItem.parse({ externalId: olId, format: 'physical', title: 'x', identifiers: { others: { openlibrary: olId } } })
      await t.db.insert(sourceItems).values({ sourceId: source?.id ?? '', externalId: olId, normalized, contentHash: olId, workId, state: 'linked' })
    }
    const hebrew = await createWork(t.db, workInput({ title: 'האימפריה האחרונה', authors: ['ברנדון סנדרסון'] }))
    const broken = await createWork(t.db, workInput({ title: 'Cities', authors: ['Charles Dickens'] }))
    await linkOl(hebrew, 'OL45W')
    await linkOl(broken, 'OL99W')
    const d = deps(
      {
        search: [
          { id: '7', title: 'The Final Empire', author_names: ['Brandon Sanderson'] },
          { id: '2', title: 'Cities', author_names: ['Charles Dickens'] },
        ],
        books: { 7: book(7, 'The Final Empire'), 2: book(2, 'Cities') },
      },
      undefined,
      { OL45W: { title: 'The Final Empire', authors: ['Brandon Sanderson'] } },
    )
    await runHardcoverJob(d, refresh)
    const byWork = new Map((await t.db.select().from(hardcoverBooks)).map((r) => [r.workId, r]))
    expect(byWork.get(hebrew)).toMatchObject({ match: 'openlibrary', hardcoverId: 7 })
    expect(byWork.get(broken)).toMatchObject({ match: 'title', hardcoverId: 2 })
  })

  it('a 401 stops the run and marks the account; the rest stay unchecked', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    await createWork(t.db, workInput({ title: 'A', editions: [{ format: 'physical', isbn13: '9780141439518' }] }))
    expect(await runHardcoverJob(deps({ status: 401, body: { error: 'invalid_token' } }), refresh)).toBe('done')
    expect(await getHardcoverAccount(t.db, { kind: 'household' })).toMatchObject({ status: 'needs_token' })
    expect(await t.db.select().from(hardcoverBooks)).toEqual([])
    expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'failed' })
  })

  it('stops at the request budget and leaves the rest for the next run', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    for (const title of ['A', 'B', 'C']) await createWork(t.db, workInput({ title }))
    expect(await runHardcoverJob(deps({}, 2), refresh)).toBe('done')
    // progress made before the stop is kept: two searched and saved, the third left for the next run
    expect(await t.db.select().from(hardcoverBooks)).toHaveLength(2)
    expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'stopped' })
  })

  it('counts every page of a Read list against the request budget', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    for (const id of [42, 43]) {
      const user = await seedUser(t.db)
      await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: MINE, hardcoverUserId: id, username: `me${String(id)}`, now: NOW })
    }
    // recommendations (1 request) and a 3-page Read list (3 requests) use the whole budget of 4: the second person waits for the next run
    const reads = Array.from({ length: 1200 }, (_, i) => i + 1)
    expect(await runHardcoverJob(deps({ personal: { vibes: [1], readBookIds: reads } }, 4), refresh)).toBe('done')
    expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'stopped' })
    expect(await t.db.select().from(hardcoverReads)).toHaveLength(1)
  })

  it('sends a finished book add-only: new entry sent; already Read skipped; unmatched waits', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    const user = await seedUser(t.db)
    await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: MINE, hardcoverUserId: 42, username: 'me', now: NOW })
    await setSendFinished(t.db, user.id, true, new Date('2026-01-01T00:00:00Z'))
    const fresh = await createWork(t.db, workInput({ title: 'Fresh' }))
    const known = await createWork(t.db, workInput({ title: 'Known' }))
    const loose = await createWork(t.db, workInput({ title: 'Loose' }))
    await t.db.insert(hardcoverBooks).values([
      { workId: fresh, match: 'isbn', hardcoverId: 1 },
      { workId: known, match: 'isbn', hardcoverId: 2 },
    ])
    for (const w of [fresh, known, loose]) await seedSession(t.db, { userId: user.id, workId: w, startedOn: '2026-10-01', outcome: 'finished', finishedOn: '2026-10-18' })
    const d = deps({ personal: { userBooks: [{ id: 9, book_id: 2, status_id: 3, rating: 5 }] } })
    expect(await runHardcoverJob(d, send)).toBe('done')
    const pushes = new Map((await t.db.select().from(hardcoverPushes)).map((p) => [p.workId, p]))
    expect(pushes.get(fresh)).toMatchObject({ status: 'sent' })
    expect(pushes.get(known)).toMatchObject({ status: 'skipped', reason: 'Already Read on Hardcover' })
    expect(pushes.get(loose)).toMatchObject({ status: 'waiting' })
    const mineCalls = d.posts[1]?.calls.map((c) => /(?:query|mutation) (\w+)/.exec(c.query)?.[1])
    // the waiting rows share one created_at, so their order is not fixed: count the calls instead
    expect([...(mineCalls ?? [])].sort()).toEqual(['InsertRead', 'InsertUserBook', 'UserBook', 'UserBook'])
  })

  it('a person who turned sending off gets their waiting rows skipped', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    const user = await seedUser(t.db)
    const account = await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: MINE, hardcoverUserId: 42, username: 'me', now: NOW })
    const w = await createWork(t.db, workInput({ title: 'W' }))
    // listWaitingPushes only lists pushes whose work is matched, so the work has a Hardcover book
    await t.db.insert(hardcoverBooks).values({ workId: w, match: 'isbn', hardcoverId: 1 })
    await t.db.insert(hardcoverPushes).values({ accountId: account.id, workId: w, finishedOn: '2026-10-18' })
    await runHardcoverJob(deps({}), send)
    expect((await t.db.select().from(hardcoverPushes))[0]).toMatchObject({ status: 'skipped', reason: 'Sending turned off' })
  })

  async function finishedFor(userId: string, title: string, hardcoverId: number) {
    const w = await createWork(t.db, workInput({ title }))
    await t.db.insert(hardcoverBooks).values({ workId: w, match: 'isbn', hardcoverId })
    await seedSession(t.db, { userId, workId: w, startedOn: '2026-10-01', outcome: 'finished', finishedOn: '2026-10-18' })
    return w
  }

  it('keeps the waiting rows of a broken account, and sends them once the account is ok again', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    const user = await seedUser(t.db)
    const account = await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: MINE, hardcoverUserId: 42, username: 'me', now: NOW })
    await setSendFinished(t.db, user.id, true, new Date('2026-01-01T00:00:00Z'))
    const w = await finishedFor(user.id, 'Kept', 1)
    await t.db.insert(hardcoverPushes).values({ accountId: account.id, workId: w, finishedOn: '2026-10-18' })
    await setHardcoverAccountStatus(t.db, account.id, 'needs_token', 'bad token', NOW)
    await runHardcoverJob(deps({}), send)
    expect((await t.db.select().from(hardcoverPushes))[0]).toMatchObject({ workId: w, status: 'waiting' })
    await setHardcoverAccountStatus(t.db, account.id, 'ok', null, NOW)
    await runHardcoverJob(deps({}), send)
    expect((await t.db.select().from(hardcoverPushes))[0]).toMatchObject({ workId: w, status: 'sent' })
  })

  it('one person’s 401 does not stop the others from being sent', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    const a = await seedUser(t.db)
    const b = await seedUser(t.db)
    await saveHardcoverAccount(t.db, box, { kind: 'user', userId: a.id }, { token: 'token-a-aaaaaaaaaaaaaaaaaa', hardcoverUserId: 10, username: 'a', now: NOW })
    await saveHardcoverAccount(t.db, box, { kind: 'user', userId: b.id }, { token: MINE, hardcoverUserId: 11, username: 'b', now: NOW })
    for (const u of [a, b]) await setSendFinished(t.db, u.id, true, new Date('2026-01-01T00:00:00Z'))
    const wa = await finishedFor(a.id, 'ForA', 1)
    const wb = await finishedFor(b.id, 'ForB', 2)
    const bad = hardcoverFixturePost({ token: 'token-a-aaaaaaaaaaaaaaaaaa', status: 401, body: { error: 'invalid_token' } })
    const good = hardcoverFixturePost({ token: MINE })
    const d: HardcoverDeps = { ...deps({}), client: (token) => createHardcoverClient({ token, post: token === MINE ? good : bad, sleep: () => Promise.resolve() }) }
    expect(await runHardcoverJob(d, send)).toBe('done')
    const pushes = new Map((await t.db.select().from(hardcoverPushes)).map((p) => [p.workId, p]))
    expect(pushes.get(wa)).toMatchObject({ status: 'waiting' })
    expect(pushes.get(wb)).toMatchObject({ status: 'sent' })
    expect(await getHardcoverAccount(t.db, { kind: 'user', userId: a.id })).toMatchObject({ status: 'needs_token' })
  })

  /** a post that answers `fail` queries with a GraphQL error and everything else from the fixture */
  const failing =
    (fixture: PostLike, fail: (query: string, variables: Record<string, unknown>) => boolean): PostLike =>
    (url, init) => {
      const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }
      return fail(query, variables) ? Promise.resolve(new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 200 })) : fixture(url, init)
    }

  it('one bad search reply skips that book for a week; the run goes on and the others are matched (I2a)', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    const bad = await createWork(t.db, workInput({ title: 'A Bad', authors: ['Ann Author'] }))
    const good = await createWork(t.db, workInput({ title: 'B Good', authors: ['Bob Author'] }))
    const house = failing(
      hardcoverFixturePost({ token: HOUSE, search: [{ id: '2', title: 'B Good', author_names: ['Bob Author'] }], books: { 2: book(2, 'B Good') } }),
      (q, v) => /SearchBooks/.test(q) && v['q'] === 'A Bad',
    )
    const d: HardcoverDeps = { ...deps({}), client: (token) => createHardcoverClient({ token, post: house, sleep: () => Promise.resolve() }) }
    expect(await runHardcoverJob(d, refresh)).toBe('done')
    const byWork = new Map((await t.db.select().from(hardcoverBooks)).map((r) => [r.workId, r]))
    expect(byWork.get(bad)).toMatchObject({ match: 'none' })
    expect(byWork.get(bad)?.nextCheckAt?.getTime()).toBe(NOW.getTime() + 7 * 86_400_000)
    expect(byWork.get(good)).toMatchObject({ match: 'title', hardcoverId: 2 })
    expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'succeeded', stats: { failed: 1, matched: 1 } })
  })

  it('a failed send is counted, logged and noted on the row, which stays waiting (I2b)', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    const user = await seedUser(t.db)
    await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: MINE, hardcoverUserId: 42, username: 'me', now: NOW })
    await setSendFinished(t.db, user.id, true, new Date('2026-01-01T00:00:00Z'))
    const w = await finishedFor(user.id, 'Odd', 1)
    const mine = failing(hardcoverFixturePost({ token: MINE }), (q) => /InsertUserBook/.test(q))
    const lines: string[] = []
    const d: HardcoverDeps = { ...deps({}), log: (l) => lines.push(l), client: (token) => createHardcoverClient({ token, post: mine, sleep: () => Promise.resolve() }) }
    expect(await runHardcoverJob(d, send)).toBe('done')
    expect((await t.db.select().from(hardcoverPushes))[0]).toMatchObject({ workId: w, status: 'waiting', reason: 'boom' })
    expect(await lastHardcoverRun(t.db, 'send')).toMatchObject({ status: 'succeeded', stats: { failed: 1 } })
    expect(lines.join('\n')).toContain('boom')
  })

  it('after a 401 for an account, its remaining pushes are skipped this run (M3)', async () => {
    await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
    const user = await seedUser(t.db)
    await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: MINE, hardcoverUserId: 42, username: 'me', now: NOW })
    await setSendFinished(t.db, user.id, true, new Date('2026-01-01T00:00:00Z'))
    await finishedFor(user.id, 'One', 1)
    await finishedFor(user.id, 'Two', 2)
    await finishedFor(user.id, 'Three', 3)
    const bad = hardcoverFixturePost({ token: MINE, status: 401, body: { error: 'invalid_token' } })
    const d: HardcoverDeps = { ...deps({}), client: (token) => createHardcoverClient({ token, post: bad, sleep: () => Promise.resolve() }) }
    await runHardcoverJob(d, send)
    expect(bad.calls).toHaveLength(1)
    expect((await t.db.select().from(hardcoverPushes)).every((p) => p.status === 'waiting')).toBe(true)
  })

  describe('explore (what next)', () => {
    const detail = (id: number, extra: Record<string, unknown> = {}) => ({
      id,
      title: `Book ${id}`,
      pages: 300,
      release_date: '2026-01-01',
      cached_image: null,
      cached_contributors: [{ author: { id: 77, name: 'Ann' }, contribution: 'Author' }],
      cached_tags: {},
      book_series: [],
      editions: [],
      ...extra,
    })
    const seriesRow = (id: number, position: number) => ({ series_id: 500, position, series: { name: 'Mistborn' }, book: { id, title: `Book ${id}`, release_date: '2026-01-01', users_count: 1, compilation: false } })
    const contribution = (id: number) => ({ author_id: 77, contribution: 'Author', book: { id, title: `Book ${id}`, release_date: '2026-01-01', compilation: false } })

    /** A member who read Mistborn 1 (Hardcover 11) and two more books by Ann (12, 13): one series, one favorite author. */
    async function member() {
      await saveHardcoverAccount(t.db, box, { kind: 'household' }, { token: HOUSE, hardcoverUserId: 1, username: 'home', now: NOW })
      const user = await seedUser(t.db)
      await saveHardcoverAccount(t.db, box, { kind: 'user', userId: user.id }, { token: MINE, hardcoverUserId: 42, username: 'me', now: NOW })
      const scope = await loadUserScope(t.db, user)
      for (const [id, series] of [[11, [{ name: 'Mistborn', position: 1 }]], [12, []], [13, []]] as const) {
        const w = await createWork(t.db, workInput({ title: `W${id}`, authors: ['Ann'], series: [...series] }))
        await saveMatch(t.db, w, { kind: 'isbn', book: { id, slug: `b-${id}`, title: `W${id}`, rating: 4, ratingsCount: 1, tags: { genre: [], mood: [] }, similarIds: [] } }, NOW)
        await setStatus(t.db, scope, w, 'read')
      }
    }
    const fixtures = {
      detailBooks: {
        11: detail(11, { book_series: [{ position: 1, featured: true, series: { id: 500, name: 'Mistborn' } }] }),
        14: detail(14),
        15: detail(15),
        16: detail(16),
      },
      series: [seriesRow(11, 1), seriesRow(14, 2), seriesRow(15, 3)],
      contributions: [contribution(14), contribution(16)],
      personal: { vibes: [14], readBookIds: [11, 12] },
    }
    const queries = (d: { posts: { calls: { query: string }[] }[] }, i: number) => d.posts[i]?.calls.map((c) => /(?:query|mutation) (\w+)/.exec(c.query)?.[1])

    it('caches the series, the favorite author, their books’ details and each person’s Read list', async () => {
      await member()
      const d = deps(fixtures)
      await runHardcoverJob(d, refresh)
      expect((await t.db.select().from(hardcoverExternalBooks)).map((r) => r.hardcoverId).sort()).toEqual([11, 14, 15, 16])
      expect((await t.db.select().from(hardcoverSeries))[0]).toMatchObject({ hardcoverSeriesId: 500, name: 'Mistborn' })
      expect((await t.db.select().from(hardcoverAuthors))[0]).toMatchObject({ hardcoverAuthorId: 77, name: 'Ann' })
      expect((await t.db.select().from(hardcoverAuthors))[0]?.bookIds.map((b) => b.id)).toEqual([14, 16])
      expect((await t.db.select().from(hardcoverReads))[0]?.bookIds).toEqual([11, 12])
      expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'succeeded', stats: { explored: 6 } })
    })

    it('uses the household token for the catalog and the personal token only for the Read list and recommendations', async () => {
      await member()
      const d = deps(fixtures)
      await runHardcoverJob(d, refresh)
      expect(queries(d, 0)).toEqual(['BookDetails', 'SeriesBooks', 'AuthorBooks', 'BookDetails'])
      expect(queries(d, 1)).toEqual(['Recommendations', 'ReadBookIds'])
    })

    it('asks for each Hardcover series at most once per run: one Hardcover does not return is not asked again, and no new extras means no second request', async () => {
      await member()
      const seriesCalls = (d: Parameters<typeof queries>[0]) => queries(d, 0)?.filter((q) => q === 'SeriesBooks').length
      const empty = deps({ ...fixtures, series: [] })
      await runHardcoverJob(empty, refresh)
      expect(seriesCalls(empty)).toBe(1)
      expect(await t.db.select().from(hardcoverSeries)).toEqual([])
      await t.db.delete(hardcoverSeries)
      const normal = deps(fixtures)
      await runHardcoverJob(normal, refresh)
      expect(seriesCalls(normal)).toBe(1)
    })

    it('stops at the budget with partial data kept, and the next run continues', async () => {
      await member()
      expect(await runHardcoverJob(deps(fixtures, 3), refresh)).toBe('done')
      expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'stopped' })
      expect((await t.db.select().from(hardcoverExternalBooks)).map((r) => r.hardcoverId)).toEqual([11])
      expect(await t.db.select().from(hardcoverSeries)).toEqual([])
      await runHardcoverJob(deps(fixtures), refresh)
      expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'succeeded' })
      expect(await t.db.select().from(hardcoverSeries)).toHaveLength(1)
      expect(await t.db.select().from(hardcoverAuthors)).toHaveLength(1)
      expect(await t.db.select().from(hardcoverExternalBooks)).toHaveLength(4)
    })

    it('records an id the details reply left out, and asks for it again only after a week', async () => {
      await member()
      // 15 is in the series list but Hardcover has no details for it
      const detailBooks = { 11: fixtures.detailBooks[11], 14: fixtures.detailBooks[14], 16: fixtures.detailBooks[16] }
      const gone = { ...fixtures, detailBooks }
      await runHardcoverJob(deps(gone), refresh)
      expect((await t.db.select().from(hardcoverMissingBooks)).map((r) => ({ id: r.hardcoverId, at: r.checkedAt.getTime() }))).toEqual([{ id: 15, at: NOW.getTime() }])
      const next = deps(gone)
      await runHardcoverJob(next, refresh)
      const ids = (d: typeof next) => d.posts[0]?.calls.filter((c) => /BookDetails/.test(c.query)).flatMap((c) => (c.variables as { ids: number[] }).ids)
      expect(ids(next)).not.toContain(15)
      // eight days on, the week is over
      const later = deps(gone)
      later.now = () => new Date(NOW.getTime() + 8 * 24 * 3_600_000)
      await runHardcoverJob(later, refresh)
      expect(ids(later)).toContain(15)
    })

    it('a bad reply to the recommendations still lets the person’s Read list be saved', async () => {
      await member()
      const house = hardcoverFixturePost({ token: HOUSE, ...fixtures })
      const mine = failing(hardcoverFixturePost({ token: MINE, ...fixtures.personal }), (q) => /Recommendations/.test(q))
      const d: HardcoverDeps = { ...deps(fixtures), client: (token) => createHardcoverClient({ token, post: token === HOUSE ? house : mine, sleep: () => Promise.resolve() }) }
      expect(await runHardcoverJob(d, refresh)).toBe('done')
      expect((await t.db.select().from(hardcoverReads))[0]?.bookIds).toEqual([11, 12])
      expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'succeeded', stats: { failed: 1 } })
    })

    it('a 401 on the person’s recommendations skips their Read list but the run still succeeds', async () => {
      await member()
      const house = hardcoverFixturePost({ token: HOUSE, ...fixtures })
      const inner = hardcoverFixturePost({ token: MINE, ...fixtures.personal })
      const mine: PostLike = (url, init) => (/Recommendations/.test((JSON.parse(init.body) as { query: string }).query) ? Promise.resolve(new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 })) : inner(url, init))
      const d: HardcoverDeps = { ...deps(fixtures), client: (token) => createHardcoverClient({ token, post: token === HOUSE ? house : mine, sleep: () => Promise.resolve() }) }
      expect(await runHardcoverJob(d, refresh)).toBe('done')
      expect(await t.db.select().from(hardcoverReads)).toEqual([])
      expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'succeeded' })
    })

    it('a bad reply to the author books is counted and the run goes on with the other steps', async () => {
      await member()
      const broken = [{ author_id: 77, contribution: 'Author', book: { id: 'oops', title: 'x', release_date: null, compilation: false } }] as never
      expect(await runHardcoverJob(deps({ ...fixtures, contributions: broken }), refresh)).toBe('done')
      expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'succeeded', stats: { failed: 1 } })
      expect(await t.db.select().from(hardcoverAuthors)).toEqual([])
      expect(await t.db.select().from(hardcoverSeries)).toHaveLength(1)
      expect((await t.db.select().from(hardcoverReads))[0]?.bookIds).toEqual([11, 12])
    })
  })
})
