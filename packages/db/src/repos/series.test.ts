import { describe, expect, it } from 'vitest'
import { count, eq } from 'drizzle-orm'
import { series, seriesNames, userHiddenWorks, workSeries } from '../schema'
import { seedCover, seedUser, seedWork, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail, replaceSeries } from './catalog'
import { getContinuationForWork, listContinuationsForUser, listHiddenContinuations, listSeriesEntries, setContinuationHidden } from './series'
import { loadUserScope } from './scope'
import { setStatus } from './tracking'

describe('series repository', () => {
  const t = useTestDb()

  it('upsertSeries resolves a series by any of its names', async () => {
    const a = await createWork(t.db, workInput({ title: 'A', series: [{ name: 'קצב המלחמה סדרה', position: 1 }] }))
    const [row] = await t.db.select({ id: series.id }).from(series)
    const seriesId = row?.id ?? ''
    await t.db.insert(seriesNames).values({ seriesId, name: 'Stormlight Archive', normalizedName: 'stormlight archive', language: 'en' })
    const b = await createWork(t.db, workInput({ title: 'B', series: [] }))
    await replaceSeries(t.db, b, [{ name: 'stormlight archive', position: 2, positionEnd: null }])
    expect((await t.db.select({ n: count() }).from(series))[0]?.n).toBe(1)
    expect((await t.db.select().from(workSeries).where(eq(workSeries.workId, b)))[0]?.seriesId).toBe(seriesId)
    expect(a).not.toBe(b)

    const c = await createWork(t.db, workInput({ title: 'C', series: [] }))
    await replaceSeries(t.db, c, [{ name: 'Mistborn', position: 1, positionEnd: null }])
    expect((await t.db.select({ n: count() }).from(series))[0]?.n).toBe(2)
    const names = await t.db.select().from(seriesNames)
    expect(names).toHaveLength(3)
    expect(names.find((n) => n.name === 'Mistborn')?.language).toBe('en')
  })

  it('lists entries in position order with each work\'s current status', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const a = await createWork(t.db, workInput({ title: 'A', series: [{ name: 'Mistborn', position: 1 }] }))
    await createWork(t.db, workInput({ title: 'B', series: [{ name: 'Mistborn', position: 2 }] }))
    await setStatus(t.db, scope, a, 'read')
    const seriesId = (await getWorkDetail(t.db, scope, a)).series[0]?.id ?? ''

    const entries = await listSeriesEntries(t.db, scope, seriesId)
    expect(entries.map((e) => e.title)).toEqual(['A', 'B'])
    expect(entries[0]?.status).toBe('read')
  })

  it('orders entries by position whatever order they were added in; unnumbered last, by title (#125)', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    for (const [title, position] of [['Zed', null], ['Three', 3], ['Alpha', null], ['One', 1], ['Novella', 1.5]] as const) {
      await createWork(t.db, workInput({ title, series: [{ name: 'Shuffled', position }] }))
    }
    const two = await createWork(t.db, workInput({ title: 'Two', series: [{ name: 'Shuffled', position: 2 }] }))
    const seriesId = (await getWorkDetail(t.db, scope, two)).series[0]?.id ?? ''
    expect((await listSeriesEntries(t.db, scope, seriesId)).map((e) => e.title)).toEqual(['One', 'Novella', 'Two', 'Three', 'Alpha', 'Zed'])
  })

  it('carries a range end on each entry (#122)', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const pack = await createWork(t.db, workInput({ title: 'Pack', series: [{ name: 'Mage Errant', position: 1, positionEnd: 2 }] }))
    await createWork(t.db, workInput({ title: 'Three', series: [{ name: 'Mage Errant', position: 3 }] }))
    const seriesId = (await getWorkDetail(t.db, scope, pack)).series[0]?.id ?? ''
    expect((await listSeriesEntries(t.db, scope, seriesId)).map((e) => [e.title, e.position, e.positionEnd])).toEqual([
      ['Pack', 1, 2],
      ['Three', 3, null],
    ])
  })

  it('suggests the next unread entry after a finished book, and nothing past the end', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const a = await createWork(t.db, workInput({ title: 'A', series: [{ name: 'Mistborn', position: 1 }] }))
    const b = await createWork(t.db, workInput({ title: 'B', series: [{ name: 'Mistborn', position: 2 }] }))
    await setStatus(t.db, scope, a, 'read')

    expect((await getContinuationForWork(t.db, scope, a)).map((c) => c.nextWorkId)).toEqual([b])
    await setStatus(t.db, scope, b, 'read')
    expect(await getContinuationForWork(t.db, scope, b)).toEqual([])
  })

  it('lists a household-wide continuation for every series the user has started', async () => {
    const user = await seedUser(t.db)
    const scope0 = await loadUserScope(t.db, user)
    const a = await createWork(t.db, workInput({ title: 'A', series: [{ name: 'Mistborn', position: 1 }] }))
    const b = await createWork(t.db, workInput({ title: 'B', series: [{ name: 'Mistborn', position: 2 }] }))
    await setStatus(t.db, scope0, a, 'reading')

    const scope = await loadUserScope(t.db, user)
    expect((await listContinuationsForUser(t.db, scope)).map((c) => c.nextWorkId)).toEqual([b])
  })

  it('carries the next book\'s authors and cover on both continuation queries', async () => {
    const user = await seedUser(t.db)
    const scope0 = await loadUserScope(t.db, user)
    const a = await seedWork(t.db, { title: 'A', series: { name: 'Mistborn', position: 1 } })
    const b = await seedWork(t.db, { title: 'B', authors: ['Brandon Sanderson', 'Isaac Stewart'], series: { name: 'Mistborn', position: 2 } })
    const cover = await seedCover(t.db, b.editionIds[0] ?? '', { path: 'covers/ab/b.png', sha256: 'b', mime: 'image/png' })
    await setStatus(t.db, scope0, a.workId, 'read')

    const scope = await loadUserScope(t.db, user)
    const expected = { nextWorkId: b.workId, nextAuthors: ['Brandon Sanderson', 'Isaac Stewart'], nextCoverAssetId: cover }
    expect(await listContinuationsForUser(t.db, scope)).toMatchObject([expected])
    expect(await getContinuationForWork(t.db, scope, a.workId)).toMatchObject([expected])
  })

  it('treats a hidden book as missing: no continuation from it, and it does not count as started', async () => {
    const user = await seedUser(t.db)
    const scope0 = await loadUserScope(t.db, user)
    const a = await createWork(t.db, workInput({ title: 'A', series: [{ name: 'Mistborn', position: 1 }] }))
    await createWork(t.db, workInput({ title: 'B', series: [{ name: 'Mistborn', position: 2 }] }))
    await setStatus(t.db, scope0, a, 'read')
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: a })

    const scope = await loadUserScope(t.db, user)
    await expect(getContinuationForWork(t.db, scope, a)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await listContinuationsForUser(t.db, scope)).toEqual([])
  })

  it('leaves a hidden series out of both continuation queries, for that user only, until it is shown again', async () => {
    const user = await seedUser(t.db)
    const other = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const otherScope = await loadUserScope(t.db, other)
    const a = await createWork(t.db, workInput({ title: 'A', series: [{ name: 'Mistborn', position: 1 }] }))
    const b = await createWork(t.db, workInput({ title: 'B', series: [{ name: 'Mistborn', position: 2 }] }))
    await setStatus(t.db, scope, a, 'read')
    await setStatus(t.db, otherScope, a, 'read')
    const seriesId = (await getWorkDetail(t.db, scope, a)).series[0]?.id ?? ''

    await setContinuationHidden(t.db, scope, seriesId, true)
    await setContinuationHidden(t.db, scope, seriesId, true) // idempotent
    expect(await listHiddenContinuations(t.db, scope)).toEqual([seriesId])
    expect(await listContinuationsForUser(t.db, scope)).toEqual([])
    expect(await getContinuationForWork(t.db, scope, a)).toEqual([])
    expect((await listContinuationsForUser(t.db, otherScope)).map((c) => c.nextWorkId)).toEqual([b])

    await setContinuationHidden(t.db, scope, seriesId, false)
    expect(await listHiddenContinuations(t.db, scope)).toEqual([])
    expect((await listContinuationsForUser(t.db, scope)).map((c) => c.nextWorkId)).toEqual([b])
  })

  it('will not hide a series the user cannot see a book of', async () => {
    const user = await seedUser(t.db)
    const a = await createWork(t.db, workInput({ title: 'A', series: [{ name: 'Mistborn', position: 1 }] }))
    const scope0 = await loadUserScope(t.db, user)
    const seriesId = (await getWorkDetail(t.db, scope0, a)).series[0]?.id ?? ''
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: a })

    const scope = await loadUserScope(t.db, user)
    await expect(setContinuationHidden(t.db, scope, seriesId, true)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
