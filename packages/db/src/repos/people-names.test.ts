import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { contributorNames, contributors, workContributors, workSearch } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail, updateWork } from './catalog'
import { addPersonName, deletePerson, getPerson, makeNamePrimary, mergePeople, removePersonName, setNameLanguage, splitOffName } from './people-admin'
import { createSet } from './sets'
import { loadUserScope } from './scope'

describe('a person’s names', () => {
  const t = useTestDb()
  const admin = async () => loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
  const idOf = async (name: string) => (await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, name)))[0]?.id ?? ''
  const nameId = async (name: string) => (await t.db.select({ id: contributorNames.id }).from(contributorNames).where(eq(contributorNames.name, name)))[0]?.id ?? ''

  /** "Brandon Sanderson" (primary) and "ברנדון סנדרסון" merged into one person, one book each */
  async function merged() {
    const scope = await admin()
    const en = await createWork(t.db, workInput({ title: 'The Way of Kings', authors: ['Brandon Sanderson'], editions: [{ format: 'physical', language: 'en' }] }))
    const he = await createWork(t.db, workInput({ title: 'דרך המלכים', authors: ['ברנדון סנדרסון'], editions: [{ format: 'physical', language: 'he' }] }))
    const person = await idOf('Brandon Sanderson')
    await mergePeople(t.db, scope, { personId: person, otherId: await idOf('ברנדון סנדרסון'), primaryNameId: await nameId('Brandon Sanderson'), languages: [] })
    return { scope, en, he, person }
  }

  describe('split off this name', () => {
    it('makes the name a new person with the books crediting it; a later import with it lands there', async () => {
      const { scope, en, he, person } = await merged()
      const { personId } = await splitOffName(t.db, scope, { nameId: await nameId('ברנדון סנדרסון'), primaryNameId: null })
      expect(personId).not.toBe(person)
      expect((await getWorkDetail(t.db, scope, he)).authors).toMatchObject([{ id: personId, name: 'ברנדון סנדרסון' }])
      expect((await getWorkDetail(t.db, scope, en)).authors).toMatchObject([{ id: person, name: 'Brandon Sanderson' }])
      const [split] = await t.db.select().from(contributors).where(eq(contributors.id, personId))
      expect(split).toMatchObject({ name: 'ברנדון סנדרסון', curated: false })
      const later = await createWork(t.db, workInput({ title: 'Later', authors: ['ברנדון סנדרסון'] }))
      expect((await getWorkDetail(t.db, scope, later)).authors[0]?.id).toBe(personId)
      const [row] = await t.db.select().from(workSearch).where(eq(workSearch.workId, en))
      expect(JSON.stringify(row)).not.toContain('ברנדון')
    })

    it('a book edited after the merge to credit the other spelling stays with the kept person', async () => {
      const { scope, he, person } = await merged()
      await updateWork(t.db, scope, he, { authors: ['Brandon Sanderson'] })
      await splitOffName(t.db, scope, { nameId: await nameId('ברנדון סנדרסון'), primaryNameId: null })
      expect((await getWorkDetail(t.db, scope, he)).authors[0]?.id).toBe(person)
    })

    it('splitting off the primary name makes another name primary first', async () => {
      const { scope, person } = await merged()
      const { personId } = await splitOffName(t.db, scope, { nameId: await nameId('Brandon Sanderson'), primaryNameId: await nameId('ברנדון סנדרסון') })
      const [kept] = await t.db.select().from(contributors).where(eq(contributors.id, person))
      expect(kept).toMatchObject({ name: 'ברנדון סנדרסון', curated: true })
      const [split] = await t.db.select().from(contributors).where(eq(contributors.id, personId))
      expect(split?.name).toBe('Brandon Sanderson')
    })

    it('refuses to split a person’s only name, or to hand the primary to the split name itself', async () => {
      const { scope } = await merged()
      await createWork(t.db, workInput({ title: 'Solo', authors: ['Isaac Stewart'] }))
      await expect(splitOffName(t.db, scope, { nameId: await nameId('Isaac Stewart'), primaryNameId: null })).rejects.toMatchObject({ code: 'INVALID' })
      const en = await nameId('Brandon Sanderson')
      await expect(splitOffName(t.db, scope, { nameId: en, primaryNameId: en })).rejects.toMatchObject({ code: 'INVALID' })
    })
  })

  describe('add a name', () => {
    it('adds a spelling with its language, curates the person and rebuilds their search rows', async () => {
      const scope = await admin()
      const w = await createWork(t.db, workInput({ title: 'One', authors: ['Brandon Sanderson'] }))
      const person = await idOf('Brandon Sanderson')
      await addPersonName(t.db, scope, { personId: person, name: 'ברנדון סנדרסון', language: 'he' })
      expect((await getPerson(t.db, scope, person)).names.map((n) => [n.name, n.language])).toEqual([
        ['Brandon Sanderson', null],
        ['ברנדון סנדרסון', 'he'],
      ])
      expect((await t.db.select().from(contributors))[0]?.curated).toBe(true)
      const [row] = await t.db.select().from(workSearch).where(eq(workSearch.workId, w))
      expect(JSON.stringify(row)).toContain('ברנדון')
    })

    it('refuses a spelling someone already has, naming them', async () => {
      const scope = await admin()
      await createWork(t.db, workInput({ title: 'One', authors: ['Brandon Sanderson'] }))
      await createWork(t.db, workInput({ title: 'Two', authors: ['ברנדון סנדרסון'] }))
      await expect(addPersonName(t.db, scope, { personId: await idOf('Brandon Sanderson'), name: ' ברנדון  סנדרסון ', language: null })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'That name is ברנדון סנדרסון’s — use Same person as… instead',
      })
      await expect(addPersonName(t.db, scope, { personId: await idOf('Brandon Sanderson'), name: 'brandon sanderson', language: null })).rejects.toMatchObject({ code: 'CONFLICT' })
    })
  })

  it('sets a name’s language and makes a name primary', async () => {
    const { scope, person } = await merged()
    await setNameLanguage(t.db, scope, { nameId: await nameId('ברנדון סנדרסון'), language: 'he' })
    await makeNamePrimary(t.db, scope, await nameId('ברנדון סנדרסון'))
    const [p] = await t.db.select().from(contributors).where(eq(contributors.id, person))
    expect(p).toMatchObject({ name: 'ברנדון סנדרסון', normalizedName: 'ברנדון סנדרסון', curated: true })
    expect((await getPerson(t.db, scope, person)).names.map((n) => [n.name, n.language, n.primary])).toEqual([
      ['ברנדון סנדרסון', 'he', true],
      ['Brandon Sanderson', 'en', false],
    ])
  })

  describe('remove a name', () => {
    it('keeps the books on the person, crediting no name, and frees the spelling', async () => {
      const { scope, he, person } = await merged()
      await removePersonName(t.db, scope, await nameId('ברנדון סנדרסון'))
      const [link] = await t.db.select().from(workContributors).where(eq(workContributors.workId, he))
      expect(link).toMatchObject({ contributorId: person, nameId: null })
      expect((await getWorkDetail(t.db, scope, he)).authors).toMatchObject([{ id: person, name: 'Brandon Sanderson' }])
      const later = await createWork(t.db, workInput({ title: 'Later', authors: ['ברנדון סנדרסון'] }))
      expect((await getWorkDetail(t.db, scope, later)).authors[0]?.id).not.toBe(person)
    })

    it('refuses to remove the primary name', async () => {
      const { scope } = await merged()
      await expect(removePersonName(t.db, scope, await nameId('Brandon Sanderson'))).rejects.toMatchObject({ code: 'INVALID', message: 'Make another name primary first' })
    })
  })

  describe('delete a person', () => {
    it('deletes a person with no books, and refuses one with books or a smart set filtering by them', async () => {
      const scope = await admin()
      await createWork(t.db, workInput({ title: 'One', authors: ['Brandon Sanderson'] }))
      await expect(deletePerson(t.db, scope, await idOf('Brandon Sanderson'))).rejects.toMatchObject({ code: 'CONFLICT' })
      const [lone] = await t.db.insert(contributors).values({ name: 'Lone', sortName: 'lone', normalizedName: 'lone', curated: true }).returning()
      const [kept] = await t.db.insert(contributors).values({ name: 'Kept', sortName: 'kept', normalizedName: 'kept', curated: true }).returning()
      if (!lone || !kept) throw new Error('seed failed')
      await createSet(t.db, scope, { kind: 'smart', scope: 'global', name: 'Kept', filter: { op: 'author', contributorIds: [kept.id] } })
      await expect(deletePerson(t.db, scope, kept.id)).rejects.toMatchObject({ code: 'CONFLICT', message: 'A smart set filters by them' })
      await deletePerson(t.db, scope, lone.id)
      expect((await t.db.select().from(contributors).where(eq(contributors.id, lone.id))).length).toBe(0)
    })
  })

  it('is admin-only', async () => {
    const member = await loadUserScope(t.db, await seedUser(t.db))
    const id = '00000000-0000-4000-8000-000000000001'
    await expect(removePersonName(t.db, member, id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(deletePerson(t.db, member, id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
