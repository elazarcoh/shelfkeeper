import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { contributorNames, contributors, sets, users, workContributors, workSearch } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail } from './catalog'
import { upsertContributors } from './lookups'
import { getPerson, mergePeople } from './people-admin'
import { createSet } from './sets'
import { loadUserScope } from './scope'

describe('merge people', () => {
  const t = useTestDb()
  const admin = async () => loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
  // a viewer none of the names is in the language of: each book falls back to the spelling it credited (#145)
  const outsider = async () => {
    const user = await seedUser(t.db)
    await t.db.update(users).set({ titleLanguages: ['fr'] }).where(eq(users.id, user.id))
    return loadUserScope(t.db, user)
  }
  const idOf = async (name: string) => (await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, name)))[0]?.id ?? ''
  const primaryNameOf = async (personId: string) => (await getPerson(t.db, await admin(), personId)).names[0]?.id ?? ''

  async function sanderson() {
    const en = await createWork(t.db, workInput({ title: 'The Way of Kings', authors: ['Brandon Sanderson'], editions: [{ format: 'physical', language: 'en' }] }))
    const he = await createWork(t.db, workInput({ title: 'דרך המלכים', authors: ['ברנדון סנדרסון'], editions: [{ format: 'physical', language: 'he' }] }))
    return { en, he, enPerson: await idOf('Brandon Sanderson'), hePerson: await idOf('ברנדון סנדרסון') }
  }

  it('moves the other person’s books and names to the kept one; each book keeps its spelling', async () => {
    const scope = await admin()
    const s = await sanderson()
    const result = await mergePeople(t.db, scope, { personId: s.hePerson, otherId: s.enPerson, primaryNameId: await primaryNameOf(s.enPerson), languages: [] })
    expect(result.personId).toBe(s.enPerson)
    const people = await t.db.select().from(contributors)
    expect(people).toHaveLength(1)
    expect(people[0]).toMatchObject({ id: s.enPerson, name: 'Brandon Sanderson', normalizedName: 'brandon sanderson', curated: true })
    expect((await t.db.select().from(contributorNames)).map((n) => n.contributorId)).toEqual([s.enPerson, s.enPerson])
    const viewer = await outsider()
    expect((await getWorkDetail(t.db, viewer, s.en)).authors).toMatchObject([{ id: s.enPerson, name: 'Brandon Sanderson' }])
    expect((await getWorkDetail(t.db, viewer, s.he)).authors).toMatchObject([{ id: s.enPerson, name: 'ברנדון סנדרסון' }])
  })

  it('keeps the person whose name is chosen as primary', async () => {
    const scope = await admin()
    const s = await sanderson()
    const result = await mergePeople(t.db, scope, { personId: s.enPerson, otherId: s.hePerson, primaryNameId: await primaryNameOf(s.hePerson), languages: [] })
    expect(result.personId).toBe(s.hePerson)
    expect(await t.db.select({ id: contributors.id, name: contributors.name }).from(contributors)).toEqual([{ id: s.hePerson, name: 'ברנדון סנדרסון' }])
  })

  it('sets the names’ languages', async () => {
    const scope = await admin()
    const s = await sanderson()
    const enName = await primaryNameOf(s.enPerson)
    const heName = await primaryNameOf(s.hePerson)
    await mergePeople(t.db, scope, { personId: s.enPerson, otherId: s.hePerson, primaryNameId: enName, languages: [{ nameId: enName, language: 'en' }, { nameId: heName, language: 'he' }] })
    const names = await t.db.select({ name: contributorNames.name, language: contributorNames.language }).from(contributorNames)
    expect(names.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'Brandon Sanderson', language: 'en' },
      { name: 'ברנדון סנדרסון', language: 'he' },
    ])
  })

  it('one book crediting both spellings keeps one author row, the lower position with its spelling', async () => {
    const scope = await admin()
    const w = await createWork(t.db, workInput({ title: 'Both', authors: ['Brandon Sanderson', 'ברנדון סנדרסון'] }))
    const enPerson = await idOf('Brandon Sanderson')
    const hePerson = await idOf('ברנדון סנדרסון')
    await mergePeople(t.db, scope, { personId: enPerson, otherId: hePerson, primaryNameId: await primaryNameOf(hePerson), languages: [] })
    const rows = await t.db.select().from(workContributors).where(eq(workContributors.workId, w))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ contributorId: hePerson, position: 0 })
    expect((await getWorkDetail(t.db, scope, w)).authors).toMatchObject([{ id: hePerson, name: 'Brandon Sanderson' }])
  })

  it('one edition with both as translators keeps one translator row', async () => {
    const scope = await admin()
    const w = await createWork(t.db, workInput({ title: 'Translated', authors: ['Someone'], editions: [{ format: 'physical', translators: ['Ofra Avigad', 'עפרה אביגד'] }] }))
    const a = await idOf('Ofra Avigad')
    const b = await idOf('עפרה אביגד')
    await mergePeople(t.db, scope, { personId: a, otherId: b, primaryNameId: await primaryNameOf(a), languages: [] })
    const detail = await getWorkDetail(t.db, scope, w)
    expect(detail.editions[0]?.translators).toEqual([{ id: a, name: 'Ofra Avigad' }])
  })

  it('rebuilds search, so the other spelling finds both books', async () => {
    const scope = await admin()
    const s = await sanderson()
    await mergePeople(t.db, scope, { personId: s.enPerson, otherId: s.hePerson, primaryNameId: await primaryNameOf(s.enPerson), languages: [] })
    const [row] = await t.db.select().from(workSearch).where(eq(workSearch.workId, s.en))
    expect(JSON.stringify(row)).toContain('ברנדון')
  })

  it('a smart set filtering by the merged-away person follows the kept one', async () => {
    const scope = await admin()
    const s = await sanderson()
    const set = await createSet(t.db, scope, { kind: 'smart', scope: 'global', name: 'Sanderson', filter: { op: 'author', contributorIds: [s.hePerson] } })
    await mergePeople(t.db, scope, { personId: s.enPerson, otherId: s.hePerson, primaryNameId: await primaryNameOf(s.enPerson), languages: [] })
    const [row] = await t.db.select({ filter: sets.filter }).from(sets).where(eq(sets.id, set.id))
    expect(row?.filter).toEqual({ op: 'author', contributorIds: [s.enPerson] })
  })

  it('a later import with either spelling lands on the kept person', async () => {
    const scope = await admin()
    const s = await sanderson()
    await mergePeople(t.db, scope, { personId: s.enPerson, otherId: s.hePerson, primaryNameId: await primaryNameOf(s.enPerson), languages: [] })
    const refs = await upsertContributors(t.db, ['ברנדון סנדרסון', 'Brandon Sanderson'])
    expect(refs.map((r) => r.contributorId)).toEqual([s.enPerson, s.enPerson])
  })

  it('refuses a primary name of neither person, a person merged with themselves, and non-admins', async () => {
    const scope = await admin()
    const s = await sanderson()
    await createWork(t.db, workInput({ title: 'Third', authors: ['Isaac Stewart'] }))
    const stranger = await primaryNameOf(await idOf('Isaac Stewart'))
    await expect(mergePeople(t.db, scope, { personId: s.enPerson, otherId: s.hePerson, primaryNameId: stranger, languages: [] })).rejects.toMatchObject({ code: 'INVALID' })
    await expect(mergePeople(t.db, scope, { personId: s.enPerson, otherId: s.enPerson, primaryNameId: await primaryNameOf(s.enPerson), languages: [] })).rejects.toMatchObject({ code: 'INVALID' })
    const member = await loadUserScope(t.db, await seedUser(t.db))
    await expect(mergePeople(t.db, member, { personId: s.enPerson, otherId: s.hePerson, primaryNameId: await primaryNameOf(s.enPerson), languages: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
