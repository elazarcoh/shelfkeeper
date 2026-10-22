import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { CreateSetInput, EditionInput, WishFields, wishPageFromExtracted, type ExtractedPage } from '@mylib/domain'
import { editionHoldingEvents, queueEntries, readingSessions, setItems, sourceItems, sources, userHiddenWorks, userWorks, wishes, works } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { addEdition, createWork, getWorkDetail } from './catalog'
import { loadUserScope, type UserScope } from './scope'
import { createSet } from './sets'
import { addWishFromPage, boughtWish, listWishes, removeWish, upsertWish, wishesForWork, wishMembers } from './wishlist'

const page = (over: Partial<ExtractedPage> = {}): ExtractedPage => ({
  provider: 'simania',
  providerId: '690482',
  url: 'https://simania.co.il/bookdetails.php?item_id=690482',
  title: 'המושבה האבודה',
  subtitle: null,
  authors: ['אואן קולפר'],
  translators: ['יעל אכמון'],
  publisher: 'כנרת',
  year: '2012',
  publishedOn: null,
  pageCount: 312,
  isbn13: '9789655170009',
  isbn10: null,
  series: { name: 'ארטמיס פאול', position: 5 },
  language: 'he',
  coverUrl: 'https://cdn.simania.co.il/bookimages/covers69/690482.jpg',
  description: null,
  volume: null,
  importedTitle: null,
  ...over,
})

