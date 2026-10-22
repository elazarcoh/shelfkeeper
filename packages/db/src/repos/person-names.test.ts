import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { contributorNames, contributors, editionContributors, users, workContributors } from '../schema'
import { seedName, seedUser, seedWork, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail } from './catalog'
import { getWorkCards } from './library'
import { loadUserScope } from './scope'
import { listVolumeCatalog } from './volume-cleanup'
import { listWishes, upsertWish } from './wishlist'

describe('the shown name', () => {
  const t = useTestDb()
  const member = async () => loadUserScope(t.db, await seedUser(t.db))
  // work-level names follow the viewer's languages first (#145); a viewer in neither language gets the credited name
  const inLanguages = async (titleLanguages: string[]) => {
    const user = await seedUser(t.db)
    await t.db.update(users).set({ titleLanguages }).where(eq(users.id, user.id))
    return loadUserScope(t.db, user)
  }

  async function twoSpellings(languages: string[] = ['fr']) {
    const scope = await inLanguages(languages)
    const en = await createWork(t.db, workInput({ editions: [{ format: 'physical', language: 'en' }] }))
    const [person] = await t.db.select({ id: contributors.id }).from(contributors)
    if (!person) throw new Error('seed failed')
    await seedName(t.db, person.id, 'ברנדון סנדרסון', 'he')
    const he = await createWork(t.db, workInput({ title: 'האימפריה האחרונה', authors: ['ברנדון סנדרסון'], series: [], editions: [{ format: 'physical', language: 'he' }] }))
    return { scope, en, he, personId: person.id }
  }

  it('a book shows the name it credited', async () => {
    const { scope, en, he, personId } = await twoSpellings()
    const a = await getWorkDetail(t.db, scope, en)
    const b = await getWorkDetail(t.db, scope, he)
    expect(a.authors).toMatchObject([{ id: personId, name: 'Brandon Sanderson' }])
    expect(b.authors).toMatchObject([{ id: personId, name: 'ברנדון סנדרסון' }])
    const cards = await getWorkCards(t.db, scope, [en, he])
    expect(cards.find((c) => c.id === he)?.authors).toEqual(['ברנדון סנדרסון'])
    expect(cards.find((c) => c.id === en)?.authors).toEqual(['Brandon Sanderson'])
  })

  it('the credited name wins over the edition languages', async () => {
    const { scope, he, personId } = await twoSpellings()
    const [name] = await t.db.select({ id: contributorNames.id }).from(contributorNames).where(eq(contributorNames.name, 'Brandon Sanderson'))
    await t.db.update(workContributors).set({ nameId: name?.id ?? '' }).where(eq(workContributors.workId, he))
    expect((await getWorkDetail(t.db, scope, he)).authors).toMatchObject([{ id: personId, name: 'Brandon Sanderson' }])
    expect((await getWorkCards(t.db, scope, [he]))[0]?.authors).toEqual(['Brandon Sanderson'])
  })

  it('a name in the viewer’s language beats the credited one (#145)', async () => {
    const { scope, he } = await twoSpellings(['en', 'he'])
    expect((await getWorkDetail(t.db, scope, he)).authors.map((a) => a.name)).toEqual(['Brandon Sanderson'])
    await t.db.update(workContributors).set({ nameId: null }).where(eq(workContributors.workId, he))
    expect((await getWorkDetail(t.db, scope, he)).authors.map((a) => a.name)).toEqual(['Brandon Sanderson'])
  })

  it('no name in the viewer’s languages: the primary name', async () => {
    const scope = await inLanguages(['fr'])
    const id = await createWork(t.db, workInput({ editions: [{ format: 'physical' }] }))
    const [person] = await t.db.select({ id: contributors.id }).from(contributors)
    if (!person) throw new Error('seed failed')
    await seedName(t.db, person.id, 'ברנדון סנדרסון', 'he')
    await t.db.update(workContributors).set({ nameId: null }).where(eq(workContributors.workId, id))
    expect((await getWorkDetail(t.db, scope, id)).authors.map((a) => a.name)).toEqual(['Brandon Sanderson'])
  })

  it("an edition's translator prefers the edition's own language, then the book's other edition languages", async () => {
    const scope = await member()
    const id = await createWork(
      t.db,
      workInput({ editions: [{ format: 'physical', language: 'en' }, { format: 'ebook', language: 'he', translators: ['Ofra Avigad'] }] }),
    )
    const [person] = await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, 'Ofra Avigad'))
    if (!person) throw new Error('seed failed')
    await t.db.update(contributorNames).set({ language: 'en' }).where(eq(contributorNames.contributorId, person.id))
    await seedName(t.db, person.id, 'עפרה אביגד', 'he')
    await t.db.update(editionContributors).set({ nameId: null })
    const w = await getWorkDetail(t.db, scope, id)
    expect(w.editions.find((e) => e.language === 'he')?.translators.map((p) => p.name)).toEqual(['עפרה אביגד'])
  })

  it('no credited name: the viewer’s language order, not the edition languages, picks the name (#145)', async () => {
    const scope = await member()
    const id = await createWork(t.db, workInput({ editions: [{ format: 'physical', language: 'he' }, { format: 'ebook', language: 'en' }] }))
    await t.db.execute(sql`update edition set created_at = created_at + interval '1 minute' where work_id = ${id} and format = 'ebook'`)
    const [person] = await t.db.select({ id: contributors.id }).from(contributors)
    if (!person) throw new Error('seed failed')
    await seedName(t.db, person.id, 'ברנדון סנדרסון', 'he')
    await t.db.update(contributorNames).set({ language: 'en' }).where(eq(contributorNames.name, 'Brandon Sanderson'))
    await t.db.update(workContributors).set({ nameId: null }).where(eq(workContributors.workId, id))
    expect((await getWorkDetail(t.db, scope, id)).authors.map((a) => a.name)).toEqual(['Brandon Sanderson'])
    expect((await getWorkCards(t.db, scope, [id]))[0]?.authors).toEqual(['Brandon Sanderson'])
  })

  it('a book with no editions and no credited name shows the primary name (#124)', async () => {
    const scope = await inLanguages(['fr'])
    const { workId } = await seedWork(t.db, { title: 'Wanted', authors: ['Brandon Sanderson'], noEditions: true })
    const [person] = await t.db.select({ id: contributors.id }).from(contributors)
    if (!person) throw new Error('seed failed')
    await seedName(t.db, person.id, 'ברנדון סנדרסון', 'he')
    await t.db.update(workContributors).set({ nameId: null }).where(eq(workContributors.workId, workId))
    expect((await getWorkCards(t.db, scope, [workId]))[0]?.authors).toEqual(['Brandon Sanderson'])
  })

  it("an edition person with no name in the edition's language uses a sibling edition's language, not another book's (#124)", async () => {
    const scope = await member()
    // an older decoy book with a Spanish edition
    await createWork(t.db, workInput({ title: 'Decoy', authors: ['Someone Else'], series: [], editions: [{ format: 'physical', language: 'es' }] }))
    const id = await createWork(
      t.db,
      workInput({ title: 'Target', editions: [{ format: 'physical', language: 'fr', translators: ['Ofra Avigad'] }, { format: 'ebook', language: 'he' }] }),
    )
    const [person] = await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, 'Ofra Avigad'))
    if (!person) throw new Error('seed failed')
    await t.db.update(contributorNames).set({ language: 'en' }).where(eq(contributorNames.contributorId, person.id))
    await seedName(t.db, person.id, 'Ofra (es)', 'es')
    await seedName(t.db, person.id, 'עפרה אביגד', 'he')
    await t.db.update(editionContributors).set({ nameId: null })
    const w = await getWorkDetail(t.db, scope, id)
    expect(w.editions.find((e) => e.language === 'fr')?.translators.map((p) => p.name)).toEqual(['עפרה אביגד'])
  })

  describe('selects without joins keep the outer columns qualified (#124)', () => {
    // two books, two people, no credited names; each person has a name in some language
    async function twoBooks() {
      const user = await seedUser(t.db, { role: 'admin' })
      const scope = await loadUserScope(t.db, user)
      const a = await createWork(t.db, workInput({ title: 'Book A', authors: ['Alpha'], series: [], editions: [{ format: 'physical', language: 'he' }] }))
      const b = await createWork(t.db, workInput({ title: 'Book B', authors: ['Beta'], series: [], editions: [{ format: 'physical', language: 'en' }] }))
      const idOf = async (name: string) => (await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, name)))[0]?.id ?? ''
      await t.db.update(contributorNames).set({ language: null }).where(eq(contributorNames.name, 'Alpha')) // creating the book tagged it
      await seedName(t.db, await idOf('Alpha'), 'אלפא', 'he')
      await seedName(t.db, await idOf('Beta'), 'Bétâ Bêta', 'fr') // no edition of Beta's book is French
      await t.db.update(workContributors).set({ nameId: null })
      return { scope, user, a, b }
    }

    it('getWorkCards', async () => {
      const { scope, a, b } = await twoBooks()
      const cards = await getWorkCards(t.db, scope, [a, b])
      expect(cards.find((c) => c.id === a)?.authors).toEqual(['אלפא'])
      expect(cards.find((c) => c.id === b)?.authors).toEqual(['Beta'])
    })

    it('the wishlist', async () => {
      const { scope, user, a, b } = await twoBooks()
      for (const id of [a, b]) await upsertWish(t.db, scope, id, { formats: ['physical'], language: null, note: null })
      const rows = await listWishes(t.db, scope, user.id)
      expect(rows.find((r) => r.workId === a)?.authors).toEqual(['אלפא'])
      expect(rows.find((r) => r.workId === b)?.authors).toEqual(['Beta'])
    })

    it('the volume catalog', async () => {
      const { scope, a, b } = await twoBooks()
      const rows = await listVolumeCatalog(t.db, scope)
      expect(rows.find((r) => r.id === a)?.authors).toEqual(['אלפא'])
      expect(rows.find((r) => r.id === b)?.authors).toEqual(['Beta'])
    })
  })
})
