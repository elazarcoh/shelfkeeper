import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { series, seriesNames, sets, userHiddenContinuations, workSearch, workSeries } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork } from './catalog'
import { loadUserScope } from './scope'
import { addSeriesName, getSeriesAdmin, listSeriesAdmin, makeSeriesNamePrimary, mergeSeries, removeSeriesName, renameSeriesName, setSeriesNameLanguage, splitSeriesName } from './series-admin'
import { createSet } from './sets'

describe('Admin → Series', () => {
  const t = useTestDb()
  const admin = async () => loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
  const idOf = async (name: string) => (await t.db.select({ id: series.id }).from(series).where(eq(series.name, name)))[0]?.id ?? ''
  const nameIdOf = async (name: string) => (await t.db.select({ id: seriesNames.id }).from(seriesNames).where(eq(seriesNames.name, name)))[0]?.id ?? ''

  /** "Stormlight Archive" (en) and "גנזך אורות הסער" (he); one work is in both (position 4 / none, sort_index 0 / 1) */
  async function stormlight() {
    const both = await createWork(t.db, workInput({ title: 'The Way of Kings', series: [{ name: 'Stormlight Archive', position: 4 }] }))
    const heOnly = await createWork(t.db, workInput({ title: 'דרך המלכים', series: [{ name: 'גנזך אורות הסער', position: 1 }] }))
    const en = await idOf('Stormlight Archive')
    const he = await idOf('גנזך אורות הסער')
    await t.db.insert(workSeries).values({ workId: both, seriesId: he, position: null, positionEnd: null, sortIndex: 1 })
    return { both, heOnly, en, he }
  }

  it('lists series with names (primary first), book counts, searchable by any name', async () => {
    const scope = await admin()
    const s = await stormlight()
    await addSeriesName(t.db, scope, { seriesId: s.en, name: 'Archive of Light', language: 'en' })
    const { series: rows, more } = await listSeriesAdmin(t.db, scope, { q: '', limit: 100 })
    expect(more).toBe(false)
    expect(rows.map((r) => [r.name, r.bookCount])).toEqual([['Stormlight Archive', 1], ['גנזך אורות הסער', 2]])
    expect(rows[0]?.names.map((n) => [n.name, n.primary])).toEqual([['Stormlight Archive', true], ['Archive of Light', false]])
    expect((await listSeriesAdmin(t.db, scope, { q: 'archive of', limit: 100 })).series.map((r) => r.name)).toEqual(['Stormlight Archive'])
    expect(await listSeriesAdmin(t.db, scope, { q: '', limit: 1 })).toMatchObject({ more: true })
  })

  it('shows a series’ books in series order', async () => {
    const scope = await admin()
    const s = await stormlight()
    const detail = await getSeriesAdmin(t.db, scope, s.he)
    expect(detail.books.map((b) => [b.title, b.position, b.positionEnd])).toEqual([['דרך המלכים', 1, null], ['The Way of Kings', null, null]])
  })

  it('refuses non-admins', async () => {
    const member = await loadUserScope(t.db, await seedUser(t.db))
    await expect(listSeriesAdmin(t.db, member, { q: '', limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  describe('merge', () => {
    it('keeps one link for a work in both, repoints names, hidden continuations and smart sets, and deletes the gone series', async () => {
      const scope = await admin()
      const s = await stormlight()
      const other = await seedUser(t.db)
      await t.db.insert(userHiddenContinuations).values({ userId: other.id, seriesId: s.he })
      const set = await createSet(t.db, scope, { kind: 'smart', scope: 'global', name: 'Stormlight', filter: { op: 'series', seriesIds: [s.he] } })

      const result = await mergeSeries(t.db, scope, { seriesId: s.he, otherId: s.en, primaryNameId: await nameIdOf('Stormlight Archive') })
      expect(result.seriesId).toBe(s.en)

      const links = await t.db.select().from(workSeries)
      expect(links).toHaveLength(2)
      expect(links.find((l) => l.workId === s.both)).toMatchObject({ seriesId: s.en, position: 4, sortIndex: 0 })
      expect(links.find((l) => l.workId === s.heOnly)).toMatchObject({ seriesId: s.en, position: 1 })
      expect(await t.db.select({ id: series.id, name: series.name }).from(series)).toEqual([{ id: s.en, name: 'Stormlight Archive' }])
      expect((await t.db.select().from(seriesNames)).map((n) => n.seriesId)).toEqual([s.en, s.en])
      expect(await t.db.select().from(userHiddenContinuations).where(and(eq(userHiddenContinuations.userId, other.id), eq(userHiddenContinuations.seriesId, s.en)))).toHaveLength(1)
      expect((await t.db.select({ filter: sets.filter }).from(sets).where(eq(sets.id, set.id)))[0]?.filter).toEqual({ op: 'series', seriesIds: [s.en] })
      await expect(getSeriesAdmin(t.db, scope, s.he)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      for (const workId of [s.both, s.heOnly]) {
        const [row] = await t.db.select().from(workSearch).where(eq(workSearch.workId, workId))
        expect(JSON.stringify(row)).toContain('stormlight')
        expect(JSON.stringify(row)).toContain('גנזך')
      }
    })

    it('takes the other link’s position when the surviving one has none, and the lower sort_index', async () => {
      const scope = await admin()
      const s = await stormlight()
      // keep the Hebrew series: its link has no position and sort_index 1; the English link has 4 and 0
      const result = await mergeSeries(t.db, scope, { seriesId: s.en, otherId: s.he, primaryNameId: await nameIdOf('גנזך אורות הסער') })
      expect(result.seriesId).toBe(s.he)
      expect(await t.db.select().from(workSeries).where(eq(workSeries.workId, s.both))).toMatchObject([{ seriesId: s.he, position: 4, sortIndex: 0 }])
    })

    it('keeps a hide and sets the kept series’ primary to the chosen name', async () => {
      const scope = await admin()
      const s = await stormlight()
      const other = await seedUser(t.db)
      await t.db.insert(userHiddenContinuations).values([{ userId: other.id, seriesId: s.he }, { userId: other.id, seriesId: s.en }])
      await mergeSeries(t.db, scope, { seriesId: s.en, otherId: s.he, primaryNameId: await nameIdOf('גנזך אורות הסער') })
      expect(await t.db.select().from(userHiddenContinuations)).toHaveLength(1)
      expect((await t.db.select().from(series))[0]).toMatchObject({ id: s.he, name: 'גנזך אורות הסער', normalizedName: 'גנזך אורות הסער' })
    })

    it('refuses merging with itself or a missing series, and a primary name that is neither’s', async () => {
      const scope = await admin()
      const s = await stormlight()
      await expect(mergeSeries(t.db, scope, { seriesId: s.en, otherId: s.en, primaryNameId: await nameIdOf('Stormlight Archive') })).rejects.toMatchObject({ code: 'INVALID' })
      await expect(mergeSeries(t.db, scope, { seriesId: s.en, otherId: '00000000-0000-4000-8000-000000000001', primaryNameId: await nameIdOf('Stormlight Archive') })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await createWork(t.db, workInput({ title: 'Z', series: [{ name: 'Elsewhere', position: 1 }] }))
      await expect(mergeSeries(t.db, scope, { seriesId: s.en, otherId: s.he, primaryNameId: await nameIdOf('Elsewhere') })).rejects.toMatchObject({ code: 'INVALID' })
    })
  })

  describe('split', () => {
    async function three() {
      const works: string[] = []
      for (const [title, position] of [['One', 1], ['Two', 2], ['Three', 3]] as const) works.push(await createWork(t.db, workInput({ title, series: [{ name: 'Mistborn', position }] })))
      // the middle book is a range, with its own sort_index
      await t.db.update(workSeries).set({ position: 2, positionEnd: 2.5, sortIndex: 3 }).where(eq(workSeries.workId, works[1] ?? ''))
      const id = await idOf('Mistborn')
      await t.db.insert(seriesNames).values({ seriesId: id, name: 'מסטבורן', normalizedName: 'מסטבורן', language: 'he' })
      return { works, id }
    }

    it('moves the name and the ticked books (position kept) to a new series', async () => {
      const scope = await admin()
      const s = await three()
      const result = await splitSeriesName(t.db, scope, { nameId: await nameIdOf('מסטבורן'), workIds: [s.works[1] ?? ''], primaryNameId: null })
      expect(result.seriesId).not.toBe(s.id)
      const created = await t.db.select().from(series).where(eq(series.id, result.seriesId))
      expect(created[0]).toMatchObject({ name: 'מסטבורן', normalizedName: 'מסטבורן' })
      expect((await t.db.select().from(seriesNames).where(eq(seriesNames.seriesId, result.seriesId))).map((n) => n.name)).toEqual(['מסטבורן'])
      expect(await t.db.select().from(workSeries).where(eq(workSeries.seriesId, result.seriesId))).toMatchObject([{ workId: s.works[1], position: 2, positionEnd: 2.5, sortIndex: 3 }])
      expect(await t.db.select().from(workSeries).where(eq(workSeries.seriesId, s.id))).toHaveLength(2)
    })

    it('splitting the primary makes another name the old series’ primary', async () => {
      const scope = await admin()
      const s = await three()
      await splitSeriesName(t.db, scope, { nameId: await nameIdOf('Mistborn'), workIds: [s.works[0] ?? ''], primaryNameId: null })
      expect((await t.db.select().from(series).where(eq(series.id, s.id)))[0]).toMatchObject({ name: 'מסטבורן', normalizedName: 'מסטבורן' })
    })

    it('splitting the primary with an explicit new primary for the old series', async () => {
      const scope = await admin()
      const s = await three()
      await t.db.insert(seriesNames).values({ seriesId: s.id, name: 'Mistborn (US)', normalizedName: 'mistborn (us)', language: 'en' })
      const result = await splitSeriesName(t.db, scope, { nameId: await nameIdOf('Mistborn'), workIds: [s.works[0] ?? ''], primaryNameId: await nameIdOf('Mistborn (US)') })
      expect((await t.db.select().from(series).where(eq(series.id, s.id)))[0]).toMatchObject({ name: 'Mistborn (US)', normalizedName: 'mistborn (us)' })
      expect((await t.db.select().from(series).where(eq(series.id, result.seriesId)))[0]).toMatchObject({ name: 'Mistborn', normalizedName: 'mistborn' })
      // a primary that is not one of the old series' other names is refused
      await expect(splitSeriesName(t.db, scope, { nameId: await nameIdOf('Mistborn (US)'), workIds: [s.works[1] ?? ''], primaryNameId: await nameIdOf('Mistborn') })).rejects.toMatchObject({ code: 'INVALID' })
    })

    it('refuses with no books ticked or all of them ticked, and a name that is a series’ only one', async () => {
      const scope = await admin()
      const s = await three()
      await expect(splitSeriesName(t.db, scope, { nameId: await nameIdOf('מסטבורן'), workIds: ['00000000-0000-4000-8000-000000000001'], primaryNameId: null })).rejects.toMatchObject({ code: 'INVALID' })
      await expect(splitSeriesName(t.db, scope, { nameId: await nameIdOf('מסטבורן'), workIds: s.works, primaryNameId: null })).rejects.toMatchObject({ code: 'INVALID' })
      await createWork(t.db, workInput({ title: 'Solo', series: [{ name: 'Lonely', position: 1 }] }))
      await expect(splitSeriesName(t.db, scope, { nameId: await nameIdOf('Lonely'), workIds: s.works, primaryNameId: null })).rejects.toMatchObject({ code: 'INVALID' })
      expect(await t.db.select().from(series)).toHaveLength(2)
    })
  })

  describe('names', () => {
    it('adds, renames, sets the language of, makes primary and removes names', async () => {
      const scope = await admin()
      const s = await stormlight()
      const { nameId } = await addSeriesName(t.db, scope, { seriesId: s.en, name: 'ארכיון', language: 'he' })
      expect((await t.db.select().from(seriesNames).where(eq(seriesNames.id, nameId)))[0]).toMatchObject({ normalizedName: 'ארכיון', language: 'he' })
      await renameSeriesName(t.db, scope, { nameId, name: 'ארכיון אורות' })
      await setSeriesNameLanguage(t.db, scope, { nameId, language: null })
      expect((await t.db.select().from(seriesNames).where(eq(seriesNames.id, nameId)))[0]).toMatchObject({ name: 'ארכיון אורות', normalizedName: 'ארכיון אורות', language: null })
      await makeSeriesNamePrimary(t.db, scope, nameId)
      expect((await t.db.select().from(series).where(eq(series.id, s.en)))[0]).toMatchObject({ name: 'ארכיון אורות', normalizedName: 'ארכיון אורות' })
      await expect(removeSeriesName(t.db, scope, nameId)).rejects.toMatchObject({ code: 'INVALID' })
      await removeSeriesName(t.db, scope, await nameIdOf('Stormlight Archive'))
      expect((await t.db.select().from(seriesNames).where(eq(seriesNames.seriesId, s.en))).map((n) => n.name)).toEqual(['ארכיון אורות'])
    })

    it('renaming the primary keeps the series’ name in step, and search sees it', async () => {
      const scope = await admin()
      const s = await stormlight()
      await renameSeriesName(t.db, scope, { nameId: await nameIdOf('Stormlight Archive'), name: 'The Stormlight Archive' })
      expect((await t.db.select().from(series).where(eq(series.id, s.en)))[0]).toMatchObject({ name: 'The Stormlight Archive', normalizedName: 'the stormlight archive' })
      const [row] = await t.db.select().from(workSearch).where(eq(workSearch.workId, s.both))
      expect(JSON.stringify(row)).toContain('the stormlight archive')
    })

    it('refuses a spelling another series owns, and changes nothing (add and rename)', async () => {
      const scope = await admin()
      const s = await stormlight()
      await expect(addSeriesName(t.db, scope, { seriesId: s.en, name: 'גנזך  אורות הסער', language: 'he' })).rejects.toMatchObject({ code: 'CONFLICT', message: 'That name is גנזך אורות הסער’s — use Same series as… instead' })
      const { nameId } = await addSeriesName(t.db, scope, { seriesId: s.en, name: 'Archive', language: 'en' })
      const before = await t.db.select().from(seriesNames)
      await expect(renameSeriesName(t.db, scope, { nameId, name: 'גנזך אורות הסער' })).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(renameSeriesName(t.db, scope, { nameId: await nameIdOf('Stormlight Archive'), name: 'גנזך אורות הסער' })).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(await t.db.select().from(seriesNames)).toEqual(before)
      expect((await t.db.select().from(series).where(eq(series.id, s.en)))[0]?.name).toBe('Stormlight Archive')
    })

    it('refuses adding a name the series already has', async () => {
      const scope = await admin()
      const s = await stormlight()
      await expect(addSeriesName(t.db, scope, { seriesId: s.en, name: 'stormlight archive', language: null })).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('renaming only the case of a name is allowed', async () => {
      const scope = await admin()
      await stormlight()
      await renameSeriesName(t.db, scope, { nameId: await nameIdOf('Stormlight Archive'), name: 'STORMLIGHT archive' })
      expect((await t.db.select().from(seriesNames).where(eq(seriesNames.normalizedName, 'stormlight archive')))[0]?.name).toBe('STORMLIGHT archive')
    })
  })
})