describe('wishlist repository', () => {
  const t = useTestDb()
  const fields = (over: Partial<WishFields> = {}) => WishFields.parse({ formats: ['physical'], language: 'he', note: null, ...over })
  async function member(name = 'dana') {
    const user = await seedUser(t.db, { username: name })
    return { user, scope: await loadUserScope(t.db, user) }
  }

  async function keepAlive(reason: string, workId: string, scope: UserScope) {
    if (reason === 'edition') await addEdition(t.db, scope, workId, EditionInput.parse({ format: 'ebook' }))
    else if (reason === 'wish') await upsertWish(t.db, scope, workId, fields())
    else if (reason === 'status') await t.db.insert(userWorks).values({ userId: scope.userId, workId, status: 'want_to_read' })
    else if (reason === 'rating') await t.db.insert(userWorks).values({ userId: scope.userId, workId, status: 'none', rating: 4 })
    else if (reason === 'review') await t.db.insert(userWorks).values({ userId: scope.userId, workId, status: 'none', review: 'worth a reread' })
    else if (reason === 'session') await t.db.insert(readingSessions).values({ userId: scope.userId, workId, mode: 'read', startedOn: '2026-10-01' })
    else if (reason === 'queue') await t.db.insert(queueEntries).values({ userId: scope.userId, workId, position: 1 })
    else if (reason === 'set') {
      const set = await createSet(t.db, scope, CreateSetInput.parse({ kind: 'manual', scope: 'personal', name: 'Keep' }))
      await t.db.insert(setItems).values({ setId: set.id, workId })
    } else if (reason === 'source') {
      const [src] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
      await t.db.insert(sourceItems).values({
        sourceId: src?.id ?? '',
        externalId: 'li_1',
        normalized: { externalId: 'li_1', format: 'audiobook', title: 'X' } as never,
        contentHash: 'h',
        workId,
        state: 'linked',
      })
    } else throw new Error(`unknown reason ${reason}`)
  }

  it('a page for a book not in the catalog makes a wanted book (no editions) with the wish on it', async () => {
    const { scope } = await member()
    const { workId } = await addWishFromPage(t.db, scope, { page: page(), target: { action: 'create_work' }, fields: fields() })
    const work = await getWorkDetail(t.db, scope, workId)
    expect(work).toMatchObject({ title: 'המושבה האבודה', editions: [] })
    expect(work.authors.map((a) => a.name)).toEqual(['אואן קולפר'])
    expect(work.series.map((s) => s.name)).toEqual(['ארטמיס פאול'])
    const [row] = await listWishes(t.db, scope, scope.userId)
    expect(row).toMatchObject({ workId, formats: ['physical'], language: 'he', page: { publisher: 'כנרת', isbn13: '9789655170009' }, haveFormats: [] })
  })

  it('a page for a book I have attaches the wish to it; adding again updates, never duplicates', async () => {
    const { scope } = await member()
    const workId = await createWork(t.db, workInput({ title: 'A', series: [], editions: [{ format: 'ebook' }] }))
    await addWishFromPage(t.db, scope, { page: page(), target: { action: 'wish_work', workId }, fields: fields() })
    await addWishFromPage(t.db, scope, { page: page(), target: { action: 'wish_work', workId }, fields: fields({ note: 'hardcover' }) })
    const rows = await listWishes(t.db, scope, scope.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ workId, note: 'hardcover', haveFormats: ['ebook'] })
  })

  it('a page without a single known author makes the book under "Unknown author"', async () => {
    const { scope } = await member()
    const { workId } = await addWishFromPage(t.db, scope, { page: page({ authors: [] }), target: { action: 'create_work' }, fields: fields() })
    expect((await getWorkDetail(t.db, scope, workId)).authors.map((a) => a.name)).toEqual(['Unknown author'])
  })

  it('an over-long page field cannot break adding the wish', async () => {
    const { scope } = await member()
    const long = page({ coverUrl: `https://cdn.simania.co.il/${'a'.repeat(3000)}.jpg`, isbn13: '9'.repeat(50) })
    const { workId } = await addWishFromPage(t.db, scope, { page: long, target: { action: 'create_work' }, fields: fields() })
    const [row] = await listWishes(t.db, scope, scope.userId)
    expect(row?.workId).toBe(workId)
    expect(row?.page).toBeNull()
  })

  it('upsertWish from a book page keeps an earlier page snapshot', async () => {
    const { scope } = await member()
    const { workId } = await addWishFromPage(t.db, scope, { page: page(), target: { action: 'create_work' }, fields: fields() })
    await upsertWish(t.db, scope, workId, fields({ formats: [] }))
    expect((await listWishes(t.db, scope, scope.userId))[0]).toMatchObject({ formats: [], page: { publisher: 'כנרת' } })
  })

  it('removing the last wish on a wanted book nobody touched deletes the book', async () => {
    const { scope } = await member()
    const { workId } = await addWishFromPage(t.db, scope, { page: page(), target: { action: 'create_work' }, fields: fields() })
    expect(await removeWish(t.db, scope, workId)).toEqual({ workDeleted: true })
    await expect(getWorkDetail(t.db, scope, workId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('removing a wish I do not have is not found', async () => {
    const { scope } = await member()
    const workId = await createWork(t.db, workInput({ title: 'A', series: [], editions: [{ format: 'ebook' }] }))
    await expect(removeWish(t.db, scope, workId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  // one test per reason the book survives
  it.each([
    ['it has an edition', 'edition'],
    ['someone else still wishes for it', 'wish'],
    ['someone set a status on it', 'status'],
    ['someone rated it without a status', 'rating'],
    ['someone wrote My notes on it without a status', 'review'],
    ['someone queued it', 'queue'],
    ['someone has a reading session on it', 'session'],
    ['it is in a manual set', 'set'],
    ['a source item links it', 'source'],
  ])('removing a wish keeps the book when %s', async (_label, reason) => {
    const { scope } = await member()
    const other = await member('noa')
    const { workId } = await addWishFromPage(t.db, scope, { page: page(), target: { action: 'create_work' }, fields: fields() })
    await keepAlive(reason, workId, other.scope)
    expect(await removeWish(t.db, scope, workId)).toEqual({ workDeleted: false })
    expect((await getWorkDetail(t.db, scope, workId)).id).toBe(workId)
  })

  it('bought adds an owned physical copy pre-filled from the page, records its acquisition and drops the wish', async () => {
    const { scope } = await member()
    const { workId } = await addWishFromPage(t.db, scope, { page: page(), target: { action: 'create_work' }, fields: fields() })
    const result = await boughtWish(t.db, scope, workId, 'physical', '2026-10-13')
    expect(result.coverUrl).toBe('https://cdn.simania.co.il/bookimages/covers69/690482.jpg')
    const work = await getWorkDetail(t.db, scope, workId)
    expect(work.editions).toHaveLength(1)
    expect(work.editions[0]).toMatchObject({ id: result.editionId, format: 'physical', ownership: 'owned', isbn13: '9789655170009', publisher: 'כנרת' })
    expect(await listWishes(t.db, scope, scope.userId)).toEqual([])
    const events = await t.db.select().from(editionHoldingEvents).where(eq(editionHoldingEvents.editionId, result.editionId))
    expect(events).toMatchObject([{ type: 'acquired', occurredOn: '2026-10-13' }])
  })

  it('bought twice fails the second time and makes no second copy', async () => {
    const { scope } = await member()
    const { workId } = await addWishFromPage(t.db, scope, { page: page(), target: { action: 'create_work' }, fields: fields() })
    await boughtWish(t.db, scope, workId, 'physical', '2026-10-13')
    await expect(boughtWish(t.db, scope, workId, 'physical', '2026-10-13')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await getWorkDetail(t.db, scope, workId)).editions).toHaveLength(1)
  })

  it('bought from a page that knows nothing makes a bare copy', async () => {
    const { scope } = await member()
    const bare = page({ translators: [], publisher: null, year: null, pageCount: null, isbn13: null, language: null, coverUrl: null })
    const { workId } = await addWishFromPage(t.db, scope, { page: bare, target: { action: 'create_work' }, fields: fields() })
    const r = await boughtWish(t.db, scope, workId, 'physical', '2026-10-13')
    expect(r.coverUrl).toBeNull()
    expect((await getWorkDetail(t.db, scope, workId)).editions[0]).toMatchObject({ format: 'physical', isbn13: null })
  })

  it('a wish row shows the volumes owned of the wished set', async () => {
    const { scope } = await member()
    const workId = await createWork(t.db, workInput({ title: 'A', series: [], editions: [{ format: 'physical', language: 'he', volume: 1, volumeCount: 2 }] }))
    await upsertWish(t.db, scope, workId, fields({ formats: ['physical'], language: 'he' }))
    const [row] = await listWishes(t.db, scope, scope.userId)
    expect(row?.volumes).toEqual({ have: [1], size: 2, missing: [2], format: 'physical', language: 'he' })
    // a wish for another format sees no such set
    await upsertWish(t.db, scope, workId, fields({ formats: ['ebook'], language: 'he' }))
    expect((await listWishes(t.db, scope, scope.userId))[0]?.volumes).toBeNull()
  })

  it('bought files the copy as the page volume, or the volume asked for; language from the wish or the set', async () => {
    const { scope } = await member()
    const on = '2026-10-13'
    const volumeEditions = async (workId: string) =>
      (await getWorkDetail(t.db, scope, workId)).editions.filter((e) => e.volume !== null).map((e) => ({ volume: e.volume, volumeCount: e.volumeCount, language: e.language }))

    // 1) the page knows its volume
    const w1 = await addWishFromPage(t.db, scope, { page: page({ volume: { number: 2, count: 2 } }), target: { action: 'create_work' }, fields: fields() })
    await boughtWish(t.db, scope, w1.workId, 'physical', on)
    expect(await volumeEditions(w1.workId)).toEqual([{ volume: 2, volumeCount: 2, language: 'he' }])

    // 2) no page: the asked volume joins the book's set, taking its language and count
    const w2 = await createWork(t.db, workInput({ title: 'B', series: [], editions: [{ format: 'physical', language: 'he', volume: 1, volumeCount: 2 }] }))
    await upsertWish(t.db, scope, w2, fields({ language: null }))
    await boughtWish(t.db, scope, w2, 'physical', on, 2)
    expect(await volumeEditions(w2)).toEqual([
      { volume: 1, volumeCount: 2, language: 'he' },
      { volume: 2, volumeCount: 2, language: 'he' },
    ])

    // 3) the page volume wins over an asked volume
    const w3 = await addWishFromPage(t.db, scope, { page: page({ volume: { number: 2, count: 2 } }), target: { action: 'create_work' }, fields: fields() })
    await boughtWish(t.db, scope, w3.workId, 'physical', on, 3)
    expect(await volumeEditions(w3.workId)).toEqual([{ volume: 2, volumeCount: 2, language: 'he' }])
  })

  it('bought joins a null-language set from a "he" page, and keeps the set count', async () => {
    const { scope } = await member()
    const on = '2026-10-13'
    const w1 = await createWork(t.db, workInput({ title: 'C', series: [], editions: [{ format: 'physical', language: null, volume: 1, volumeCount: 3 }] }))
    await upsertWish(t.db, scope, w1, fields({ language: null }), wishPageFromExtracted(page({ language: 'he', volume: { number: 2, count: 2 } })))
    await boughtWish(t.db, scope, w1, 'physical', on)
    const eds = (await getWorkDetail(t.db, scope, w1)).editions.map((e) => [e.volume, e.volumeCount, e.language])
    expect(eds.sort()).toEqual([[1, 3, null], [2, 3, null]])
  })

  it('bought a volume above the set count clears the count of the whole set', async () => {
    const { scope } = await member()
    const on = '2026-10-13'
    const counts = async (workId: string) => (await getWorkDetail(t.db, scope, workId)).editions.map((e) => [e.volume, e.volumeCount]).sort()
    const w1 = await createWork(t.db, workInput({ title: 'D', series: [], editions: [1, 2].map((volume) => ({ format: 'physical' as const, language: 'he', volume, volumeCount: 2 })) }))
    await upsertWish(t.db, scope, w1, fields({ language: 'he' }))
    await boughtWish(t.db, scope, w1, 'physical', on, 3)
    expect(await counts(w1)).toEqual([[1, null], [2, null], [3, null]])
    const w2 = await createWork(t.db, workInput({ title: 'E', series: [], editions: [{ format: 'physical', language: 'he', volume: 1, volumeCount: 3 }] }))
    await upsertWish(t.db, scope, w2, fields({ language: 'he' }))
    await boughtWish(t.db, scope, w2, 'physical', on, 2)
    expect(await counts(w2)).toEqual([[1, 3], [2, 3]])
  })

  it('lists members with their wish counts, and anyone can read anyone’s list', async () => {
    const dana = await member('dana')
    const noa = await member('noa')
    await addWishFromPage(t.db, dana.scope, { page: page(), target: { action: 'create_work' }, fields: fields() })
    const members = await wishMembers(t.db, noa.scope)
    expect(members).toEqual(expect.arrayContaining([{ userId: dana.user.id, name: 'dana', count: 1 }, { userId: noa.user.id, name: 'noa', count: 0 }]))
    expect(members[0]?.userId).toBe(noa.user.id)
    expect(await listWishes(t.db, noa.scope, dana.user.id)).toHaveLength(1)
  })

  it('hides a wish on a book the viewer has hidden', async () => {
    const dana = await member('dana')
    const noa = await member('noa')
    const { workId } = await addWishFromPage(t.db, dana.scope, { page: page(), target: { action: 'create_work' }, fields: fields() })
    await t.db.insert(userHiddenWorks).values({ userId: noa.user.id, workId })
    const noaScope = await loadUserScope(t.db, noa.user)
    expect(await listWishes(t.db, noaScope, dana.user.id)).toEqual([])
    expect(await wishesForWork(t.db, dana.scope, workId)).toHaveLength(1)
  })

  it('a wish can only be added to a book I can see', async () => {
    const dana = await member('dana')
    const workId = await createWork(t.db, workInput({ title: 'A', series: [], editions: [{ format: 'ebook' }] }))
    await t.db.insert(userHiddenWorks).values({ userId: dana.user.id, workId })
    const scope = await loadUserScope(t.db, dana.user)
    await expect(upsertWish(t.db, scope, workId, fields())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('deleting a book deletes its wishes', async () => {
    const { scope } = await member()
    const workId = await createWork(t.db, workInput({ title: 'A', series: [], editions: [{ format: 'ebook' }] }))
    await upsertWish(t.db, scope, workId, fields())
    await t.db.delete(works).where(eq(works.id, workId))
    expect(await listWishes(t.db, scope, scope.userId)).toEqual([])
    expect(await t.db.select().from(wishes)).toEqual([])
  })
})
