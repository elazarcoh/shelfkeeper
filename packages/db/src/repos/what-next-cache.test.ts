import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { HardcoverBookData, HardcoverBookSeries, HardcoverExternalBook } from '@mylib/domain'
import { authorFollows, contributors, hardcoverAccounts, hardcoverAuthors, hardcoverExternalBooks, hardcoverMissingBooks, hardcoverReads, hardcoverSeries, readingSessions } from '../schema'
import { seedSession, seedUser, useTestDb, workInput } from '../testing'
import { createWork } from './catalog'
import { saveMatch, saveRecommendations } from './hardcover'
import { listAuthorIdsToFetch, listExploreTargets, listSeriesIdsToFetch, saveExternalBooks, saveHardcoverAuthors, saveHardcoverRead, saveHardcoverSeries, saveMissingBooks } from './what-next-cache'
import { setStatus } from './tracking'
import { loadUserScope, type UserScope } from './scope'

const NOW = new Date('2026-10-20T10:00:00Z')
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)

const data = (id: number, similarIds: number[] = []): HardcoverBookData => ({ id, slug: `b-${id}`, title: `B${id}`, rating: 4, ratingsCount: 1, tags: { genre: [], mood: [] }, similarIds })
const external = (id: number, over: Partial<HardcoverExternalBook> & { series?: HardcoverBookSeries[]; authorIds?: number[] } = {}) => ({
  id,
  title: `E${id}`,
  authors: [],
  seriesName: null,
  position: null,
  pages: null,
  releaseDate: null,
  imageUrl: null,
  tags: { genre: [], mood: [] },
  hasAudiobook: null,
  series: [],
  authorIds: [],
  ...over,
})
const entry = (id: number, name: string, featured = true): HardcoverBookSeries => ({ id, name, position: 1, featured })

