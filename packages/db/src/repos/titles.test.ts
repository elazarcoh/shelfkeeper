import { and, eq, inArray, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { ExternalItem } from '@mylib/domain'
import { contributors, editions, series, seriesNames, sources, users, workContributors, workTitles, works } from '../schema'
import { seedName, seedUser, seedWork, useTestDb, workInput } from '../testing'
import { createWork, splitEdition, updateWork } from './catalog'
import { shownWorkName } from './person-names'
import { loadUserScope } from './scope'
import { shownSeriesName } from './series-names'
import { addWorkTitle, makeTitlePrimary, removeWorkTitle, shownEditionSubtitle, shownEditionTitle, shownTitleField, updateWorkTitle } from './titles'
import { applyItemToEdition, createWorkFromItem } from './source-catalog'
import { createWishWork } from './wishlist'

describe('work_title primary row', () => {
  const t = useTestDb()

  async function expectInStep(workId: string, language?: string | null) {
    const rows = await t.db.select().from(workTitles).where(and(eq(workTitles.workId, workId), eq(workTitles.primary, true)))
    expect(rows).toHaveLength(1)
    const [work] = await t.db.select().from(works).where(eq(works.id, workId))
    expect(rows[0]).toMatchObject({ title: work?.title, subtitle: work?.subtitle, sortTitle: work?.sortTitle })
    if (language !== undefined) expect(rows[0]?.language).toBe(language)
  }

  it('every writer leaves exactly one primary row equal to work.*', async () => {
    const user = await seedUser(t.db, { role: 'admin' })
    const scope = await loadUserScope(t.db, user)
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!source) throw new Error('no source')

    const created = await createWork(t.db, workInput({ title: 'קצב המלחמה', editions: [{ format: 'physical', language: 'he' }, { format: 'ebook', language: 'en' }] }))
    await expectInStep(created, 'he')

    await updateWork(t.db, scope, created, { title: 'Rhythm of War', subtitle: 'Book Four' })
    await expectInStep(created, 'he')

    const item = ExternalItem.parse({ externalId: 'li_1', format: 'audiobook', title: 'Oathbringer', subtitle: 'Part one', authors: ['Brandon Sanderson'], language: 'English' })
    const synced = await t.db.transaction((tx) => createWorkFromItem(tx, source.id, item, user.id))
    await expectInStep(synced.workId, 'en')
    await t.db.transaction((tx) => applyItemToEdition(tx, source.id, synced.editionId, { ...item, subtitle: 'Part two' }))
    await expectInStep(synced.workId, 'en')
    expect((await t.db.select().from(works).where(eq(works.id, synced.workId)))[0]?.subtitle).toBe('Part two')

    const [ebook] = await t.db.select({ id: editions.id }).from(editions).where(and(eq(editions.workId, created), eq(editions.format, 'ebook')))
    const split = await splitEdition(t.db, scope, ebook?.id ?? '')
    await expectInStep(split)

    const wish = await t.db.transaction((tx) => createWishWork(tx, { title: 'Words of Radiance', authors: ['Brandon Sanderson'], series: null, language: 'en', description: null }))
    await expectInStep(wish, 'en')

    const seeded = await seedWork(t.db, { title: 'Elantris' })
    await expectInStep(seeded.workId)
    const [count] = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from work_title where work_id = ${seeded.workId} and "primary"`)
    expect(count?.n).toBe(1)
  })
})

describe('pick rules', () => {
  const t = useTestDb()

  async function shown(workId: string, languages: string[]) {
    const [row] = await t.db
      .select({
        title: shownTitleField(works.id, languages, 'title'),
        subtitle: shownTitleField(works.id, languages, 'subtitle'),
        sort: shownTitleField(works.id, languages, 'sort_title'),
      })
      .from(works)
      .where(eq(works.id, workId))
    return row
  }

  async function rhythm() {
    const { workId } = await seedWork(t.db, { title: 'קצב המלחמה', language: 'he' })
    await t.db.update(works).set({ subtitle: 'ספר 4' }).where(eq(works.id, workId))
    await t.db.update(workTitles).set({ subtitle: 'ספר 4' }).where(and(eq(workTitles.workId, workId), eq(workTitles.primary, true)))
    await t.db.insert(workTitles).values({ workId, language: 'en', title: 'Rhythm of War', subtitle: null, sortTitle: 'rhythm of war', primary: false })
    return workId
  }

  it('picks one whole row: an English title without a subtitle shows none', async () => {
    const workId = await rhythm()
    expect(await shown(workId, ['en', 'he'])).toEqual({ title: 'Rhythm of War', subtitle: null, sort: 'rhythm of war' })
    expect(await shown(workId, ['he', 'en'])).toMatchObject({ title: 'קצב המלחמה', subtitle: 'ספר 4' })
  })

  it('a language the book lacks falls back to the primary', async () => {
    const { workId } = await seedWork(t.db, { title: 'Dune', language: 'en' })
    expect(await shown(workId, ['he'])).toMatchObject({ title: 'Dune' })
    expect(await shown(workId, [])).toMatchObject({ title: 'Dune' })
  })

  it('series: the name in the first language, else the primary', async () => {
    const [s] = await t.db.insert(series).values({ name: 'גנזך אורות הסער', normalizedName: 'גנזך אורות הסער' }).returning()
    if (!s) throw new Error('no series')
    await t.db.insert(seriesNames).values([
      { seriesId: s.id, name: 'גנזך אורות הסער', normalizedName: 'גנזך אורות הסער', language: 'he' },
      { seriesId: s.id, name: 'Stormlight Archive', normalizedName: 'stormlight archive', language: 'en' },
    ])
    const pick = async (languages: string[]) => {
      const [r] = await t.db.select({ name: shownSeriesName(series.id, languages), norm: shownSeriesName(series.id, languages, 'normalized_name') }).from(series).where(eq(series.id, s.id))
      return r
    }
    expect(await pick(['en'])).toEqual({ name: 'Stormlight Archive', norm: 'stormlight archive' })
    expect(await pick(['fr'])).toEqual({ name: 'גנזך אורות הסער', norm: 'גנזך אורות הסער' })
  })

  it('person: a name in the languages, else the credited name', async () => {
    const { workId } = await seedWork(t.db, { title: 'Elantris', authors: ['ברנדון סנדרסון'], language: 'he' })
    const [person] = await t.db.select({ id: contributors.id }).from(contributors)
    await seedName(t.db, person?.id ?? '', 'Brandon Sanderson', 'en')
    const pick = async (languages: string[]) => {
      const [r] = await t.db.select({ name: shownWorkName(workContributors.nameId, workContributors.contributorId, languages) }).from(workContributors).where(eq(workContributors.workId, workId))
      return r?.name
    }
    expect(await pick(['en'])).toBe('Brandon Sanderson')
    expect(await pick(['fr'])).toBe('ברנדון סנדרסון')
  })

  it('person: several names in one language prefer the credited name, then the primary', async () => {
    const { workId } = await seedWork(t.db, { title: 'Elantris', authors: ['Brandon Sanderson'], language: 'en' })
    const [person] = await t.db.select({ id: contributors.id }).from(contributors)
    const pid = person?.id ?? ''
    const alt = await seedName(t.db, pid, 'B. Sanderson', 'en')
    const aaa = await seedName(t.db, pid, 'Aaron Sanderson', 'en')
    const he = await seedName(t.db, pid, 'ברנדון סנדרסון', 'he')
    const pick = async (nameId: string | null, languages: string[]) => {
      await t.db.update(workContributors).set({ nameId }).where(eq(workContributors.workId, workId))
      const [r] = await t.db.select({ name: shownWorkName(workContributors.nameId, workContributors.contributorId, languages) }).from(workContributors).where(eq(workContributors.workId, workId))
      return r?.name
    }
    expect(await pick(alt, ['en'])).toBe('B. Sanderson')
    expect(await pick(he, ['en'])).toBe('Brandon Sanderson')
    expect(await pick(null, ['en'])).toBe('Brandon Sanderson')
    expect(await pick(aaa, ['he', 'en'])).toBe('ברנדון סנדרסון')
  })

  it('person, several at once: contributors.id as the outer column picks per person', async () => {
    const w1 = await seedWork(t.db, { title: 'One', authors: ['Alice'], language: 'en' })
    const w2 = await seedWork(t.db, { title: 'Two', authors: ['Bob'], language: 'en' })
    const people = await t.db.select().from(contributors)
    const bob = people.find((p) => p.name === 'Bob')
    await seedName(t.db, bob?.id ?? '', 'Robert', 'fr')
    const rows = await t.db
      .select({ name: shownWorkName(workContributors.nameId, contributors.id, ['fr']) })
      .from(contributors)
      .innerJoin(workContributors, eq(workContributors.contributorId, contributors.id))
      .where(inArray(workContributors.workId, [w1.workId, w2.workId]))
    expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Robert'])
  })

  it('edition: its own title, else the work title in its language', async () => {
    const workId = await rhythm()
    const [own] = await t.db.insert(editions).values({ workId, format: 'audiobook', language: 'en', title: 'Rhythm of War (Graphic Audio)', subtitle: 'Dramatized' }).returning()
    const [plain] = await t.db.insert(editions).values({ workId, format: 'ebook', language: 'en' }).returning()
    const [other] = await t.db.insert(editions).values({ workId, format: 'physical', language: 'fr' }).returning()
    const pick = async (id: string) => {
      const [r] = await t.db.select({ title: shownEditionTitle(editions.id), subtitle: shownEditionSubtitle(editions.id) }).from(editions).where(eq(editions.id, id))
      return r
    }
    expect(await pick(own?.id ?? '')).toEqual({ title: 'Rhythm of War (Graphic Audio)', subtitle: 'Dramatized' })
    expect(await pick(plain?.id ?? '')).toEqual({ title: 'Rhythm of War', subtitle: null })
    expect(await pick(other?.id ?? '')).toEqual({ title: 'קצב המלחמה', subtitle: 'ספר 4' })
  })

  it('many rows at once: every row gets its own pick (no outer/inner shadowing)', async () => {
    const a = await rhythm()
    const { workId: b } = await seedWork(t.db, { title: 'Dune', language: 'en' })
    const rows = await t.db.select({ id: works.id, title: shownTitleField(works.id, ['en'], 'title') }).from(works)
    expect(new Map(rows.map((r) => [r.id, r.title]))).toEqual(new Map([[a, 'Rhythm of War'], [b, 'Dune']]))

    const [x] = await t.db.insert(series).values({ name: 'Alpha', normalizedName: 'alpha' }).returning()
    const [y] = await t.db.insert(series).values({ name: 'בטא', normalizedName: 'בטא' }).returning()
    await t.db.insert(seriesNames).values([
      { seriesId: x?.id ?? '', name: 'Alpha', normalizedName: 'alpha', language: 'en' },
      { seriesId: x?.id ?? '', name: 'אלפא', normalizedName: 'אלפא', language: 'he' },
      { seriesId: y?.id ?? '', name: 'בטא', normalizedName: 'בטא', language: 'he' },
      { seriesId: y?.id ?? '', name: 'Beta', normalizedName: 'beta', language: 'en' },
    ])
    const names = async (languages: string[]) =>
      new Map((await t.db.select({ id: series.id, name: shownSeriesName(series.id, languages) }).from(series)).map((r) => [r.id, r.name]))
    expect(await names(['he'])).toEqual(new Map([[x?.id, 'אלפא'], [y?.id, 'בטא']]))
    expect(await names(['en'])).toEqual(new Map([[x?.id, 'Alpha'], [y?.id, 'Beta']]))
    expect(await names(['fr'])).toEqual(new Map([[x?.id, 'Alpha'], [y?.id, 'בטא']])) // the primaries

    const [e1] = await t.db.insert(editions).values({ workId: a, format: 'ebook', language: 'en' }).returning()
    const [e2] = await t.db.insert(editions).values({ workId: b, format: 'ebook', language: 'en' }).returning()
    const eds = await t.db.select({ id: editions.id, title: shownEditionTitle(editions.id) }).from(editions).where(inArray(editions.id, [e1?.id ?? '', e2?.id ?? '']))
    expect(new Map(eds.map((r) => [r.id, r.title]))).toEqual(new Map([[e1?.id, 'Rhythm of War'], [e2?.id, 'Dune']]))
  })
})

describe('title editing', () => {
  const t = useTestDb()

  async function setup(titleLanguages = ['en', 'he']) {
    const user = await seedUser(t.db, { role: 'admin' })
    await t.db.update(users).set({ titleLanguages }).where(eq(users.id, user.id))
    const scope = await loadUserScope(t.db, user)
    const { workId } = await seedWork(t.db, { title: 'קצב המלחמה', language: 'he' })
    return { scope, workId }
  }
  const rows = (workId: string) => t.db.select().from(workTitles).where(eq(workTitles.workId, workId))
  const workRow = async (workId: string) => (await t.db.select().from(works).where(eq(works.id, workId)))[0]

  it('adds a title in a new language and refuses a second one in the same language', async () => {
    const { scope, workId } = await setup()
    const { titleId } = await addWorkTitle(t.db, scope, { workId, language: 'en', title: 'Rhythm of War', subtitle: null })
    expect((await rows(workId)).find((r) => r.id === titleId)).toMatchObject({ language: 'en', primary: false, sortTitle: 'rhythm of war' })
    await expect(addWorkTitle(t.db, scope, { workId, language: 'en', title: 'Other', subtitle: null })).rejects.toMatchObject({ code: 'CONFLICT', message: 'It already has a title in that language' })
    await expect(updateWorkTitle(t.db, scope, { titleId, title: 'x', subtitle: null, language: 'he' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await rows(workId)).toHaveLength(2)
  })

  it('makes a title primary: work.* follows, one primary row, title marked manual', async () => {
    const { scope, workId } = await setup()
    const { titleId } = await addWorkTitle(t.db, scope, { workId, language: 'en', title: 'Rhythm of War', subtitle: 'Book Four' })
    await makeTitlePrimary(t.db, scope, { titleId })
    const work = await workRow(workId)
    expect(work).toMatchObject({ title: 'Rhythm of War', subtitle: 'Book Four', sortTitle: 'rhythm of war' })
    expect(work?.provenance.title?.origin).toBe('manual')
    const all = await rows(workId)
    expect(all.filter((r) => r.primary).map((r) => r.id)).toEqual([titleId])
    expect(all).toHaveLength(2)
  })

  it("removes the primary: the remover's first language takes over", async () => {
    const { scope, workId } = await setup(['en', 'he'])
    await addWorkTitle(t.db, scope, { workId, language: 'en', title: 'Rhythm of War', subtitle: null })
    const primary = (await rows(workId)).find((r) => r.primary)
    await removeWorkTitle(t.db, scope, { titleId: primary?.id ?? '', newPrimaryId: null })
    const left = await rows(workId)
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ language: 'en', primary: true })
    expect(await workRow(workId)).toMatchObject({ title: 'Rhythm of War' })
  })

  it('removing the primary with newPrimaryId promotes that row', async () => {
    const { scope, workId } = await setup(['en', 'he'])
    await addWorkTitle(t.db, scope, { workId, language: 'en', title: 'Rhythm of War', subtitle: null })
    const { titleId } = await addWorkTitle(t.db, scope, { workId, language: 'fr', title: 'Le Rythme de la guerre', subtitle: null })
    const primary = (await rows(workId)).find((r) => r.primary)
    await removeWorkTitle(t.db, scope, { titleId: primary?.id ?? '', newPrimaryId: titleId })
    expect((await rows(workId)).filter((r) => r.primary).map((r) => r.id)).toEqual([titleId])
    expect(await workRow(workId)).toMatchObject({ title: 'Le Rythme de la guerre' })
  })

  it('refuses to remove the last title', async () => {
    const { scope, workId } = await setup()
    const [only] = await rows(workId)
    await expect(removeWorkTitle(t.db, scope, { titleId: only?.id ?? '', newPrimaryId: null })).rejects.toMatchObject({ code: 'INVALID', message: 'A book needs a title' })
  })

  it('removing a non-primary title leaves the primary alone', async () => {
    const { scope, workId } = await setup()
    const { titleId } = await addWorkTitle(t.db, scope, { workId, language: 'en', title: 'Rhythm of War', subtitle: null })
    await removeWorkTitle(t.db, scope, { titleId, newPrimaryId: null })
    expect(await rows(workId)).toHaveLength(1)
    expect(await workRow(workId)).toMatchObject({ title: 'קצב המלחמה' })
  })

  it('a source sync after a manual title edit leaves work.title unchanged', async () => {
    const { scope, workId } = await setup()
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!source) throw new Error('no source')
    const [edition] = await t.db.select({ id: editions.id }).from(editions).where(eq(editions.workId, workId))
    const { titleId } = await addWorkTitle(t.db, scope, { workId, language: 'en', title: 'Rhythm of War', subtitle: null })
    await makeTitlePrimary(t.db, scope, { titleId })
    const item = ExternalItem.parse({ externalId: 'li_9', format: 'physical', title: 'Something Else', authors: ['Brandon Sanderson'], language: 'English' })
    await t.db.transaction((tx) => applyItemToEdition(tx, source.id, edition?.id ?? '', item))
    expect(await workRow(workId)).toMatchObject({ title: 'Rhythm of War' })
  })

  it('a promoted subtitle survives a source sync with another subtitle', async () => {
    const { scope, workId } = await setup()
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!source) throw new Error('no source')
    const [edition] = await t.db.select({ id: editions.id }).from(editions).where(eq(editions.workId, workId))
    const { titleId } = await addWorkTitle(t.db, scope, { workId, language: 'en', title: 'Rhythm of War', subtitle: 'Book Four' })
    await makeTitlePrimary(t.db, scope, { titleId })
    const item = ExternalItem.parse({ externalId: 'li_8', format: 'physical', title: 'Rhythm of War', subtitle: 'Yet Another', authors: ['Brandon Sanderson'], language: 'English' })
    await t.db.transaction((tx) => applyItemToEdition(tx, source.id, edition?.id ?? '', item))
    expect(await workRow(workId)).toMatchObject({ subtitle: 'Book Four' })
  })

  it('updateWorkTitle on another row leaves work.*; on the primary it rewrites it', async () => {
    const { scope, workId } = await setup()
    const { titleId } = await addWorkTitle(t.db, scope, { workId, language: 'en', title: 'Rhythm of War', subtitle: null })
    await updateWorkTitle(t.db, scope, { titleId, title: 'Rhythm of War!', subtitle: 'Four', language: 'en' })
    expect(await workRow(workId)).toMatchObject({ title: 'קצב המלחמה' })
    const primary = (await rows(workId)).find((r) => r.primary)
    await updateWorkTitle(t.db, scope, { titleId: primary?.id ?? '', title: 'קצב', subtitle: null, language: 'he' })
    expect(await workRow(workId)).toMatchObject({ title: 'קצב' })
  })

  it('updateWork({titleId}) edits only that row', async () => {
    const { scope, workId } = await setup()
    const { titleId } = await addWorkTitle(t.db, scope, { workId, language: 'en', title: 'Rhythm of War', subtitle: null })
    await updateWork(t.db, scope, workId, { titleId, title: 'Rhythm of War!' })
    const all = await rows(workId)
    expect(all.find((r) => r.id === titleId)).toMatchObject({ title: 'Rhythm of War!', sortTitle: 'rhythm of war' })
    expect(all.find((r) => r.primary)).toMatchObject({ title: 'קצב המלחמה', language: 'he' })
    expect(await workRow(workId)).toMatchObject({ title: 'קצב המלחמה' })
    await updateWork(t.db, scope, workId, { titleId: all.find((r) => r.primary)?.id, title: 'קצב חדש' })
    expect(await workRow(workId)).toMatchObject({ title: 'קצב חדש' })
  })
})
