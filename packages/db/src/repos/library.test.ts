import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { EditionInput, LibraryQuery, normalizeText, WishFields } from '@mylib/domain'
import { assets, contributorNames, contributors, editions, series, userHiddenWorks, seriesNames, userWorks, users, workContributors, workSearch, workTitles } from '../schema'
import { seedName, seedUser, seedWork, useTestDb, workInput } from '../testing'
import { addEdition, createWork, getWorkDetail } from './catalog'
import { getWorkCards, listFacets, listLibrary, listWorks } from './library'
import { backfillSearchAcronyms, refreshSearchDocument } from './search-index'
import { loadUserScope } from './scope'
import { addWorkToSet, getDefaultPersonalSetId } from './sets'
import { addToQueue, setRating } from './tracking'
import { upsertWish } from './wishlist'
import type { Db } from '../client'

async function seedShelf(db: Db) {
  const ids = {
    finalEmpire: await createWork(db, workInput()),
    wellOfAscension: await createWork(db, workInput({ title: 'The Well of Ascension', series: [{ name: 'Mistborn', position: 2 }] })),
    empireOfSilence: await createWork(
      db,
      workInput({ title: 'Empire of Silence', authors: ['Christopher Ruocchio'], series: [{ name: 'Sun Eater', position: 1 }] }),
    ),
    leviathan: await createWork(
      db,
      workInput({ title: 'Leviathan Wakes', authors: ['James S. A. Corey'], series: [{ name: 'The Expanse', position: 1 }] }),
    ),
    miserables: await createWork(db, workInput({ title: 'Les Misérables', authors: ['Victor Hugo'], series: [] })),
    littlePrince: await createWork(db, workInput({ title: 'הנסיך הקטן', authors: ['אנטואן דה סנט-אכזופרי'], series: [] })),
    endersGame: await createWork(db, workInput({ title: "Ender's Game", authors: ['Orson Scott Card'], series: [] })),
  }
  return ids
}