describe('what-next explore cache', () => {
  const t = useTestDb()

  async function reader() {
    const user = await seedUser(t.db)
    return { user, scope: await loadUserScope(t.db, user) }
  }

  /** A read work in a local series, matched to Hardcover book `hcId`. */
  async function seriesBook(scope: UserScope, hcId: number, seriesName = 'Mistborn') {
    const w = await createWork(t.db, workInput({ title: `W${hcId}`, series: [{ name: seriesName, position: 1 }] }))
    await saveMatch(t.db, w, { kind: 'isbn', book: data(hcId) }, NOW)
    await setStatus(t.db, scope, w, 'read')
    return w
  }

  it('offers one matched book per series a member reads, until its Hardcover series is fresh', async () => {
    const { scope } = await reader()
    await seriesBook(scope, 11)
    await seriesBook(scope, 12)
    expect((await listExploreTargets(t.db, NOW, 10)).seriesBookIds).toEqual([11])
    await saveExternalBooks(t.db, [external(11, { series: [entry(500, 'Mistborn')] })], NOW)
    await saveHardcoverSeries(t.db, [{ seriesId: 500, name: 'Mistborn', books: [] }], daysAgo(2))
    expect((await listExploreTargets(t.db, NOW, 10)).seriesBookIds).toEqual([])
    await saveHardcoverSeries(t.db, [{ seriesId: 500, name: 'Mistborn', books: [] }], daysAgo(8))
    expect((await listExploreTargets(t.db, NOW, 10)).seriesBookIds).toEqual([11])
  })

  it('ignores a series nobody is reading', async () => {
    const { scope } = await reader()
    const w = await createWork(t.db, workInput({ title: 'Wanted' }))
    await saveMatch(t.db, w, { kind: 'isbn', book: data(21) }, NOW)
    await setStatus(t.db, scope, w, 'want_to_read')
    expect((await listExploreTargets(t.db, NOW, 10)).seriesBookIds).toEqual([])
  })

  it('fetches only the Hardcover series that matches the local series name', async () => {
    const { scope } = await reader()
    await seriesBook(scope, 31)
    await saveExternalBooks(t.db, [external(31, { series: [entry(1, 'The Cosmere', false), entry(2, 'The Mistborn Saga', true)] })], NOW)
    expect(await listSeriesIdsToFetch(t.db, NOW, 10)).toEqual([2])
    await saveHardcoverSeries(t.db, [{ seriesId: 2, name: 'The Mistborn Saga', books: [] }], daysAgo(1))
    expect(await listSeriesIdsToFetch(t.db, NOW, 10)).toEqual([])
  })

  describe('series of books the page may show', () => {
    async function recommended(userId: string, ids: number[]) {
      const [account] = await t.db.insert(hardcoverAccounts).values({ scope: 'user', userId, token: 'x', hardcoverUserId: 1, username: 'u', checkedAt: NOW }).returning({ id: hardcoverAccounts.id })
      await saveRecommendations(t.db, account?.id ?? '', ids, NOW)
    }

    it('lists the series of a recommended book at position 2 or later, not one at position 1, never a fresh one', async () => {
      const { user } = await reader()
      await recommended(user.id, [101, 102, 103])
      await saveExternalBooks(
        t.db,
        [
          external(101, { seriesName: 'Stormlight', position: 2, series: [entry(10, 'The Cosmere'), entry(11, 'Stormlight')] }),
          external(102, { seriesName: 'Cradle', position: 1, series: [entry(12, 'Cradle')] }),
          external(103, { seriesName: 'Fresh', position: 4, series: [entry(13, 'Fresh')] }),
        ],
        NOW,
      )
      await saveHardcoverSeries(t.db, [{ seriesId: 13, name: 'Fresh', books: [] }], daysAgo(1))
      // the entry named like the displayed series, not the universe
      expect(await listSeriesIdsToFetch(t.db, NOW, 10)).toEqual([11])
    })

    it('covers similar books of the last finished and favorite authors’ books, taking the first entry when no name fits', async () => {
      const { user, scope } = await reader()
      const w = await createWork(t.db, workInput({ title: 'Last', series: [] }))
      await saveMatch(t.db, w, { kind: 'isbn', book: data(40, [201]) }, NOW)
      await setStatus(t.db, scope, w, 'read')
      await seedSession(t.db, { userId: user.id, workId: w, startedOn: '2026-10-01', outcome: 'finished', finishedOn: '2026-10-15' })
      await saveHardcoverAuthors(t.db, [{ authorId: 9, books: [{ id: 701, title: 'c', releaseDate: null }] }], NOW)
      await saveExternalBooks(
        t.db,
        [
          external(201, { seriesName: 'Odd', position: 3, series: [entry(21, 'Something')] }),
          external(701, { seriesName: 'Author Saga', position: 2, series: [entry(22, 'Author Saga')] }),
          external(999, { seriesName: 'Unlisted', position: 5, series: [entry(23, 'Unlisted')] }),
        ],
        NOW,
      )
      // 999 is on no list the page shows
      expect(await listSeriesIdsToFetch(t.db, NOW, 10)).toEqual([21, 22])
    })

    it('puts the series members read first, then these, within the limit', async () => {
      const { user, scope } = await reader()
      await seriesBook(scope, 31)
      await saveExternalBooks(t.db, [external(31, { series: [entry(900, 'Mistborn')] })], NOW)
      await recommended(user.id, [101])
      await saveExternalBooks(t.db, [external(101, { seriesName: 'Early', position: 2, series: [entry(5, 'Early')] })], NOW)
      expect(await listSeriesIdsToFetch(t.db, NOW, 10)).toEqual([900, 5])
      expect(await listSeriesIdsToFetch(t.db, NOW, 1)).toEqual([900])
    })
  })

  it('includes recommendations and the last finished book’s similar ids, minus fresh details and library books', async () => {
    const { user, scope } = await reader()
    const [account] = await t.db.insert(hardcoverAccounts).values({ scope: 'user', userId: user.id, token: 'x', hardcoverUserId: 1, username: 'u', checkedAt: NOW }).returning({ id: hardcoverAccounts.id })
    await saveRecommendations(t.db, account?.id ?? '', [101, 102], NOW)
    const w = await createWork(t.db, workInput({ title: 'Last', series: [] }))
    await saveMatch(t.db, w, { kind: 'isbn', book: data(40, [201, 202, 40]) }, NOW)
    await setStatus(t.db, scope, w, 'read')
    const s = await seedSession(t.db, { userId: user.id, workId: w, startedOn: '2026-10-01', outcome: 'finished', finishedOn: '2026-10-15' })
    await t.db.update(readingSessions).set({ updatedAt: daysAgo(5) }).where(eq(readingSessions.id, s))
    await saveExternalBooks(t.db, [external(102)], daysAgo(1))
    expect((await listExploreTargets(t.db, NOW, 10)).detailIds).toEqual([101, 201, 202])
    // 8 days later the cached details are stale again (and the session is still inside 60 days)
    expect((await listExploreTargets(t.db, new Date(NOW.getTime() + 8 * DAY), 10)).detailIds).toEqual([101, 102, 201, 202])
  })

  it('ignores a finished book older than 60 days', async () => {
    const { user } = await reader()
    const w = await createWork(t.db, workInput({ title: 'Old', series: [] }))
    await saveMatch(t.db, w, { kind: 'isbn', book: data(50, [301]) }, NOW)
    const s = await seedSession(t.db, { userId: user.id, workId: w, startedOn: '2026-05-01', outcome: 'finished', finishedOn: '2026-05-10' })
    await t.db.update(readingSessions).set({ updatedAt: daysAgo(100) }).where(eq(readingSessions.id, s))
    expect((await listExploreTargets(t.db, NOW, 10)).detailIds).toEqual([])
  })

  it('ignores a finish with an unknown date, stored as the day it was entered (#152)', async () => {
    const { user } = await reader()
    const w = await createWork(t.db, workInput({ title: 'Long ago', series: [] }))
    await saveMatch(t.db, w, { kind: 'isbn', book: data(60, [401]) }, NOW)
    const today = NOW.toISOString().slice(0, 10)
    await seedSession(t.db, { userId: user.id, workId: w, startedOn: today, startedPrecision: 'unknown', outcome: 'finished', finishedOn: today, finishedPrecision: 'unknown' })
    expect((await listExploreTargets(t.db, NOW, 10)).detailIds).toEqual([])
  })

  it('includes cached series and author book ids that lack details', async () => {
    await saveHardcoverSeries(t.db, [{ seriesId: 1, name: 'S', books: [601, 602].map((id) => ({ id, position: null, title: 't', releaseDate: null })) }], NOW)
    await saveHardcoverAuthors(t.db, [{ authorId: 9, books: [{ id: 701, title: 'c', releaseDate: null }] }], NOW)
    expect((await listExploreTargets(t.db, NOW, 10)).detailIds).toEqual([601, 602, 701])
  })

  it('leaves out an id Hardcover did not return until the cache window has passed, and a later fetch forgets it', async () => {
    await saveHardcoverSeries(t.db, [{ seriesId: 1, name: 'S', books: [601, 602].map((id) => ({ id, position: null, title: 't', releaseDate: null })) }], NOW)
    await saveMissingBooks(t.db, [601], daysAgo(2))
    expect((await listExploreTargets(t.db, NOW, 10)).detailIds).toEqual([602])
    expect((await listExploreTargets(t.db, new Date(NOW.getTime() + 6 * DAY), 10)).detailIds).toEqual([601, 602])
    await saveExternalBooks(t.db, [external(601)], NOW)
    expect(await t.db.select().from(hardcoverMissingBooks)).toEqual([])
  })

  it('respects the limit on every list', async () => {
    const { scope } = await reader()
    await seriesBook(scope, 61, 'Alpha')
    await seriesBook(scope, 62, 'Beta')
    await saveHardcoverSeries(t.db, [{ seriesId: 1, name: 'S', books: [601, 602, 603].map((id) => ({ id, position: null, title: 't', releaseDate: null })) }], NOW)
    const targets = await listExploreTargets(t.db, NOW, 1)
    expect(targets.seriesBookIds).toHaveLength(1)
    expect(targets.detailIds).toHaveLength(1)
  })

  it('saves upsert: a second save replaces the data', async () => {
    await saveExternalBooks(t.db, [external(1, { title: 'Old', series: [entry(5, 'S')], authorIds: [3] })], daysAgo(3))
    await saveExternalBooks(t.db, [external(1, { title: 'New', authorIds: [4] })], NOW)
    expect(await t.db.select().from(hardcoverExternalBooks)).toMatchObject([{ hardcoverId: 1, title: 'New', series: [], authorIds: [4], fetchedAt: NOW }])
    await saveHardcoverSeries(t.db, [{ seriesId: 5, name: 'A', books: [] }], daysAgo(3))
    await saveHardcoverSeries(t.db, [{ seriesId: 5, name: 'B', books: [{ id: 1, position: 1, title: 't', releaseDate: null }] }], NOW)
    expect(await t.db.select().from(hardcoverSeries)).toMatchObject([{ hardcoverSeriesId: 5, name: 'B', books: [{ id: 1 }], fetchedAt: NOW }])
    await saveExternalBooks(t.db, [external(2, { authors: ['Ann', 'Bo'], authorIds: [8, 9] })], NOW)
    await saveHardcoverAuthors(t.db, [{ authorId: 9, books: [] }], daysAgo(3))
    await saveHardcoverAuthors(t.db, [{ authorId: 9, books: [{ id: 2, title: 't', releaseDate: '2026-01-01' }] }], NOW)
    // the name comes from the cached book's authors at the author id's index
    expect(await t.db.select().from(hardcoverAuthors)).toMatchObject([{ hardcoverAuthorId: 9, name: 'Bo', bookIds: [{ id: 2 }], fetchedAt: NOW }])
    const { user } = await reader()
    const [account] = await t.db.insert(hardcoverAccounts).values({ scope: 'user', userId: user.id, token: 'x', hardcoverUserId: 1, username: 'u', checkedAt: NOW }).returning({ id: hardcoverAccounts.id })
    await saveHardcoverRead(t.db, account?.id ?? '', [1, 2], daysAgo(3))
    await saveHardcoverRead(t.db, account?.id ?? '', [3], NOW)
    expect(await t.db.select().from(hardcoverReads)).toMatchObject([{ bookIds: [3], fetchedAt: NOW }])
  })

  describe('authors', () => {
    /** `count` read, matched works by one author, with Hardcover ids firstId, firstId + 1, … */
    async function authorWorks(scope: UserScope, author: string, firstId: number, count: number) {
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const w = await createWork(t.db, workInput({ title: `${author}-${i}`, authors: [author], series: [] }))
        await saveMatch(t.db, w, { kind: 'isbn', book: data(firstId + i) }, NOW)
        await setStatus(t.db, scope, w, 'read')
        ids.push(w)
      }
      return ids
    }
    const contributorOf = async (name: string) => (await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, name)))[0]?.id ?? ''

    it('takes favorite authors from reads, one matched book each, until their Hardcover author is fresh', async () => {
      const { scope } = await reader()
      await authorWorks(scope, 'Ann', 100, 3)
      await authorWorks(scope, 'Bo', 200, 1)
      expect((await listExploreTargets(t.db, NOW, 10)).authorBookIds).toEqual([100])
      await saveExternalBooks(t.db, [external(100, { authors: ['Ann'], authorIds: [77] })], NOW)
      expect((await listExploreTargets(t.db, NOW, 10)).authorBookIds).toEqual([100])
      expect(await listAuthorIdsToFetch(t.db, NOW, 10)).toEqual([77])
      await saveHardcoverAuthors(t.db, [{ authorId: 77, books: [] }], daysAgo(2))
      expect(await listAuthorIdsToFetch(t.db, NOW, 10)).toEqual([])
      expect((await listExploreTargets(t.db, NOW, 10)).authorBookIds).toEqual([])
      await saveHardcoverAuthors(t.db, [{ authorId: 77, books: [] }], daysAgo(8))
      expect(await listAuthorIdsToFetch(t.db, NOW, 10)).toEqual([77])
      expect((await listExploreTargets(t.db, NOW, 10)).authorBookIds).toEqual([100])
    })

    it('includes a followed author with a single read, and an unfollow drops an automatic favorite', async () => {
      const { user, scope } = await reader()
      await authorWorks(scope, 'Bo', 200, 1)
      await authorWorks(scope, 'Ann', 100, 3)
      await saveExternalBooks(t.db, [external(200, { authors: ['Bo'], authorIds: [88] }), external(100, { authors: ['Ann'], authorIds: [77] })], NOW)
      expect(await listAuthorIdsToFetch(t.db, NOW, 10)).toEqual([77])
      await t.db.insert(authorFollows).values([
        { userId: user.id, contributorId: await contributorOf('Bo'), mode: 'follow', name: 'Bo' },
        { userId: user.id, contributorId: await contributorOf('Ann'), mode: 'unfollow', name: 'Ann' },
      ])
      expect(await listAuthorIdsToFetch(t.db, NOW, 10)).toEqual([88])
    })

    it('excludes an author whose only reads belong to an unfollowed person, and takes a followed Hardcover author id directly', async () => {
      const a = await reader()
      const b = await reader()
      await authorWorks(a.scope, 'Cy', 300, 1)
      await saveExternalBooks(t.db, [external(300, { authors: ['Cy'], authorIds: [99] })], NOW)
      await authorWorks(b.scope, 'Di', 400, 3)
      await saveExternalBooks(t.db, [external(400, { authors: ['Di'], authorIds: [66] })], NOW)
      await t.db.insert(authorFollows).values({ userId: b.user.id, contributorId: await contributorOf('Di'), mode: 'unfollow', name: 'Di' })
      expect(await listAuthorIdsToFetch(t.db, NOW, 10)).toEqual([])
      await t.db.insert(authorFollows).values({ userId: a.user.id, hardcoverAuthorId: 5, mode: 'follow', name: 'Ev' })
      expect(await listAuthorIdsToFetch(t.db, NOW, 10)).toEqual([5])
    })

    it('does not count another person’s reads toward my favorites', async () => {
      const a = await reader()
      const b = await reader()
      await authorWorks(a.scope, 'Fy', 500, 2)
      await authorWorks(b.scope, 'Fy', 502, 1)
      await saveExternalBooks(t.db, [external(500, { authors: ['Fy'], authorIds: [55] })], NOW)
      // two reads by a and one by b: neither alone reaches the bar, and reads are not pooled
      expect(await listAuthorIdsToFetch(t.db, NOW, 10)).toEqual([])
    })
  })
})
