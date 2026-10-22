import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AiPick, EditionFormat, HardcoverBookData, HardcoverBookSeries, HardcoverExternalBook } from '@mylib/domain'
import { authorFollows, contributors, editions, hardcoverAccounts, hardcoverBooks, readingSessions, series, seriesNames, userWorks, whatNextHidden, whatNextPrefs, wishes, workSeries, works } from '../schema'
import { seedSession, seedUser, seedWork, useTestDb, workInput } from '../testing'
import { createWork } from './catalog'
import { saveMatch, saveRecommendations } from './hardcover'
import { loadUserScope, type UserScope } from './scope'
import { addToQueue, setRating, setStatus } from './tracking'
import { upsertWish } from './wishlist'
import { getWhatNext, hidePick, listAuthorFollows, promptInputFor, readTitlesFor, saveAiAnswer, saveWhatNextFormat, setAuthorFollow, unhidePick, wishedTitles, wishFromPick, type WhatNextView } from './what-next'
import { saveExternalBooks, saveHardcoverAuthors, saveHardcoverRead, saveHardcoverSeries } from './what-next-cache'

const NOW = new Date('2026-10-20T10:00:00Z')
const TODAY = '2026-10-20'

const data = (id: number, over: Partial<HardcoverBookData> = {}): HardcoverBookData => ({ id, slug: `b-${id}`, title: `B${id}`, rating: 4, ratingsCount: 1, tags: { genre: [], mood: [] }, similarIds: [], ...over })
const external = (id: number, over: Partial<HardcoverExternalBook> & { series?: HardcoverBookSeries[]; authorIds?: number[] } = {}) => ({
  id,
  title: `E${id}`,
  authors: ['Somebody'],
  seriesName: null,
  position: null,
  pages: 300,
  releaseDate: null,
  imageUrl: null,
  tags: { genre: [], mood: [] },
  hasAudiobook: null,
  series: [],
  authorIds: [],
  ...over,
})
const entry = (id: number, name: string): HardcoverBookSeries => ({ id, name, position: 1, featured: true })

