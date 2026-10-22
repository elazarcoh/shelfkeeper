import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { ExternalItem, WishFields } from '@mylib/domain'
import { editions, proposals, queueEntries, readingSessions, setItems, sourceItems, sources, userHiddenWorks, userWorks, wishes, workSearch, workTitles, works } from '../schema'
import { seedSession, seedUser, seedWork, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail, mergeWorks } from './catalog'
import { listWishes, upsertWish } from './wishlist'
import { loadUserScope } from './scope'
import { addWorkToSet, getDefaultPersonalSetId } from './sets'
import { addToQueue, setRating, setReview, setStatus } from './tracking'

const UNKNOWN_ID = '0f8fad5b-d9cb-4111-8111-70867728950e'

describe('mergeWorks', () => {
  const t = useTestDb()
  const adminUser = async () => seedUser(t.db, { role: 'admin' })
  const scopeOf = async (user: { id: string; role: 'admin' | 'member' }) => loadUserScope(t.db, user)
  const book = (title: string, over: Parameters<typeof workInput>[0] = {}) => createWork(t.db, workInput({ title, ...over }))

  it('moves editions and sessions to the target and deletes the source', async () => {
    const admin = await adminUser()
    const scope = await scopeOf(admin)
    const target = await book('Mistborn', { editions: [{ format: 'physical' }] })
    const source = await book('Mistborn', { editions: [{ format: 'ebook' }] })
    const sourceEdition = (await getWorkDetail(t.db, scope, source)).editions[0]?.id ?? ''
    await seedSession(t.db, { userId: admin.id, workId: source, editionId: sourceEdition, startedOn: '2026-01-01' })
    await seedSession(t.db, { userId: admin.id, workId: target, startedOn: '2026-02-01', outcome: 'finished', finishedOn: '2026-02-10' })

    const result = await mergeWorks(t.db, scope, target, [source])

    expect(result.workId).toBe(target)
    const merged = await getWorkDetail(t.db, scope, target)
    expect(merged.editions.map((e) => e.format).sort()).toEqual(['ebook', 'physical'])
    const sessions = await t.db.select().from(readingSessions).where(eq(readingSessions.workId, target))
    expect(sessions).toHaveLength(2)
    expect(await t.db.select().from(works).where(eq(works.id, source))).toEqual([])
    expect(await t.db.select().from(workSearch).where(eq(workSearch.workId, source))).toEqual([])
    expect(await t.db.select().from(editions).where(eq(editions.workId, target))).toHaveLength(2)
  })

  it('merge carries the source’s titles in languages the target lacks', async () => {
    const scope = await scopeOf(await adminUser())
    const target = await book('קצב המלחמה', { editions: [{ format: 'physical', language: 'he' }] })
    const source = await book('Rhythm of War (Audio)', { editions: [{ format: 'audiobook', language: 'en' }] })
    await t.db.insert(workTitles).values([
      { workId: target, language: 'en', title: 'Rhythm of War', subtitle: null, sortTitle: 'rhythm of war', primary: false },
      { workId: source, language: null, title: 'RoW', subtitle: null, sortTitle: 'row', primary: false },
    ])

    const result = await mergeWorks(t.db, scope, target, [source])

    const rows = await t.db.select().from(workTitles).where(eq(workTitles.workId, target))
    expect(rows.map((r) => [r.language, r.title, r.primary]).sort()).toEqual([
      ['en', 'Rhythm of War', false],
      ['he', 'קצב המלחמה', true],
      [null, 'RoW', false],
    ].sort())
    expect(result.dropped).toContain('Title “Rhythm of War (Audio)”')
    expect(result.dropped.filter((d) => d.startsWith('Title “'))).toHaveLength(1)
  })

  it('moves wishes to the target and combines one person’s two wishes', async () => {
    const scope = await scopeOf(await adminUser())
    const dana = await scopeOf(await seedUser(t.db, { username: 'dana' }))
    const noa = await scopeOf(await seedUser(t.db, { username: 'noa' }))
    const target = (await seedWork(t.db, { title: 'Wished', noEditions: true })).workId
    const source = (await seedWork(t.db, { title: 'Wished', noEditions: true })).workId
    await upsertWish(t.db, dana, source, WishFields.parse({ formats: ['audiobook'], language: null, note: 'audio' }))
    await upsertWish(t.db, dana, target, WishFields.parse({ formats: ['physical'], language: null, note: 'print' }))
    await upsertWish(t.db, noa, source, WishFields.parse({ formats: [], language: null, note: null }))

    await mergeWorks(t.db, scope, target, [source])

    const danas = await listWishes(t.db, dana, dana.userId)
    expect(danas).toHaveLength(1)
    expect(danas[0]).toMatchObject({ workId: target, formats: ['physical', 'audiobook'], note: 'print · audio' })
    const noas = await listWishes(t.db, noa, noa.userId)
    expect(noas).toHaveLength(1)
    expect(noas[0]?.workId).toBe(target)
    expect(await t.db.select().from(wishes)).toHaveLength(2)
  })

  it('compares series ranges: a lost range is reported, a single position the range holds is not (#122)', async () => {
    const scope = await scopeOf(await adminUser())
    const single = await book('Pack', { series: [{ name: 'S', position: 1 }] })
    const pack = await book('Pack', { series: [{ name: 'S', position: 1, positionEnd: 2 }] })
    expect((await mergeWorks(t.db, scope, single, [pack])).dropped).toEqual(['S #1–2 (kept #1)'])
    expect((await getWorkDetail(t.db, scope, single)).series).toMatchObject([{ name: 'S', position: 1, positionEnd: null }])

    const wide = await book('Pack', { series: [{ name: 'S', position: 1, positionEnd: 2 }] })
    const one = await book('Pack', { series: [{ name: 'S', position: 1 }] })
    expect((await mergeWorks(t.db, scope, wide, [one])).dropped).toEqual([])
    expect((await getWorkDetail(t.db, scope, wide)).series).toMatchObject([{ name: 'S', position: 1, positionEnd: 2 }])
  })

  it('reports nothing dropped for an exact copy, and what lost otherwise', async () => {
    const scope = await scopeOf(await adminUser())
    const target = await book('Mistborn')
    const copy = await book('Mistborn')
    expect((await mergeWorks(t.db, scope, target, [copy])).dropped).toEqual([])

    const other = await book('המנוע', { authors: ['Brandon Sanderson', 'Someone Else'], series: [{ name: 'Mistborn', position: 2 }, { name: 'Cosmere', position: 3 }] })
    const { dropped } = await mergeWorks(t.db, scope, target, [other])
    // the Hebrew title is carried (the target has none in Hebrew), so it is no loss
    expect(dropped).toEqual(['Author Someone Else', 'Mistborn #2 (kept #1)'])
    expect((await t.db.select().from(workTitles).where(eq(workTitles.workId, target))).map((r) => r.title).sort()).toEqual(['Mistborn', 'המנוע'])
    const merged = await getWorkDetail(t.db, scope, target)
    expect(merged.title).toBe('Mistborn')
    expect(merged.series.map((s) => [s.name, s.position])).toEqual([['Mistborn', 1], ['Cosmere', 3]])
    expect(merged.authors.map((a) => a.name)).toEqual(['Brandon Sanderson'])
  })

  it('unions tags, set membership and source links', async () => {
    const admin = await adminUser()
    const scope = await scopeOf(admin)
    const target = await book('A', { tags: ['Fantasy'] })
    const source = await book('B', { tags: ['Epic', 'Fantasy'] })
    const mySet = await getDefaultPersonalSetId(t.db, admin.id)
    await addWorkToSet(t.db, scope, mySet, source)
    const [src] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'Home ABS', config: { kind: 'audiobookshelf' } }).returning()
    const normalized = ExternalItem.parse({ externalId: 'li_1', format: 'audiobook', title: 'B' })
    await t.db.insert(sourceItems).values({ sourceId: src?.id ?? '', externalId: 'li_1', normalized, contentHash: 'h', workId: source, state: 'linked' })

    await mergeWorks(t.db, scope, target, [source])

    const merged = await getWorkDetail(t.db, scope, target)
    expect(merged.tags.map((x) => x.name).sort()).toEqual(['Epic', 'Fantasy'])
    expect((await t.db.select().from(setItems).where(eq(setItems.workId, target))).map((i) => i.setId)).toEqual([mySet])
    const items = await t.db.select().from(sourceItems)
    expect(items.map((i) => i.workId)).toEqual([target])
  })

  it("merges each person's rating and review, target winning, and reports the differences", async () => {
    const admin = await adminUser()
    const scope = await scopeOf(admin)
    const kid = await seedUser(t.db, { username: 'Kid' })
    const kidScope = await scopeOf(kid)
    const solo = await seedUser(t.db, { username: 'solo' })
    const soloScope = await scopeOf(solo)
    const target = await book('A')
    const source = await book('A')
    await setRating(t.db, kidScope, target, 5)
    await setRating(t.db, kidScope, source, 4)
    await setReview(t.db, kidScope, source, 'Loved it')
    // only the source has a row for this person: it moves over
    await setStatus(t.db, soloScope, source, 'read')
    await setRating(t.db, soloScope, source, 3.5)

    const { dropped } = await mergeWorks(t.db, scope, target, [source])

    const [kidRow] = await t.db.select().from(userWorks).where(and(eq(userWorks.userId, kid.id), eq(userWorks.workId, target)))
    expect(kidRow).toMatchObject({ rating: 5, review: 'Loved it', status: 'none' })
    const [soloRow] = await t.db.select().from(userWorks).where(and(eq(userWorks.userId, solo.id), eq(userWorks.workId, target)))
    expect(soloRow).toMatchObject({ rating: 3.5, status: 'read' })
    expect(dropped).toEqual(['Kid’s rating 4 (kept 5)'])
  })

  it('recomputes status from the sessions on the target, so a session in progress on the source makes it reading', async () => {
    const admin = await adminUser()
    const scope = await scopeOf(admin)
    const target = await book('A')
    const source = await book('B')
    await setStatus(t.db, scope, target, 'read')
    await seedSession(t.db, { userId: admin.id, workId: target, startedOn: '2026-01-01', outcome: 'finished', finishedOn: '2026-01-09' })
    await seedSession(t.db, { userId: admin.id, workId: source, startedOn: '2026-03-01', isReread: true })

    await mergeWorks(t.db, scope, target, [source])

    expect((await getWorkDetail(t.db, scope, target)).me.status).toBe('reading')
  })

  it("keeps the target's status when nobody has sessions, or the source's when the target's is none", async () => {
    const admin = await adminUser()
    const scope = await scopeOf(admin)
    const target = await book('A')
    const source = await book('B')
    await setStatus(t.db, scope, source, 'abandoned')
    await mergeWorks(t.db, scope, target, [source])
    expect((await getWorkDetail(t.db, scope, target)).me.status).toBe('abandoned')

    const target2 = await book('C')
    const source2 = await book('D')
    await setStatus(t.db, scope, target2, 'read')
    await setStatus(t.db, scope, source2, 'abandoned')
    await mergeWorks(t.db, scope, target2, [source2])
    expect((await getWorkDetail(t.db, scope, target2)).me.status).toBe('read')
  })

  it("queues: the target's entry wins, otherwise the source's moves keeping its position", async () => {
    const admin = await adminUser()
    const scope = await scopeOf(admin)
    const both = await seedUser(t.db)
    const bothScope = await scopeOf(both)
    const target = await book('A')
    const source = await book('B')
    const filler = await book('F')
    await addToQueue(t.db, bothScope, target, 'bottom')
    await addToQueue(t.db, bothScope, source, 'bottom')
    await addToQueue(t.db, scope, filler, 'bottom')
    await addToQueue(t.db, scope, source, 'bottom')
    const [sourceEntry] = await t.db.select().from(queueEntries).where(and(eq(queueEntries.userId, admin.id), eq(queueEntries.workId, source)))
    expect(sourceEntry?.position).toBeGreaterThan(0)

    await mergeWorks(t.db, scope, target, [source])

    const mine = await t.db.select().from(queueEntries).where(eq(queueEntries.userId, admin.id))
    expect(mine).toHaveLength(2)
    expect(mine.find((q) => q.workId === target)?.position).toBe(sourceEntry?.position)
    const theirs = await t.db.select().from(queueEntries).where(eq(queueEntries.userId, both.id))
    expect(theirs.map((q) => q.workId)).toEqual([target])
  })

  it('keeps a book hidden from the people it was hidden from, and says so when that newly hides the target', async () => {
    const admin = await adminUser()
    const scope = await scopeOf(admin)
    const kid = await seedUser(t.db, { username: 'Kid' })
    const target = await book('A')
    const source = await book('A')
    await t.db.insert(userHiddenWorks).values({ userId: kid.id, workId: source, hiddenBy: admin.id })

    const { dropped } = await mergeWorks(t.db, scope, target, [source])

    expect(dropped).toEqual(['Now hidden from Kid'])
    await expect(getWorkDetail(t.db, await scopeOf(kid), target)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("rewrites pending proposals' candidates, collapsing duplicates to the best score", async () => {
    const scope = await scopeOf(await adminUser())
    const target = await book('A')
    const source = await book('B')
    const other = await book('Z')
    const candidate = (workId: string, score: number) => ({ workId, editionId: null, score, basis: 'title_author' as const, reasons: [], volume: null })
    const [row] = await t.db
      .insert(proposals)
      .values({
        kind: 'source_match',
        payload: {},
        candidates: [candidate(source, 0.9), candidate(other, 0.8), candidate(target, 0.6)],
        scope: 'catalog',
        createdBy: 'sync',
      })
      .returning({ id: proposals.id })

    await mergeWorks(t.db, scope, target, [source])

    const [after] = await t.db.select({ candidates: proposals.candidates }).from(proposals).where(eq(proposals.id, row?.id ?? ''))
    expect(after?.candidates.map((c) => [c.workId, c.score])).toEqual([[target, 0.9], [other, 0.8]])
  })

  it("carries a pending shelf proposal's chosen book to the target; others are left alone", async () => {
    const scope = await scopeOf(await adminUser())
    const target = await book('A')
    const source = await book('B')
    const other = await book('Z')
    const shelf = (workId: string, status: 'pending' | 'rejected') => ({
      kind: 'source_match' as const,
      payload: { photo: { preset: { workId }, link: null } },
      candidates: [],
      scope: 'catalog' as const,
      createdBy: 'sync' as const,
      status,
    })
    const rows = await t.db
      .insert(proposals)
      .values([shelf(source, 'pending'), shelf(other, 'pending'), shelf(source, 'rejected')])
      .returning({ id: proposals.id })

    await mergeWorks(t.db, scope, target, [source])

    const after = await t.db.select({ id: proposals.id, payload: proposals.payload }).from(proposals).where(inArray(proposals.id, rows.map((r) => r.id)))
    const presetOf = (id: string | undefined) => (after.find((a) => a.id === id)?.payload as { photo: { preset: { workId: string }; link: null } }).photo
    expect(presetOf(rows[0]?.id)).toEqual({ preset: { workId: target }, link: null })
    expect(presetOf(rows[1]?.id).preset.workId).toBe(other)
    expect(presetOf(rows[2]?.id).preset.workId).toBe(source)
  })

  it('merges several sources at once', async () => {
    const scope = await scopeOf(await adminUser())
    const target = await book('A')
    const one = await book('B')
    const two = await book('C', { editions: [{ format: 'audiobook' }] })
    await mergeWorks(t.db, scope, target, [one, two])
    expect((await getWorkDetail(t.db, scope, target)).editions).toHaveLength(3)
  })

  it('refuses members, and bad, unknown or hidden sources', async () => {
    const admin = await adminUser()
    const scope = await scopeOf(admin)
    const target = await book('A')
    const source = await book('B')
    await expect(mergeWorks(t.db, await scopeOf(await seedUser(t.db)), target, [source])).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(mergeWorks(t.db, scope, target, [target])).rejects.toMatchObject({ code: 'INVALID' })
    await expect(mergeWorks(t.db, scope, target, [])).rejects.toMatchObject({ code: 'INVALID' })
    await expect(mergeWorks(t.db, scope, target, [source, source])).rejects.toMatchObject({ code: 'INVALID' })
    const many = Array.from({ length: 21 }, (_, i) => `0f8fad5b-d9cb-4111-8111-${String(i).padStart(12, '0')}`)
    await expect(mergeWorks(t.db, scope, target, many)).rejects.toMatchObject({ code: 'INVALID' })
    await expect(mergeWorks(t.db, scope, target, [UNKNOWN_ID])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(mergeWorks(t.db, scope, UNKNOWN_ID, [source])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await t.db.insert(userHiddenWorks).values({ userId: admin.id, workId: source })
    await expect(mergeWorks(t.db, scope, target, [source])).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // a refused merge changes nothing
    expect(await t.db.select().from(works).where(eq(works.id, source))).toHaveLength(1)
  })
})