describe('library & search', () => {
  const t = useTestDb()
  const query = (q: Partial<LibraryQuery>) => LibraryQuery.parse({ scope: 'catalog', ...q })
  const titles = async (scope: Awaited<ReturnType<typeof loadUserScope>>, q: Partial<LibraryQuery>) =>
    (await listWorks(t.db, scope, query(q))).items.map((i) => i.title)

  async function member() {
    const user = await seedUser(t.db)
    return { user, scope: await loadUserScope(t.db, user) }
  }

  it('matches every query word across fields in any order', async () => {
    await seedShelf(t.db)
    const { scope } = await member()
    expect(await titles(scope, { search: 'brandon empire' })).toEqual(['The Final Empire'])
    expect(await titles(scope, { search: 'empire brandon' })).toEqual(['The Final Empire'])
    expect(await titles(scope, { search: 'mistborn 1' })).toEqual(['The Final Empire'])
  })

  it("finds a book by any other name of its author, credited spelling first", async () => {
    const workId = await createWork(t.db, workInput())
    const [link] = await t.db.select().from(workContributors).where(eq(workContributors.workId, workId))
    await seedName(t.db, link?.contributorId ?? '', 'ברנדון סנדרסון', 'he')
    await refreshSearchDocument(t.db, workId)
    const [doc] = await t.db.select().from(workSearch).where(eq(workSearch.workId, workId))
    expect(doc?.authorText).toBe('brandon sanderson ' + normalizeText('ברנדון סנדרסון'))
    const { scope } = await member()
    expect(await titles(scope, { search: 'סנדרסון' })).toEqual(['The Final Empire'])
  })

  it('tolerates typos, partial words, accents, apostrophes and Hebrew', async () => {
    await seedShelf(t.db)
    const { scope } = await member()
    expect((await titles(scope, { search: 'sandersn mistbourn' })).sort()).toEqual(['The Final Empire', 'The Well of Ascension'])
    expect(await titles(scope, { search: 'leviath' })).toEqual(['Leviathan Wakes'])
    expect(await titles(scope, { search: 'miserables' })).toEqual(['Les Misérables'])
    expect(await titles(scope, { search: 'MISÉRABLES' })).toEqual(['Les Misérables'])
    expect(await titles(scope, { search: 'enders' })).toEqual(["Ender's Game"])
    expect(await titles(scope, { search: 'הנסיך' })).toEqual(['הנסיך הקטן'])
  })

  it('ranks titles that start with the query first', async () => {
    await seedShelf(t.db)
    const { scope } = await member()
    expect(await titles(scope, { search: 'empire' })).toEqual(['Empire of Silence', 'The Final Empire'])
  })

  it('search finds a book by its other-language title and series name', async () => {
    const id = await createWork(t.db, workInput({ title: 'קצב המלחמה', authors: ['Brandon Sanderson'], series: [{ name: 'ארכיון האור', position: 4 }] }))
    await t.db.insert(workTitles).values({ workId: id, language: 'en', title: 'Rhythm of War', sortTitle: 'rhythm of war', primary: false })
    const [row] = await t.db.select({ id: series.id }).from(series)
    await t.db.insert(seriesNames).values({ seriesId: row?.id ?? '', name: 'Stormlight Archive', normalizedName: 'stormlight archive', language: 'en' })
    await refreshSearchDocument(t.db, id)
    const { scope } = await member()
    for (const search of ['rhythm', 'קצב', 'stormlight', 'row']) expect(await titles(scope, { search })).toEqual(['Rhythm of War']) // shown in the viewer's language (#145)
  })

  describe('abbreviations (#73)', () => {
    async function seedIceAndFire() {
      return createWork(
        t.db,
        workInput({ title: 'A Game of Thrones', authors: ['George R. R. Martin'], series: [{ name: 'A Song of Ice and Fire', position: 1 }] }),
      )
    }

    it('finds a book by the first letters of its title, series or author', async () => {
      await seedShelf(t.db)
      await seedIceAndFire()
      const { scope } = await member()
      expect(await titles(scope, { search: 'twoa' })).toEqual(['The Well of Ascension'])
      expect(await titles(scope, { search: 'woa' })).toEqual(['The Well of Ascension'])
      expect(await titles(scope, { search: 'asoiaf' })).toEqual(['A Game of Thrones'])
      expect(await titles(scope, { search: 'SOIAF' })).toEqual(['A Game of Thrones'])
      expect(await titles(scope, { search: 'grrm' })).toEqual(['A Game of Thrones'])
      expect(await titles(scope, { search: 'jsac' })).toEqual(['Leviathan Wakes'])
      expect(await titles(scope, { search: 'הה' })).toEqual(['הנסיך הקטן'])
    })

    it('matches the start of an abbreviation from three letters, and two letters only exactly', async () => {
      await seedShelf(t.db)
      await seedIceAndFire()
      const { scope } = await member()
      expect(await titles(scope, { search: 'asoi' })).toEqual(['A Game of Thrones'])
      expect(await titles(scope, { search: 'lw' })).toEqual(['Leviathan Wakes'])
      expect(await titles(scope, { search: 'ag' })).toEqual([])
    })

    it('still needs every query word: an abbreviation plus a word narrows', async () => {
      await seedShelf(t.db)
      await seedIceAndFire()
      const { scope } = await member()
      expect(await titles(scope, { search: 'asoiaf thrones' })).toEqual(['A Game of Thrones'])
      expect(await titles(scope, { search: 'asoiaf ascension' })).toEqual([])
    })

    it('ranks an exact abbreviation above a title that merely starts with it', async () => {
      await seedShelf(t.db)
      await createWork(t.db, workInput({ title: 'Woad Dyeing', authors: ['Jenny Dean'], series: [] }))
      const { scope } = await member()
      expect(await titles(scope, { search: 'woa' })).toEqual(['The Well of Ascension', 'Woad Dyeing'])
    })

    it('fills in rows written before abbreviations existed', async () => {
      const ids = await seedShelf(t.db)
      await t.db.update(workSearch).set({ acronyms: null })
      const { scope } = await member()
      expect(await titles(scope, { search: 'twoa' })).toEqual([])
      expect(await backfillSearchAcronyms(t.db)).toBe(Object.keys(ids).length)
      expect(await titles(scope, { search: 'twoa' })).toEqual(['The Well of Ascension'])
      expect(await backfillSearchAcronyms(t.db)).toBe(0)
    })
  })

  it('never returns hidden works', async () => {
    const ids = await seedShelf(t.db)
    const { user } = await member()
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: ids.leviathan })
    const scope = await loadUserScope(t.db, user)
    expect(await titles(scope, { search: 'leviath' })).toEqual([])
    expect(await titles(scope, {})).not.toContain('Leviathan Wakes')
    expect((await listFacets(t.db, scope)).authors.map((a) => a.name)).not.toContain('James S. A. Corey')
  })

  it('lists each author once, with their other names as a hint', async () => {
    await createWork(t.db, workInput())
    const [person] = await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, 'Brandon Sanderson'))
    if (!person) throw new Error('seed failed')
    await seedName(t.db, person.id, 'ברנדון סנדרסון', 'he')
    const { scope } = await member()
    expect((await listFacets(t.db, scope)).authors).toEqual([{ id: person.id, name: 'Brandon Sanderson', otherNames: ['ברנדון סנדרסון'] }])
  })

  it('lists the languages of the editions in the facets (#124)', async () => {
    await createWork(t.db, workInput({ title: 'Hebrew', series: [], editions: [{ format: 'physical', language: 'he' }] }))
    await createWork(t.db, workInput({ title: 'Unknown', series: [], editions: [{ format: 'ebook' }] }))
    const { scope } = await member()
    expect((await listFacets(t.db, scope)).languages).toContain('he')
  })

  it('limits the library scope to the personal library', async () => {
    const ids = await seedShelf(t.db)
    const { user, scope } = await member()
    await addWorkToSet(t.db, scope, await getDefaultPersonalSetId(t.db, user.id), ids.finalEmpire)
    expect(await titles(scope, { scope: 'library', search: 'empire' })).toEqual(['The Final Empire'])
    expect(await titles(scope, { scope: 'library' })).toEqual(['The Final Empire'])
  })

  it('hides books with no copies from my library unless I filter for them', async () => {
    const owned = await createWork(t.db, workInput({ title: 'Owned One' }))
    const wanted = (await seedWork(t.db, { title: 'Wanted One', noEditions: true })).workId
    const { user, scope } = await member()
    await t.db.insert(userWorks).values([
      { userId: user.id, workId: owned, status: 'want_to_read' },
      { userId: user.id, workId: wanted, status: 'want_to_read' },
    ])
    expect(await titles(scope, { scope: 'library' })).toEqual(['Owned One'])
    expect(await titles(scope, { scope: 'library', filter: { op: 'availability', values: ['wanted'] } })).toEqual(['Wanted One'])
    // the catalog scope (All books, Home's Recently added, author/series/tag links) hides them too
    expect(await titles(scope, { scope: 'catalog' })).toEqual(['Owned One'])
    expect(await titles(scope, { scope: 'catalog', filter: { op: 'availability', values: ['wanted'] } })).toEqual(['Wanted One'])
    // a picker that must find them (library.search) opts in
    expect((await titles(scope, { scope: 'catalog', includeWanted: true })).sort()).toEqual(['Owned One', 'Wanted One'])
  })

  it('cards say who wishes for the book', async () => {
    const workId = await createWork(t.db, workInput({ title: 'Wished For' }))
    const dana = await seedUser(t.db, { username: 'dana' })
    const danaScope = await loadUserScope(t.db, dana)
    const noa = await seedUser(t.db, { username: 'noa' })
    const noaScope = await loadUserScope(t.db, noa)
    const fields = WishFields.parse({ formats: ['physical'], language: null, note: null })
    await upsertWish(t.db, danaScope, workId, fields)
    await upsertWish(t.db, noaScope, workId, fields)
    const [card] = await getWorkCards(t.db, noaScope, [workId])
    expect(card?.wishedBy).toEqual([
      { userId: dana.id, name: 'dana' },
      { userId: noa.id, name: 'noa' },
    ])
    const [other] = await getWorkCards(t.db, noaScope, [await createWork(t.db, workInput({ title: 'Nobody Wants' }))])
    expect(other?.wishedBy).toEqual([])
  })

  async function memberIn(titleLanguages: string[]) {
    const user = await seedUser(t.db)
    await t.db.update(users).set({ titleLanguages }).where(eq(users.id, user.id))
    return loadUserScope(t.db, user)
  }

  it('two people see one book in their own language', async () => {
    const id = await createWork(t.db, workInput({ title: 'קצב המלחמה', authors: ['ברנדון סנדרסון'], series: [{ name: 'גנזך אורות הסער', position: 4 }] }))
    await t.db.insert(workTitles).values({ workId: id, language: 'en', title: 'Rhythm of War', sortTitle: 'rhythm of war', primary: false })
    const [person] = await t.db.select({ id: contributors.id }).from(contributors)
    await seedName(t.db, person?.id ?? '', 'Brandon Sanderson', 'en')
    await t.db.update(contributorNames).set({ language: 'he' }).where(eq(contributorNames.name, 'ברנדון סנדרסון'))
    const [s] = await t.db.select({ id: series.id }).from(series)
    await t.db.insert(seriesNames).values({ seriesId: s?.id ?? '', name: 'Stormlight Archive', normalizedName: 'stormlight archive', language: 'en' })

    const en = await memberIn(['en', 'he'])
    const he = await memberIn(['he', 'en'])
    const [enCard] = await getWorkCards(t.db, en, [id])
    expect(enCard).toMatchObject({ title: 'Rhythm of War', authors: ['Brandon Sanderson'], series: { name: 'Stormlight Archive' } })
    const [heCard] = await getWorkCards(t.db, he, [id])
    expect(heCard).toMatchObject({ title: 'קצב המלחמה', authors: ['ברנדון סנדרסון'], series: { name: 'גנזך אורות הסער' } })

    // the collapsed library entry for the series is named in the viewer's language too
    const collapsed = async (scope: typeof en) =>
      (await listLibrary(t.db, scope, query({ collapseSeries: true }))).items.map((i) => (i.kind === 'series' ? i.series.name : i.work.title))
    expect(await collapsed(en)).toEqual(['Stormlight Archive'])
    expect(await collapsed(he)).toEqual(['גנזך אורות הסער'])
    for (const sort of ['series', 'added', 'author', 'rating'] as const) expect((await listWorks(t.db, he, query({ sort }))).items.map((i) => i.id)).toEqual([id])
    expect((await listFacets(t.db, en)).series.map((x) => x.name)).toEqual(['Stormlight Archive'])
    expect((await listFacets(t.db, he)).series.map((x) => x.name)).toEqual(['גנזך אורות הסער'])
  })

  it('title sort follows the picked title and pages stably', async () => {
    const mk = async (he: string, en: string) => {
      const id = await createWork(t.db, workInput({ title: he, authors: ['X'], series: [], editions: [{ format: 'physical', language: 'he' }] }))
      await t.db.insert(workTitles).values({ workId: id, language: 'en', title: en, sortTitle: en.toLowerCase(), primary: false })
      return id
    }
    // en order: apple, apple (tie), cherry, mango, zebra   he order: aleph, bet, gimel, dalet(tie with he), he
    const ids = [await mk('ב', 'Zebra'), await mk('א', 'Mango'), await mk('ג', 'Apple'), await mk('ד', 'Apple'), await mk('ה', 'Cherry')]
    const en = await memberIn(['en', 'he'])
    const he = await memberIn(['he', 'en'])
    const pages = async (scope: typeof en) => {
      const seen: string[] = []
      for (const offset of [0, 2, 4]) seen.push(...(await listWorks(t.db, scope, query({ sort: 'title', limit: 2, offset }))).items.map((i) => i.id))
      return seen
    }
    const enIds = await pages(en)
    const heIds = await pages(he)
    expect([...enIds].sort()).toEqual([...ids].sort()) // each exactly once
    expect([...heIds].sort()).toEqual([...ids].sort())
    expect(await titles(en, { sort: 'title' })).toEqual(['Apple', 'Apple', 'Cherry', 'Mango', 'Zebra'])
    expect(enIds).toEqual((await listWorks(t.db, en, query({ sort: 'title', limit: 10 }))).items.map((i) => i.id))
    expect(await titles(he, { sort: 'title' })).toEqual(['א', 'ב', 'ג', 'ד', 'ה'])
    expect(heIds).not.toEqual(enIds)
    // ties break on the work id
    const tied = enIds.slice(0, 2)
    expect(tied).toEqual([...tied].sort())
  })

  it('sorts, pages, filters and counts', async () => {
    const ids = await seedShelf(t.db)
    const { scope } = await member()
    expect((await titles(scope, { sort: 'title' })).slice(0, 3)).toEqual(['Empire of Silence', "Ender's Game", 'The Final Empire'])
    const page = await listWorks(t.db, scope, query({ sort: 'title', limit: 2, offset: 2 }))
    // Alphabetically, "les miserables" < "leviathan wakes" (3rd char 's' < 'v'): verified both with a
    // plain JS string sort and directly against the test Postgres database (`order by` on the literal
    // sort-title values). The brief's expected pair had these swapped.
    expect(page.items.map((i) => i.title)).toEqual(['The Final Empire', 'Les Misérables'])
    expect(page.total).toBe(7)
    expect((await titles(scope, { sort: 'author' }))[0]).toBe("Ender's Game")

    await addEdition(t.db, scope, ids.leviathan, EditionInput.parse({ format: 'audiobook' }))
    expect(await titles(scope, { filter: { op: 'format', formats: ['audiobook'] } })).toEqual(['Leviathan Wakes'])

    await setRating(t.db, scope, ids.leviathan, 5)
    await setRating(t.db, scope, ids.finalEmpire, 3)
    expect((await titles(scope, { sort: 'rating' })).slice(0, 2)).toEqual(['Leviathan Wakes', 'The Final Empire'])

    const setId = await getDefaultPersonalSetId(t.db, scope.userId)
    await addWorkToSet(t.db, scope, setId, ids.miserables)
    expect(await titles(scope, { setId })).toEqual(['Les Misérables'])
  })

  it('builds work cards in the requested order', async () => {
    const ids = await seedShelf(t.db)
    const { scope } = await member()
    await addToQueue(t.db, scope, ids.finalEmpire, 'bottom')
    await setRating(t.db, scope, ids.finalEmpire, 4.5)
    const cards = await getWorkCards(t.db, scope, [ids.finalEmpire, ids.miserables])
    expect(cards.map((c) => c.title)).toEqual(['The Final Empire', 'Les Misérables'])
    expect(cards[0]).toMatchObject({
      authors: ['Brandon Sanderson'],
      series: { name: 'Mistborn', position: 1 },
      formats: ['physical'],
      availability: 'owned',
      status: 'none',
      rating: 4.5,
      inQueue: true,
      wishedBy: [],
    })
    expect(cards[1]?.series).toBeNull()
  })

  it('puts a copy\'s cover on the book card and the book page', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const { workId, editionIds } = await seedWork(t.db, { title: 'Covered', formats: ['physical', 'ebook'] })
    const [asset] = await t.db.insert(assets).values({ kind: 'cover', path: 'covers/ab/x.png', mime: 'image/png', sha256: 'x' }).returning({ id: assets.id })
    await t.db.update(editions).set({ coverAssetId: asset?.id ?? null }).where(eq(editions.id, editionIds[1] ?? ''))
    expect((await getWorkCards(t.db, scope, [workId]))[0]?.coverAssetId).toBe(asset?.id)
    expect((await getWorkDetail(t.db, scope, workId)).coverAssetId).toBe(asset?.id)
  })

  it('picks the same cover on the card and the page even with two same-format editions, deterministically (R19)', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const { workId } = await seedWork(t.db, { title: 'Two Covers', noEditions: true })
    // same createdAt on purpose: forces the tie-break onto edition id
    const tiedAt = new Date('2026-01-01T00:00:00Z')
    const [e1] = await t.db.insert(editions).values({ workId, format: 'physical', createdAt: tiedAt }).returning({ id: editions.id })
    const [e2] = await t.db.insert(editions).values({ workId, format: 'physical', createdAt: tiedAt }).returning({ id: editions.id })
    const [lower, higher] = [e1, e2].sort((a, b) => (a?.id ?? '').localeCompare(b?.id ?? ''))
    const [assetLower] = await t.db
      .insert(assets)
      .values({ kind: 'cover', path: 'covers/aa/lower.png', mime: 'image/png', sha256: 'lower' })
      .returning({ id: assets.id })
    const [assetHigher] = await t.db
      .insert(assets)
      .values({ kind: 'cover', path: 'covers/aa/higher.png', mime: 'image/png', sha256: 'higher' })
      .returning({ id: assets.id })
    // assign the higher-id edition's cover first, to prove the pick isn't "whichever was written first"
    await t.db.update(editions).set({ coverAssetId: assetHigher?.id ?? null }).where(eq(editions.id, higher?.id ?? ''))
    await t.db.update(editions).set({ coverAssetId: assetLower?.id ?? null }).where(eq(editions.id, lower?.id ?? ''))

    const cardCover = (await getWorkCards(t.db, scope, [workId]))[0]?.coverAssetId
    const detailCover = (await getWorkDetail(t.db, scope, workId)).coverAssetId
    expect(cardCover).toBe(detailCover)
    expect(cardCover).toBe(assetLower?.id)
  })
})