describe('what-next page query', () => {
  const t = useTestDb()

  async function person() {
    const user = await seedUser(t.db)
    return { user, scope: await loadUserScope(t.db, user) }
  }
  async function household() {
    await t.db.insert(hardcoverAccounts).values({ scope: 'household', token: 'x', hardcoverUserId: 1, username: 'house', checkedAt: NOW })
  }
  async function linked(userId: string): Promise<string> {
    const [row] = await t.db.insert(hardcoverAccounts).values({ scope: 'user', userId, token: 'x', hardcoverUserId: 2, username: 'me', checkedAt: NOW }).returning({ id: hardcoverAccounts.id })
    return row?.id ?? ''
  }

  interface BookOpts {
    authors?: string[]
    series?: { name: string; position: number; positionEnd?: number }
    pages?: number | null
    format?: EditionFormat
    durationSec?: number
    hc?: { id: number; data?: Partial<HardcoverBookData> }
    status?: 'read' | 'reading' | 'want_to_read' | 'none'
    rating?: number
  }
  /** A work with one owned edition; status read/reading/... for `scope`, optionally matched to Hardcover. */
  async function book(scope: UserScope, title: string, o: BookOpts = {}) {
    const w = await createWork(
      t.db,
      workInput({
        title,
        authors: o.authors ?? ['Ann Author'],
        series: o.series ? [o.series] : [],
        editions: [{ format: o.format ?? 'physical', pageCount: o.pages === undefined ? 300 : o.pages, durationSec: o.durationSec ?? null }],
      }),
    )
    if (o.hc) await saveMatch(t.db, w, { kind: 'isbn', book: data(o.hc.id, o.hc.data) }, NOW)
    if (o.status && o.status !== 'none') await setStatus(t.db, scope, w, o.status)
    if (o.rating !== undefined) await setRating(t.db, scope, w, o.rating)
    return w
  }
  const finish = (userId: string, workId: string, finishedOn = '2026-10-15') => seedSession(t.db, { userId, workId, startedOn: '2026-10-01', outcome: 'finished', finishedOn })

  /** A Cradle-like series: books 1 and 2 read and matched (Hardcover 11, 12), Hardcover also lists 3 (13) and 2.5 (14). */
  async function cradle(scope: UserScope, userId: string, ratings: [number | undefined, number | undefined] = [undefined, undefined]) {
    const w1 = await book(scope, 'Cradle 1', { series: { name: 'Cradle', position: 1 }, status: 'read', hc: { id: 11 }, ...(ratings[0] === undefined ? {} : { rating: ratings[0] }) })
    const w2 = await book(scope, 'Cradle 2', { series: { name: 'Cradle', position: 2 }, status: 'read', pages: 1200, hc: { id: 12 }, ...(ratings[1] === undefined ? {} : { rating: ratings[1] }) })
    await finish(userId, w2)
    await saveExternalBooks(t.db, [external(11, { series: [entry(500, 'Cradle')] }), external(12, { series: [entry(500, 'Cradle')] }), external(13, { title: 'Cradle 3', position: 3, seriesName: 'Cradle' })], NOW)
    await saveHardcoverSeries(
      t.db,
      [
        {
          seriesId: 500,
          name: 'Cradle',
          books: [
            { id: 11, position: 1, title: 'Cradle 1', releaseDate: null },
            { id: 12, position: 2, title: 'Cradle 2', releaseDate: null },
            { id: 14, position: 2.5, title: 'Cradle 2.5', releaseDate: null },
            { id: 13, position: 3, title: 'Cradle 3', releaseDate: null },
          ],
        },
      ],
      NOW,
    )
    return { w1, w2 }
  }

  const get = (scope: UserScope, input: Partial<{ mood: 'keep_going' | 'light' | 'surprise' | null; format: 'audio' | 'any' | null }> = {}) =>
    getWhatNext(t.db, scope, { mood: input.mood ?? null, format: input.format ?? 'any', today: TODAY })
  const list = (v: WhatNextView, source: string) => v.lists.find((l) => l.source === source)?.picks ?? []

  it('preselects keep going after a heavy book of a series the person is hooked on, and lists the next Hardcover book', async () => {
    await household()
    const { user, scope } = await person()
    await cradle(scope, user.id)
    const v = await get(scope)
    expect(v.lastFinished).toMatchObject({ title: 'Cradle 2', pages: 1200, heavy: true, finishedOn: '2026-10-15' })
    expect(v.preselected).toBe('keep_going')
    expect(list(v, 'series')[0]).toMatchObject({ key: 'hc:13', hardcoverId: 13, workId: null, reason: 'Next in Cradle (#3)', title: 'Cradle 3', seriesName: 'Cradle', position: 3 })
    expect(v.exploreEnabled).toBe(true)
  })

  it('preselects light when the heavy book’s series has a rating below 3', async () => {
    await household()
    const { user, scope } = await person()
    await cradle(scope, user.id, [2, 5])
    expect((await get(scope)).preselected).toBe('light')
  })

  it('without a finished book in 60 days: no header book, surprise, and still a shelf list', async () => {
    const { user, scope } = await person()
    await book(scope, 'Old finish', { status: 'read' }).then((w) => finish(user.id, w, '2026-06-01'))
    await book(scope, 'Unread one')
    const v = await get(scope)
    expect(v.lastFinished).toBeNull()
    expect(v.preselected).toBe('surprise')
    expect(list(v, 'shelf').map((p) => p.title)).toEqual(['Unread one'])
    expect(v.exploreEnabled).toBe(false)
    expect(v.personalLinked).toBe(false)
  })

  it('a finish with an unknown date ("Mark as read" on an old book) is never the book just finished (#152)', async () => {
    const { user, scope } = await person()
    const dated = await book(scope, 'Dated finish', { status: 'read' })
    await finish(user.id, dated, '2026-10-10')
    const old = await book(scope, 'Read long ago', { status: 'read' })
    // stored with the day it was entered, and completed later than the dated one
    await seedSession(t.db, { userId: user.id, workId: old, startedOn: TODAY, startedPrecision: 'unknown', outcome: 'finished', finishedOn: TODAY, finishedPrecision: 'unknown' })
    expect((await get(scope)).lastFinished).toMatchObject({ title: 'Dated finish' })
  })

  it('a finished book with no length and no moods is not heavy', async () => {
    const { user, scope } = await person()
    const w = await book(scope, 'Unknown length', { pages: null, status: 'read' })
    await finish(user.id, w)
    const v = await get(scope)
    expect(v.lastFinished).toMatchObject({ pages: null, audioSec: null, moods: [], heavy: false })
    expect(v.preselected).toBe('surprise')
  })

  it('takes the length from the session’s edition, else the longest edition', async () => {
    const { user, scope } = await person()
    const a = await book(scope, 'Has session edition', { pages: 100, status: 'read' })
    const b = await book(scope, 'No session edition', { pages: 650, status: 'read' })
    await finish(user.id, a, '2026-10-10')
    await finish(user.id, b, '2026-10-12')
    expect((await get(scope)).lastFinished).toMatchObject({ title: 'No session edition', pages: 650, heavy: true })
  })

  it('under audio, the shelf holds only works with an audiobook the household has, never a read one', async () => {
    const { scope } = await person()
    await book(scope, 'Print only')
    await book(scope, 'Audio owned', { format: 'audiobook', durationSec: 36_000 })
    await book(scope, 'Audio read', { format: 'audiobook', status: 'read' })
    const returned = await seedWork(t.db, { title: 'Audio returned', formats: ['audiobook'], holding: { ownership: 'owned', inPossession: false } })
    expect(returned.editionIds).toHaveLength(1)
    const v = await get(scope, { format: 'audio' })
    expect(list(v, 'shelf').map((p) => p.title)).toEqual(['Audio owned'])
    expect(list(v, 'shelf')[0]).toMatchObject({ audiobook: 'yes', formats: ['audiobook'], audioSec: 36_000 })
    expect(list(await get(scope, { format: 'any' }), 'shelf').map((p) => p.title).sort()).toEqual(['Audio owned', 'Print only'])
  })

  it('ranks the shelf: next in series, then Up next, then favorite author, then the rest', async () => {
    const { scope } = await person()
    const read1 = await book(scope, 'Saga 1', { series: { name: 'Saga', position: 1 }, status: 'read' })
    expect(read1).toBeTruthy()
    const next = await book(scope, 'Saga 2', { series: { name: 'Saga', position: 2 } })
    const queued = await book(scope, 'Queued')
    await addToQueue(t.db, scope, queued, 'top')
    for (const n of [1, 2, 3]) await book(scope, `Fan ${n}`, { authors: ['Fav Author'], status: 'read' })
    const byFav = await book(scope, 'More by fav', { authors: ['Fav Author'] })
    await book(scope, 'Plain')
    const v = await get(scope)
    const picks = list(v, 'shelf')
    expect(picks.map((p) => [p.title, p.reason])).toEqual([
      ['Saga 2', 'Next in Saga (#2)'],
      ['Queued', 'In your Up next'],
      ['More by fav', 'By Fav Author'],
      ['Plain', 'Waiting on your shelf'],
    ])
    expect(picks.map((p) => p.workId)).toEqual([next, queued, byFav, picks[3]?.workId])
    expect(v.favoriteAuthors).toMatchObject([{ name: 'Fav Author', hardcoverAuthorId: null, why: 'auto' }])
  })

  it('under light, shelf picks must be light and the lighter-mooded ones come first', async () => {
    const { scope } = await person()
    await book(scope, 'Long', { pages: 700 })
    await book(scope, 'Short plain', { pages: 200, hc: { id: 1 } })
    await book(scope, 'Short funny', { pages: 250, hc: { id: 2, data: { tags: { genre: [], mood: ['funny'] } } } })
    await book(scope, 'Short dark', { pages: 100, hc: { id: 3, data: { tags: { genre: [], mood: ['dark'] } } } })
    const picks = list(await get(scope, { mood: 'light' }), 'shelf')
    expect(picks.map((p) => p.title)).toEqual(['Short funny', 'Short plain'])
    expect(picks[0]?.reason).toBe('Shorter and lighter: 250 pages, funny')
  })

  it('under light, the rule rank comes first: a next-in-series light book beats a funnier plain one', async () => {
    const { scope } = await person()
    await book(scope, 'Saga 1', { series: { name: 'Saga', position: 1 }, status: 'read' })
    await book(scope, 'Saga 2', { series: { name: 'Saga', position: 2 }, pages: 250, hc: { id: 5 } })
    await book(scope, 'Funny plain', { pages: 200, hc: { id: 6, data: { tags: { genre: [], mood: ['funny', 'hopeful'] } } } })
    const picks = list(await get(scope, { mood: 'light' }), 'shelf')
    expect(picks.map((p) => [p.title, p.reason])).toEqual([
      ['Saga 2', 'Next in Saga (#2)'],
      ['Funny plain', 'Shorter and lighter: 200 pages, funny'],
    ])
  })

  it('hides this person’s hidden work: keys from the shelf', async () => {
    const { user, scope } = await person()
    const w = await book(scope, 'Hide me')
    await book(scope, 'Keep me')
    await t.db.insert(whatNextHidden).values({ userId: user.id, pickKey: `work:${w}` })
    expect(list(await get(scope), 'shelf').map((p) => p.title)).toEqual(['Keep me'])
  })

  describe('exploration', () => {
    async function recs(userId: string, ids: number[], over: Parameters<typeof external>[1] = {}) {
      const account = await linked(userId)
      await saveRecommendations(t.db, account, ids, NOW)
      await saveExternalBooks(t.db, ids.map((id) => external(id, over)), NOW)
      return account
    }

    it('(review focus 1) leaves out a Hardcover id on this person’s Read list only for this person', async () => {
      await household()
      const a = await person()
      const b = await person()
      const accountA = await recs(a.user.id, [101, 102])
      await recs(b.user.id, [101, 102])
      await saveHardcoverRead(t.db, accountA, [101], NOW)
      const forA = await get(a.scope, { mood: 'surprise' })
      const forB = await get(b.scope, { mood: 'surprise' })
      expect(list(forA, 'hardcover').map((p) => p.hardcoverId)).toEqual([102])
      expect(list(forB, 'hardcover').map((p) => p.hardcoverId)).toEqual([101, 102])
      expect(forA.personalLinked).toBe(true)
      expect(list(forB, 'hardcover')[0]).toMatchObject({ source: 'hardcover', reason: 'Hardcover recommends', key: 'hc:101', pages: 300, audiobook: 'unknown' })
    })

    it('leaves out Hardcover ids that map to a library work, and this person’s hidden picks', async () => {
      await household()
      const a = await person()
      await book(a.scope, 'In library', { hc: { id: 101 } })
      await recs(a.user.id, [101, 102, 103])
      await t.db.insert(whatNextHidden).values({ userId: a.user.id, pickKey: 'hc:103' })
      expect(list(await get(a.scope, { mood: 'surprise' }), 'hardcover').map((p) => p.hardcoverId)).toEqual([102])
    })

    it('leaves out a recommendation that is an unmatched held work by title and author', async () => {
      await household()
      const a = await person()
      await book(a.scope, 'Held Book', { authors: ['Ann Author'] })
      const account = await linked(a.user.id)
      await saveRecommendations(t.db, account, [201, 202], NOW)
      await saveExternalBooks(t.db, [external(201, { title: 'Held Book', authors: ['ann author'] }), external(202, { title: 'Other Book', authors: ['Ann Author'] })], NOW)
      expect(list(await get(a.scope, { mood: 'surprise' }), 'hardcover').map((p) => p.hardcoverId)).toEqual([202])
    })

    it('matches a recommendation by any name of the library book’s series, not only the primary one (#145)', async () => {
      await household()
      const a = await person()
      const w = await book(a.scope, 'The Way of Kings', { authors: ['Ann Author'], series: { name: 'גנזך אורות הסער', position: 1 } })
      const [row] = await t.db.select({ id: series.id }).from(workSeries).innerJoin(series, eq(series.id, workSeries.seriesId)).where(eq(workSeries.workId, w))
      await t.db.insert(seriesNames).values({ seriesId: row?.id ?? '', name: 'Stormlight Archive', normalizedName: 'stormlight archive', language: 'en' })
      const account = await linked(a.user.id)
      await saveRecommendations(t.db, account, [231, 232], NOW)
      await saveExternalBooks(t.db, [external(231, { title: 'Stormlight Archive: The Way of Kings', authors: ['Ann Author'] }), external(232, { title: 'Other Book', authors: ['Ann Author'] })], NOW)
      expect(list(await get(a.scope, { mood: 'surprise' }), 'hardcover').map((p) => p.hardcoverId)).toEqual([232])
    })

    it('leaves out a recommendation that is a work this person read, matched to a different Hardcover entry', async () => {
      await household()
      const a = await person()
      // no copy: only the read status can hide the pick
      const read = await book(a.scope, 'Read Book', { authors: ['Ann Author'], status: 'read', hc: { id: 211 } })
      await t.db.delete(editions).where(eq(editions.workId, read))
      const account = await linked(a.user.id)
      await saveRecommendations(t.db, account, [212, 213], NOW)
      await saveExternalBooks(t.db, [external(212, { title: 'Read Book', authors: ['Ann Author'] }), external(213, { title: 'Other Book', authors: ['Ann Author'] })], NOW)
      expect(list(await get(a.scope, { mood: 'surprise' }), 'hardcover').map((p) => p.hardcoverId)).toEqual([213])
    })

    it('shows a recommendation as wished when this person only wishes a work with its title and author, under another Hardcover id', async () => {
      await household()
      const a = await person()
      const wished = await createWork(t.db, workInput({ title: 'Wished Book', authors: ['Ann Author'], editions: [{ format: 'physical' }] }))
      await t.db.delete(editions).where(eq(editions.workId, wished))
      await saveMatch(t.db, wished, { kind: 'manual', book: data(111) }, NOW)
      await upsertWish(t.db, a.scope, wished, { formats: [], language: null, note: null }, null)
      const account = await linked(a.user.id)
      await saveRecommendations(t.db, account, [222], NOW)
      await saveExternalBooks(t.db, [external(222, { title: 'Wished Book', authors: ['Ann Author'] })], NOW)
      const picks = list(await get(a.scope, { mood: 'surprise' }), 'hardcover')
      expect(picks.map((p) => [p.hardcoverId, p.onWishlist, p.workId])).toEqual([[222, true, wished]])
    })

    it('carries author ids: contributors on the shelf, Hardcover ids (and a matching contributor) on exploration', async () => {
      await household()
      const a = await person()
      const w = await book(a.scope, 'On shelf', { authors: ['Ann Author', 'Co Writer'] })
      await recs(a.user.id, [101], { authors: ['ann author', 'Newcomer'], authorIds: [7, 8] })
      const v = await get(a.scope, { mood: 'surprise' })
      const shelf = list(v, 'shelf').find((p) => p.workId === w)
      expect(shelf?.authorRefs.map((r) => ({ name: r.name, hc: r.hardcoverAuthorId, hasId: r.contributorId !== null }))).toEqual([
        { name: 'Ann Author', hc: null, hasId: true },
        { name: 'Co Writer', hc: null, hasId: true },
      ])
      const [ann] = await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, 'Ann Author'))
      expect(list(v, 'hardcover')[0]?.authorRefs).toEqual([
        { name: 'ann author', contributorId: ann?.id, hardcoverAuthorId: 7 },
        { name: 'Newcomer', contributorId: null, hardcoverAuthorId: 8 },
      ])
    })

    it('shows no explore list without a household Hardcover account', async () => {
      const a = await person()
      await recs(a.user.id, [101])
      const v = await get(a.scope, { mood: 'surprise' })
      expect(v.exploreEnabled).toBe(false)
      expect(list(v, 'hardcover')).toEqual([])
    })

    it('gates lists by mood', async () => {
      await household()
      const a = await person()
      await recs(a.user.id, [101])
      const w = await book(a.scope, 'Finished', { status: 'read', hc: { id: 900, data: { similarIds: [301] } } })
      await finish(a.user.id, w)
      await saveExternalBooks(t.db, [external(301)], NOW)
      const sources = async (mood: 'keep_going' | 'light' | 'surprise') => (await get(a.scope, { mood })).lists.map((l) => l.source)
      expect(await sources('keep_going')).toEqual(['similar'])
      expect(await sources('light')).toEqual(['hardcover'])
      expect(await sources('surprise')).toEqual(['hardcover', 'similar'])
      const similar = list(await get(a.scope, { mood: 'keep_going' }), 'similar')
      expect(similar[0]).toMatchObject({ hardcoverId: 301, reason: 'Like Finished' })
    })

    it('a list the mood hides takes nothing from the lists it shows: keep going keeps a similar book that is also a recommendation', async () => {
      await household()
      const a = await person()
      await recs(a.user.id, [301, 101])
      const w = await book(a.scope, 'Finished', { status: 'read', hc: { id: 900, data: { similarIds: [301] } } })
      await finish(a.user.id, w)
      await saveExternalBooks(t.db, [external(301)], NOW)
      const v = await get(a.scope, { mood: 'keep_going' })
      expect(list(v, 'similar').map((p) => p.hardcoverId)).toEqual([301])
    })

    it('a list the mood hides takes nothing from the lists it shows: light keeps the author’s next series book', async () => {
      await household()
      const a = await person()
      for (const n of [1, 2, 3]) await book(a.scope, `Cradle ${n}`, { authors: ['Will Wight'], series: { name: 'Cradle', position: n }, status: 'read', hc: { id: 300 + n } })
      await saveExternalBooks(
        t.db,
        [
          ...[301, 302, 303].map((id) => external(id, { authors: ['Will Wight'], authorIds: [9], series: [entry(500, 'Cradle')] })),
          external(304, { title: 'Cradle 4', authors: ['Will Wight'], seriesName: 'Cradle', position: 4, releaseDate: '2026-09-01' }),
        ],
        NOW,
      )
      await saveHardcoverSeries(t.db, [{ seriesId: 500, name: 'Cradle', books: [{ id: 304, position: 4, title: 'Cradle 4', releaseDate: '2026-09-01' }] }], NOW)
      await saveHardcoverAuthors(t.db, [{ authorId: 9, books: [{ id: 304, title: 'Cradle 4', releaseDate: '2026-09-01' }] }], NOW)
      expect(list(await get(a.scope, { mood: 'keep_going' }), 'series').map((p) => p.hardcoverId)).toEqual([304])
      expect(list(await get(a.scope, { mood: 'light' }), 'author').map((p) => p.hardcoverId)).toEqual([304])
    })

    it('under audio, drops explore picks Hardcover says have no audiobook, keeps unknown ones', async () => {
      await household()
      const a = await person()
      await recs(a.user.id, [101, 102, 103])
      await saveExternalBooks(t.db, [external(101, { hasAudiobook: true }), external(102, { hasAudiobook: false }), external(103, { hasAudiobook: null })], NOW)
      const picks = list(await get(a.scope, { mood: 'surprise', format: 'audio' }), 'hardcover')
      expect(picks.map((p) => [p.hardcoverId, p.audiobook, p.formats])).toEqual([
        [101, 'yes', ['audiobook']],
        [103, 'unknown', []],
      ])
    })

    it('under light, explore picks must be light', async () => {
      await household()
      const a = await person()
      await recs(a.user.id, [101, 102])
      await saveExternalBooks(t.db, [external(101, { pages: 800 }), external(102, { pages: 200, tags: { genre: [], mood: ['funny'] } })], NOW)
      expect(list(await get(a.scope, { mood: 'light' }), 'hardcover').map((p) => p.hardcoverId)).toEqual([102])
    })

    it('marks a pick already on this person’s wishlist, and not another person’s', async () => {
      await household()
      const a = await person()
      const b = await person()
      await recs(a.user.id, [101])
      await recs(b.user.id, [101])
      const wished = await createWork(t.db, workInput({ title: 'E101', editions: [{ format: 'physical' }] }))
      await t.db.delete(editions).where(eq(editions.workId, wished))
      await saveMatch(t.db, wished, { kind: 'manual', book: data(101) }, NOW)
      await upsertWish(t.db, a.scope, wished, { formats: [], language: null, note: null })
      expect(list(await get(a.scope, { mood: 'surprise' }), 'hardcover')[0]).toMatchObject({ hardcoverId: 101, onWishlist: true })
      expect(list(await get(b.scope, { mood: 'surprise' }), 'hardcover')[0]).toMatchObject({ hardcoverId: 101, onWishlist: false })
    })

    it('keeps a wished pick on the page when other works hold copies and the person has read other books', async () => {
      await household()
      const a = await person()
      await recs(a.user.id, [101])
      // a held, read, matched book elsewhere in the library must not make the wished one count as held or read
      await book(a.scope, 'Elsewhere', { status: 'read', hc: { id: 900 } })
      const wished = await createWork(t.db, workInput({ title: 'E101', editions: [{ format: 'physical' }] }))
      await t.db.delete(editions).where(eq(editions.workId, wished))
      await saveMatch(t.db, wished, { kind: 'manual', book: data(101) }, NOW)
      await upsertWish(t.db, a.scope, wished, { formats: [], language: null, note: null })
      expect(list(await get(a.scope, { mood: 'surprise' }), 'hardcover')[0]).toMatchObject({ hardcoverId: 101, onWishlist: true })
    })

    it('shows at most 5 per list and hides empty lists', async () => {
      await household()
      const a = await person()
      await recs(a.user.id, [1, 2, 3, 4, 5, 6, 7])
      for (let i = 0; i < 7; i++) await book(a.scope, `Shelf ${i}`)
      const v = await get(a.scope, { mood: 'surprise' })
      expect(list(v, 'hardcover').map((p) => p.hardcoverId)).toEqual([1, 2, 3, 4, 5])
      expect(list(v, 'shelf')).toHaveLength(5)
      expect(v.lists.map((l) => l.source)).toEqual(['shelf', 'hardcover'])
    })

    it('picks the next position after the highest read, skipping a novella; a library work at that position hides it', async () => {
      await household()
      const a = await person()
      await cradle(a.scope, a.user.id)
      expect(list(await get(a.scope, { mood: 'keep_going' }), 'series').map((p) => p.position)).toEqual([3])
      await book(a.scope, 'Cradle 3 owned', { series: { name: 'Cradle', position: 3 }, hc: { id: 13 } })
      expect(list(await get(a.scope, { mood: 'keep_going' }), 'series')).toEqual([])
    })

    it('does not show another person’s series, and leaves out a series book on my Read list', async () => {
      await household()
      const a = await person()
      const b = await person()
      await cradle(a.scope, a.user.id)
      expect(list(await get(b.scope, { mood: 'keep_going' }), 'series')).toEqual([])
      const accountA = await linked(a.user.id)
      await saveHardcoverRead(t.db, accountA, [13], NOW)
      expect(list(await get(a.scope, { mood: 'keep_going' }), 'series')).toEqual([])
    })

    it('new from your authors: a release 3 months ahead is "Coming <date>", one 30 months ago is out', async () => {
      await household()
      const a = await person()
      for (const [i, id] of [301, 302, 303].entries()) await book(a.scope, `Wight ${i}`, { authors: ['Will Wight'], status: 'read', hc: { id } })
      await saveExternalBooks(
        t.db,
        [
          external(301, { authors: ['Will Wight'], authorIds: [9] }),
          external(401, { title: 'Soon', authors: ['Will Wight'], releaseDate: '2027-01-20' }),
          external(402, { title: 'Recent', authors: ['Will Wight'], releaseDate: '2026-03-02' }),
          external(403, { title: 'Ancient', authors: ['Will Wight'], releaseDate: '2024-04-01' }),
          external(404, { title: 'Far future', authors: ['Will Wight'], releaseDate: '2027-09-01' }),
        ],
        NOW,
      )
      await saveHardcoverAuthors(
        t.db,
        [
          {
            authorId: 9,
            books: [
              { id: 401, title: 'Soon', releaseDate: '2027-01-20' },
              { id: 402, title: 'Recent', releaseDate: '2026-03-02' },
              { id: 403, title: 'Ancient', releaseDate: '2024-04-01' },
              { id: 404, title: 'Far future', releaseDate: '2027-09-01' },
            ],
          },
        ],
        NOW,
      )
      const v = await get(a.scope, { mood: 'light' })
      expect(list(v, 'author').map((p) => [p.title, p.reason])).toEqual([
        ['Soon', 'Coming 2027-01-20'],
        ['Recent', 'New from Will Wight · 2026'],
      ])
      expect(v.favoriteAuthors).toMatchObject([{ name: 'Will Wight', hardcoverAuthorId: 9, why: 'auto' }])
    })
  })

  describe('one book per series and the first unread', () => {
    it('shows one shelf pick per series: the lowest position, the freed slot going to the next work', async () => {
      const a = await person()
      for (const n of [3, 1, 2]) await book(a.scope, `Saga ${n}`, { series: { name: 'Saga', position: n } })
      await book(a.scope, 'Standalone')
      const picks = list(await get(a.scope), 'shelf')
      expect(picks.map((p) => p.title).sort()).toEqual(['Saga 1', 'Standalone'])
      expect(picks.find((p) => p.title === 'Saga 1')?.firstUnread).toBeNull()
    })

    it('drops a pick whose series an earlier list already shows, and the freed slot goes to the next candidate', async () => {
      await household()
      const a = await person()
      await book(a.scope, 'Saga 1', { series: { name: 'The Saga', position: 1 } })
      const account = await linked(a.user.id)
      await saveRecommendations(t.db, account, [101, 102, 103, 104, 105, 106], NOW)
      await saveExternalBooks(t.db, [101, 102, 103, 104, 105, 106].map((id) => external(id, id === 101 ? { seriesName: 'the saga', position: 4 } : {})), NOW)
      const v = await get(a.scope, { mood: 'surprise' })
      expect(list(v, 'shelf').map((p) => p.title)).toEqual(['Saga 1'])
      expect(list(v, 'hardcover').map((p) => p.hardcoverId)).toEqual([102, 103, 104, 105, 106])
    })

    it('keeps one pick per series inside an exploration list too, by lowest position', async () => {
      await household()
      const a = await person()
      const account = await linked(a.user.id)
      await saveRecommendations(t.db, account, [101, 102, 103], NOW)
      await saveExternalBooks(t.db, [external(101, { seriesName: 'Far', position: 5 }), external(102, { seriesName: 'Far', position: 2 }), external(103)], NOW)
      expect(list(await get(a.scope, { mood: 'surprise' }), 'hardcover').map((p) => p.hardcoverId)).toEqual([102, 103])
    })

    /** Saga 1 (read, Hardcover 11), Saga 3 (held, 13, the pick); Hardcover lists 1, 2 and 3 of Saga as series 500. */
    async function saga(scope: UserScope, readTwo: boolean) {
      await household()
      const w1 = await book(scope, 'Saga 1', { series: { name: 'Saga', position: 1 }, status: 'read', hc: { id: 11 } })
      await book(scope, 'Saga 3', { series: { name: 'Saga', position: 3 }, hc: { id: 13 } })
      await saveExternalBooks(t.db, [external(11, { series: [entry(500, 'Saga')] }), external(13, { series: [entry(500, 'Saga')] })], NOW)
      await saveHardcoverSeries(
        t.db,
        [{ seriesId: 500, name: 'Saga', books: [{ id: 11, position: 1, title: 'Saga 1', releaseDate: null }, { id: 12, position: 2, title: 'Saga Two', releaseDate: null }, { id: 13, position: 3, title: 'Saga 3', releaseDate: null }] }],
        NOW,
      )
      if (readTwo) await book(scope, 'Saga 2', { series: { name: 'Saga', position: 2 }, status: 'read' })
      return w1
    }

    it('names the first unread book of the shelf pick’s series: one only in the cached Hardcover list', async () => {
      const a = await person()
      await saga(a.scope, false)
      const [pick] = list(await get(a.scope), 'shelf')
      expect(pick).toMatchObject({ title: 'Saga 3', position: 3, firstUnread: { title: 'Saga Two', position: 2 } })
    })

    it('names a held but unread book the person hid, and none when the earlier books are read', async () => {
      const a = await person()
      const two = await book(a.scope, 'Saga 2', { series: { name: 'Saga', position: 2 } })
      await book(a.scope, 'Saga 3', { series: { name: 'Saga', position: 3 } })
      await t.db.insert(whatNextHidden).values({ userId: a.user.id, pickKey: `work:${two}` })
      expect(list(await get(a.scope), 'shelf')[0]).toMatchObject({ title: 'Saga 3', firstUnread: { title: 'Saga 2', position: 2 } })
      await setStatus(t.db, a.scope, two, 'read')
      expect(list(await get(a.scope), 'shelf')[0]).toMatchObject({ title: 'Saga 3', firstUnread: null })
    })

    it('counts the cached Hardcover books of read library works as read, and the library’s own position as the last word', async () => {
      const a = await person()
      await saga(a.scope, true)
      // Saga 2 is read in the library but not matched to Hardcover: the cached "Saga Two" at position 2 must not count as unread
      expect(list(await get(a.scope), 'shelf')[0]).toMatchObject({ title: 'Saga 3', firstUnread: null })
    })

    it('never names a novella or prequel as the first unread book', async () => {
      const a = await person()
      await book(a.scope, 'Saga 1', { series: { name: 'Saga', position: 1 }, status: 'read' })
      const hiddenOnes = [await book(a.scope, 'Saga 0.5', { series: { name: 'Saga', position: 0.5 } }), await book(a.scope, 'Saga 2', { series: { name: 'Saga', position: 2 } }), await book(a.scope, 'Saga 2.5', { series: { name: 'Saga', position: 2.5 } })]
      await book(a.scope, 'Saga 3', { series: { name: 'Saga', position: 3 } })
      for (const w of hiddenOnes) await t.db.insert(whatNextHidden).values({ userId: a.user.id, pickKey: `work:${w}` })
      expect(list(await get(a.scope), 'shelf')[0]).toMatchObject({ title: 'Saga 3', firstUnread: { title: 'Saga 2', position: 2 } })
    })

    it('counts every position of a read box set as read, even when a separate work sits at one of them', async () => {
      const a = await person()
      await book(a.scope, 'Saga Box', { series: { name: 'Saga', position: 1, positionEnd: 3 }, status: 'read' })
      const two = await book(a.scope, 'Saga Two', { series: { name: 'Saga', position: 2 } })
      await book(a.scope, 'Saga 4', { series: { name: 'Saga', position: 4 } })
      await t.db.insert(whatNextHidden).values({ userId: a.user.id, pickKey: `work:${two}` })
      expect(list(await get(a.scope), 'shelf')[0]).toMatchObject({ title: 'Saga 4', firstUnread: null })
    })

    it('counts a book on this person’s Hardcover Read list as read for the first unread line: a cached one and a matched library work', async () => {
      const a = await person()
      const b = await person()
      const w1 = await saga(a.scope, false)
      await setStatus(t.db, b.scope, w1, 'read')
      const accountA = await linked(a.user.id)
      const shelf = (scope: UserScope) => get(scope).then((v) => list(v, 'shelf')[0])
      expect((await shelf(a.scope))?.firstUnread).toEqual({ title: 'Saga Two', position: 2 })
      await saveHardcoverRead(t.db, accountA, [12], NOW)
      expect((await shelf(a.scope))?.firstUnread).toBeNull()
      expect((await shelf(b.scope))?.firstUnread).toEqual({ title: 'Saga Two', position: 2 })
      // a library work of the series that is matched to a Read-list id, though its status is not read
      await saveHardcoverRead(t.db, accountA, [], NOW)
      const two = await book(a.scope, 'Saga 2', { series: { name: 'Saga', position: 2 }, hc: { id: 12 } })
      await t.db.insert(whatNextHidden).values({ userId: a.user.id, pickKey: `work:${two}` })
      expect((await shelf(a.scope))?.firstUnread).toEqual({ title: 'Saga 2', position: 2 })
      await saveHardcoverRead(t.db, accountA, [12], NOW)
      expect((await shelf(a.scope))?.firstUnread).toBeNull()
    })

    it('counts a series book on this person’s Hardcover Read list as read when choosing the next in series', async () => {
      await household()
      const a = await person()
      const b = await person()
      const one = await book(a.scope, 'Cradle 1', { series: { name: 'Cradle', position: 1 }, status: 'read', hc: { id: 11 } })
      await setStatus(t.db, b.scope, one, 'read')
      await saveExternalBooks(t.db, [external(11, { series: [entry(500, 'Cradle')] })], NOW)
      await saveHardcoverSeries(
        t.db,
        [{ seriesId: 500, name: 'Cradle', books: [{ id: 11, position: 1, title: 'Cradle 1', releaseDate: null }, { id: 12, position: 2, title: 'Cradle 2', releaseDate: null }, { id: 13, position: 3, title: 'Cradle 3', releaseDate: null }] }],
        NOW,
      )
      await linked(b.user.id)
      const accountA = await linked(a.user.id)
      await saveHardcoverRead(t.db, accountA, [12], NOW)
      expect(list(await get(a.scope, { mood: 'keep_going' }), 'series').map((p) => p.hardcoverId)).toEqual([13])
      // B read the same local book but has nothing on a Read list: still offered book 2
      expect(list(await get(b.scope, { mood: 'keep_going' }), 'series').map((p) => p.hardcoverId)).toEqual([12])
    })

    it('names the first unread book of a Hardcover pick’s cached series, none when read or not cached', async () => {
      await household()
      const a = await person()
      const account = await linked(a.user.id)
      await saveRecommendations(t.db, account, [101], NOW)
      await saveExternalBooks(t.db, [external(101, { title: 'Book Two', seriesName: 'Stormlight', position: 2, series: [entry(10, 'The Cosmere'), entry(600, 'Stormlight')] })], NOW)
      const first = () => get(a.scope, { mood: 'surprise' }).then((v) => list(v, 'hardcover')[0])
      expect((await first())?.firstUnread).toBeNull()
      await saveHardcoverSeries(
        t.db,
        [{ seriesId: 600, name: 'Stormlight', books: [{ id: 100, position: 1, title: 'Book One', releaseDate: null }, { id: 101, position: 2, title: 'Book Two', releaseDate: null }] }],
        NOW,
      )
      expect((await first())?.firstUnread).toEqual({ title: 'Book One', position: 1 })
      await saveHardcoverRead(t.db, account, [100], NOW)
      expect((await first())?.firstUnread).toBeNull()
    })
  })

  describe('per-person isolation', () => {
    it('(review focus 2) another person’s ratings, follows, hides and finish never reach me', async () => {
      await household()
      const a = await person()
      const b = await person()
      // both can see the same works
      for (const n of [1, 2]) {
        const w = await book(b.scope, `B read ${n}`, { authors: ['Bee Author'], status: 'read', rating: 5 })
        await finish(b.user.id, w)
      }
      await book(a.scope, 'A reads once', { authors: ['Bee Author'], status: 'read' })
      await book(b.scope, 'By Bee')
      const vb = await get(b.scope)
      expect(vb.favoriteAuthors.map((f) => f.name)).toEqual(['Bee Author'])
      expect(vb.lastFinished).not.toBeNull()
      const va = await get(a.scope)
      expect(va.favoriteAuthors).toEqual([])
      expect(va.lastFinished).toBeNull()
      expect(va.preselected).toBe('surprise')
      // B follows
      await t.db.insert(authorFollows).values({ userId: b.user.id, hardcoverAuthorId: 7, mode: 'follow', name: 'Followed By B' })
      expect((await get(a.scope)).favoriteAuthors).toEqual([])
      const hiddenFromB = await get(b.scope)
      expect(hiddenFromB.favoriteAuthors.map((f) => f.name).sort()).toEqual(['Bee Author', 'Followed By B'])
      await t.db.update(userWorks).set({ rating: 1 }).where(eq(userWorks.userId, a.user.id))
      expect((await get(b.scope)).lastFinished?.title).toBe('B read 2')
    })

    it('B hiding a work or a Hardcover pick and unfollowing an author leaves A untouched', async () => {
      await household()
      const a = await person()
      const b = await person()
      for (const n of [1, 2, 3]) await book(a.scope, `Ann read ${n}`, { authors: ['Ann Author'], status: 'read' })
      const unread = await book(a.scope, 'Unread for A', { authors: ['Other Author'] })
      const account = await linked(a.user.id)
      await saveRecommendations(t.db, account, [201], NOW)
      await saveExternalBooks(t.db, [external(201)], NOW)
      const before = await get(a.scope, { mood: 'surprise' })
      expect(list(before, 'shelf').map((p) => p.workId)).toContain(unread)
      expect(list(before, 'hardcover').map((p) => p.hardcoverId)).toEqual([201])
      expect(before.favoriteAuthors.map((f) => f.name)).toEqual(['Ann Author'])
      const [ann] = await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, 'Ann Author'))
      await t.db.insert(whatNextHidden).values([
        { userId: b.user.id, pickKey: `work:${unread}` },
        { userId: b.user.id, pickKey: 'hc:201' },
      ])
      await t.db.insert(authorFollows).values({ userId: b.user.id, contributorId: ann?.id ?? '', mode: 'unfollow', name: 'Ann Author' })
      const after = await get(a.scope, { mood: 'surprise' })
      expect(list(after, 'shelf').map((p) => p.workId)).toContain(unread)
      expect(list(after, 'hardcover').map((p) => p.hardcoverId)).toEqual([201])
      expect(after.favoriteAuthors.map((f) => f.name)).toEqual(['Ann Author'])
    })

    it('reports each person’s saved format and pasted answer', async () => {
      const a = await person()
      const b = await person()
      await t.db.insert(whatNextPrefs).values({ userId: b.user.id, format: 'any', aiAnswer: 'secret', aiPastedAt: NOW })
      const forA = await getWhatNext(t.db, a.scope, { mood: null, format: null, today: TODAY })
      const forB = await getWhatNext(t.db, b.scope, { mood: null, format: null, today: TODAY })
      expect([forA.format, forA.aiAnswer]).toEqual(['audio', null])
      expect([forB.format, forB.aiAnswer]).toEqual(['any', { text: 'secret', pastedAt: NOW }])
    })
  })

  describe('prompt input', () => {
    it('contains only this person’s reads, ratings and favorites', async () => {
      const a = await person()
      const b = await person()
      const mine = await book(a.scope, 'Mine', { status: 'read', rating: 4.5 })
      await finish(a.user.id, mine)
      for (const n of [1, 2, 3]) await book(b.scope, `Theirs ${n}`, { authors: ['Bee Author'], status: 'read', rating: 5 })
      const input = await promptInputFor(t.db, a.scope, 'light', 'audio')
      expect(input).toMatchObject({ mood: 'light', format: 'audio', lastFinished: { title: 'Mine', rating: 4.5 }, favoriteAuthors: [], seriesInProgress: [] })
      expect(input.read).toEqual([{ title: 'Mine', authors: ['Ann Author'] }])
      expect(input.topRated).toEqual([{ title: 'Mine', authors: ['Ann Author'], rating: 4.5 }])
      const theirs = await promptInputFor(t.db, b.scope, 'surprise', 'any')
      expect(theirs.favoriteAuthors).toEqual(['Bee Author'])
      expect(theirs.lastFinished).toBeNull()
      expect(theirs.read.map((r) => r.title).sort()).toEqual(['Theirs 1', 'Theirs 2', 'Theirs 3'])
    })

    it('lists the series in progress with the next local position', async () => {
      const a = await person()
      await book(a.scope, 'S1', { series: { name: 'Saga', position: 1 }, status: 'read' })
      await book(a.scope, 'S2', { series: { name: 'Saga', position: 2 } })
      expect((await promptInputFor(t.db, a.scope, 'keep_going', 'any')).seriesInProgress).toEqual([{ series: 'Saga', nextPosition: 2 }])
    })
  })

  describe('readTitlesFor', () => {
    it('returns every title and author name of read works, newest finish first, and nothing of another person', async () => {
      const a = await person()
      const b = await person()
      const older = await book(a.scope, 'Older', { status: 'read', authors: ['Ann Author'] })
      const newer = await book(a.scope, 'Newer', { status: 'read', authors: ['Ann Author'] })
      await book(b.scope, 'Not mine', { status: 'read' })
      await book(a.scope, 'Unread')
      const olderSession = await finish(a.user.id, older, '2026-01-01')
      const newerSession = await finish(a.user.id, newer, '2026-02-01')
      await t.db.update(readingSessions).set({ updatedAt: new Date('2026-01-01T00:00:00Z') }).where(eq(readingSessions.id, olderSession))
      await t.db.update(readingSessions).set({ updatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(readingSessions.id, newerSession))
      const titles = await readTitlesFor(t.db, a.scope)
      expect(titles.map((x) => x.title)).toEqual(['Newer', 'Older'])
      expect(titles[0]?.authors).toContain('Ann Author')
    })
  })

  describe('per-person writes', () => {
    const aiPick = (over: Partial<AiPick> = {}): AiPick => ({ title: 'Worm', authors: ['Wildbow'], kind: 'web_serial', series: null, position: null, url: 'https://parahumans.wordpress.com/', format_note: null, reason: 'Long and gripping', ...over })

    it('hides and unhides a pick, once per person', async () => {
      const a = await person()
      const b = await person()
      await hidePick(t.db, a.scope, 'hc:5')
      await hidePick(t.db, a.scope, 'hc:5')
      await hidePick(t.db, b.scope, 'hc:5')
      expect(await t.db.select().from(whatNextHidden).where(eq(whatNextHidden.userId, a.user.id))).toHaveLength(1)
      await unhidePick(t.db, a.scope, 'hc:5')
      expect(await t.db.select().from(whatNextHidden).where(eq(whatNextHidden.userId, a.user.id))).toHaveLength(0)
      expect(await t.db.select().from(whatNextHidden).where(eq(whatNextHidden.userId, b.user.id))).toHaveLength(1)
    })

    it('follows, flips and removes authors, unique per person and author, listed only for their person', async () => {
      const a = await person()
      const b = await person()
      await book(a.scope, 'Followed')
      const [c] = await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, 'Ann Author'))
      const contributorId = c?.id ?? ''
      await setAuthorFollow(t.db, a.scope, { contributorId }, 'follow')
      await setAuthorFollow(t.db, a.scope, { contributorId }, 'unfollow')
      await setAuthorFollow(t.db, a.scope, { hardcoverAuthorId: 77, name: 'Hardy' }, 'follow')
      await setAuthorFollow(t.db, a.scope, { hardcoverAuthorId: 77, name: 'Hardy' }, 'follow')
      await setAuthorFollow(t.db, b.scope, { hardcoverAuthorId: 99, name: 'Other' }, 'follow')
      const mine = await listAuthorFollows(t.db, a.scope)
      expect(mine).toHaveLength(2)
      expect(mine).toContainEqual({ contributorId, hardcoverAuthorId: null, name: 'Ann Author', mode: 'unfollow' })
      expect(mine).toContainEqual({ contributorId: null, hardcoverAuthorId: 77, name: 'Hardy', mode: 'follow' })
      await setAuthorFollow(t.db, a.scope, { contributorId }, null)
      await setAuthorFollow(t.db, a.scope, { hardcoverAuthorId: 77, name: 'Hardy' }, null)
      expect(await listAuthorFollows(t.db, a.scope)).toEqual([])
      expect(await listAuthorFollows(t.db, b.scope)).toHaveLength(1)
    })

    it('saves the format and the AI answer, and null clears the answer', async () => {
      const a = await person()
      await saveWhatNextFormat(t.db, a.scope, 'any')
      await saveAiAnswer(t.db, a.scope, '[{"title":"x"}]', NOW)
      const [stored] = await t.db.select().from(whatNextPrefs).where(eq(whatNextPrefs.userId, a.user.id))
      expect(stored).toMatchObject({ format: 'any', aiAnswer: '[{"title":"x"}]', aiPastedAt: NOW })
      await saveAiAnswer(t.db, a.scope, null, NOW)
      const [cleared] = await t.db.select().from(whatNextPrefs).where(eq(whatNextPrefs.userId, a.user.id))
      expect(cleared).toMatchObject({ format: 'any', aiAnswer: null, aiPastedAt: null })
    })

    it('wishes a Hardcover pick once: the second add is idempotent, with one work and one wish', async () => {
      const a = await person()
      await saveExternalBooks(t.db, [external(300, { title: 'Brand New', authors: ['New Author'], seriesName: 'Saga', position: 4 })], NOW)
      const first = await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 300, reason: 'Next in Saga' })
      const second = await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 300, reason: 'Next in Saga' })
      expect(first.created).toBe(true)
      expect(second).toEqual({ workId: first.workId, created: false })
      expect(await t.db.select().from(works).where(eq(works.title, 'Brand New'))).toHaveLength(1)
      const rows = await t.db.select().from(wishes).where(eq(wishes.userId, a.user.id))
      expect(rows).toHaveLength(1)
      // the chip does not choose a format: the person sets it on the Wishlist
      expect(rows[0]).toMatchObject({ formats: [], note: 'Next in Saga' })
      expect(rows[0]?.page).toMatchObject({ provider: 'hardcover', url: 'https://hardcover.app/id/book/300' })
      const [link] = await t.db.select().from(hardcoverBooks).where(eq(hardcoverBooks.workId, first.workId))
      expect(link).toMatchObject({ hardcoverId: 300, match: 'manual' })
    })

    it('puts a Hardcover pick on the work that already has its id, or the same title and author', async () => {
      const a = await person()
      const matched = await book(a.scope, 'Matched', { hc: { id: 301 } })
      await saveExternalBooks(t.db, [external(301, { title: 'Whatever' }), external(302, { title: 'The Same Book', authors: ['Ann Author'] })], NOW)
      const same = await book(a.scope, 'The Same Book', { authors: ['Ann Author'] })
      expect(await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 301 })).toEqual({ workId: matched, created: false })
      expect(await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 302 })).toEqual({ workId: same, created: false })
      const rows = await t.db.select().from(wishes).where(eq(wishes.userId, a.user.id))
      expect(rows.map((r) => r.workId).sort()).toEqual([matched, same].sort())
      expect(rows.every((r) => r.formats.length === 0)).toBe(true)
    })

    it('a Hardcover pick wished onto an existing unmatched work shows as on the Wishlist, with no second wish; another match is kept', async () => {
      await household()
      const a = await person()
      const account = await linked(a.user.id)
      await saveRecommendations(t.db, account, [101, 102], NOW)
      await saveExternalBooks(t.db, [external(101), external(102)], NOW)
      const wished = await createWork(t.db, workInput({ title: 'E101', authors: ['Somebody'], editions: [{ format: 'physical' }] }))
      await t.db.delete(editions).where(eq(editions.workId, wished))
      const other = await createWork(t.db, workInput({ title: 'E102', authors: ['Somebody'], editions: [{ format: 'physical' }] }))
      await t.db.delete(editions).where(eq(editions.workId, other))
      await saveMatch(t.db, other, { kind: 'manual', book: data(900) }, NOW)
      const before = list(await get(a.scope, { mood: 'surprise' }), 'hardcover')
      expect(before.map((p) => [p.hardcoverId, p.onWishlist])).toEqual([[101, false], [102, false]])
      expect(await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 101 })).toEqual({ workId: wished, created: false })
      expect(await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 101 })).toEqual({ workId: wished, created: false })
      expect(await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 102 })).toEqual({ workId: other, created: false })
      const after = list(await get(a.scope, { mood: 'surprise' }), 'hardcover')
      // the work linked to 900 keeps that link, and its pick shows as wished through the same title and author
      expect(after.map((p) => [p.hardcoverId, p.onWishlist])).toEqual([[101, true], [102, true]])
      expect(await t.db.select().from(wishes).where(eq(wishes.userId, a.user.id))).toHaveLength(2)
      const [kept] = await t.db.select().from(hardcoverBooks).where(eq(hardcoverBooks.workId, other))
      expect(kept).toMatchObject({ hardcoverId: 900 })
    })

    it('a pick wished onto a work linked to another Hardcover id shows as on the Wishlist', async () => {
      await household()
      const a = await person()
      const linkedWork = await createWork(t.db, workInput({ title: 'Twice Listed', authors: ['Ann Author'], editions: [{ format: 'physical' }] }))
      await t.db.delete(editions).where(eq(editions.workId, linkedWork))
      await saveMatch(t.db, linkedWork, { kind: 'manual', book: data(111) }, NOW)
      const account = await linked(a.user.id)
      await saveRecommendations(t.db, account, [222], NOW)
      await saveExternalBooks(t.db, [external(222, { title: 'Twice Listed', authors: ['Ann Author'] })], NOW)
      expect(await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 222 })).toEqual({ workId: linkedWork, created: false })
      const [link] = await t.db.select().from(hardcoverBooks).where(eq(hardcoverBooks.workId, linkedWork))
      expect(link).toMatchObject({ hardcoverId: 111 })
      const picks = list(await get(a.scope, { mood: 'surprise' }), 'hardcover')
      expect(picks.map((p) => [p.hardcoverId, p.onWishlist, p.workId])).toEqual([[222, true, linkedWork]])
    })

    it('throws not found for a Hardcover id that was never cached', async () => {
      const a = await person()
      await expect(wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 9999 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('wishing again leaves the formats the person set on the Wishlist alone', async () => {
      const a = await person()
      await saveExternalBooks(t.db, [external(300, { title: 'Brand New', authors: ['New Author'] })], NOW)
      const first = await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 300 })
      await t.db.update(wishes).set({ formats: ['audiobook'] }).where(eq(wishes.workId, first.workId))
      await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 300 })
      expect((await t.db.select().from(wishes).where(eq(wishes.workId, first.workId)))[0]?.formats).toEqual(['audiobook'])
    })

    it('wishing again keeps the note the person wrote; the reason fills only an empty note', async () => {
      const a = await person()
      await saveExternalBooks(t.db, [external(300, { title: 'Brand New', authors: ['New Author'] })], NOW)
      const first = await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 300, reason: 'Next in Saga' })
      const note = () => t.db.select().from(wishes).where(eq(wishes.workId, first.workId)).then((r) => r[0]?.note)
      await t.db.update(wishes).set({ note: 'Mum recommended it' }).where(eq(wishes.workId, first.workId))
      await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 300, reason: 'Next in Saga' })
      expect(await note()).toBe('Mum recommended it')
      await t.db.update(wishes).set({ note: null }).where(eq(wishes.workId, first.workId))
      await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 300, reason: 'Next in Saga' })
      expect(await note()).toBe('Next in Saga')
    })

    it('a work whose Hardcover match was rejected gets the picked id as a manual match', async () => {
      const a = await person()
      const w = await book(a.scope, 'Rejected Match', { authors: ['Ann Author'] })
      await saveMatch(t.db, w, { kind: 'none' }, NOW)
      await saveExternalBooks(t.db, [external(310, { title: 'Rejected Match', authors: ['Ann Author'] })], NOW)
      expect(await wishFromPick(t.db, a.scope, { kind: 'hardcover', hardcoverId: 310 })).toEqual({ workId: w, created: false })
      const [link] = await t.db.select().from(hardcoverBooks).where(eq(hardcoverBooks.workId, w))
      expect(link).toMatchObject({ hardcoverId: 310, match: 'manual' })
    })

    it('wishes an AI fanfiction pick with its link and no format, with the reason as the note', async () => {
      const a = await person()
      const r = await wishFromPick(t.db, a.scope, { kind: 'ai', pick: aiPick() })
      expect(r.created).toBe(true)
      const [wish] = await t.db.select().from(wishes).where(eq(wishes.workId, r.workId))
      expect(wish).toMatchObject({ formats: [], note: 'Long and gripping' })
      expect(wish?.page).toMatchObject({ provider: 'ai', url: 'https://parahumans.wordpress.com/' })
      expect(await t.db.select().from(hardcoverBooks).where(eq(hardcoverBooks.workId, r.workId))).toHaveLength(0)
      const again = await wishFromPick(t.db, a.scope, { kind: 'ai', pick: aiPick() })
      expect(again).toEqual({ workId: r.workId, created: false })
    })

    it('lists only this person wished titles and author names', async () => {
      const a = await person()
      const b = await person()
      await wishFromPick(t.db, a.scope, { kind: 'ai', pick: aiPick({ title: 'Mine', authors: ['Ann'] }) })
      await wishFromPick(t.db, b.scope, { kind: 'ai', pick: aiPick({ title: 'Theirs', authors: ['Bob'] }) })
      expect(await wishedTitles(t.db, a.scope)).toEqual([{ title: 'Mine', authors: ['Ann'] }])
    })
  })
})
