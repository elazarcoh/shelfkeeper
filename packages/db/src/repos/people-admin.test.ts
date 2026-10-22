import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { contributors, editionContributors, editions } from '../schema'
import { seedName, seedUser, useTestDb, workInput } from '../testing'
import { createWork } from './catalog'
import { getPerson, listPeople } from './people-admin'
import { loadUserScope } from './scope'

describe('people list and detail', () => {
  const t = useTestDb()
  const admin = async () => loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
  const idOf = async (name: string) => (await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, name)))[0]?.id ?? ''

  it('lists people by sort name with their names (primary first) and per-role book counts', async () => {
    const scope = await admin()
    await createWork(t.db, workInput({ title: 'The Way of Kings', authors: ['Brandon Sanderson'], editions: [{ format: 'physical', language: 'en' }] }))
    await createWork(t.db, workInput({ title: 'דרך המלכים', authors: ['Brandon Sanderson'], editions: [{ format: 'physical', language: 'he', translators: ['Isaac Stewart'] }] }))
    await seedName(t.db, await idOf('Brandon Sanderson'), 'ברנדון סנדרסון', 'he')
    const illustrated = await createWork(t.db, workInput({ title: 'Illustrated', authors: ['Ann Author'], editions: [{ format: 'physical', language: 'en' }] }))
    const edition = (await t.db.select({ id: editions.id }).from(editions).where(eq(editions.workId, illustrated)))[0]
    await t.db.insert(editionContributors).values({ editionId: edition?.id ?? '', contributorId: await idOf('Isaac Stewart'), role: 'illustrator', position: 0 })
    const { people, more } = await listPeople(t.db, scope, { q: '', limit: 100 })
    expect(more).toBe(false)
    expect(people.map((p) => p.name)).toEqual(['Ann Author', 'Brandon Sanderson', 'Isaac Stewart'])
    expect(people[1]).toMatchObject({ authorOf: 2, translatorOf: 0, narratorOf: 0, illustratorOf: 0, curated: false })
    expect(people[1]?.names.map((n) => [n.name, n.language, n.primary])).toEqual([
      ['Brandon Sanderson', 'en', true], // created with the first work, so it takes that first edition's language
      ['ברנדון סנדרסון', 'he', false],
    ])
    expect(people[2]).toMatchObject({ authorOf: 0, translatorOf: 1, illustratorOf: 1 })
  })

  it('finds a person by any of their names, and pages with more', async () => {
    const scope = await admin()
    await createWork(t.db, workInput({ title: 'One', authors: ['Brandon Sanderson'] }))
    await createWork(t.db, workInput({ title: 'Two', authors: ['Isaac Stewart'] }))
    await seedName(t.db, await idOf('Brandon Sanderson'), 'ברנדון סנדרסון', 'he')
    expect((await listPeople(t.db, scope, { q: 'סנדרסון', limit: 100 })).people.map((p) => p.name)).toEqual(['Brandon Sanderson'])
    expect(await listPeople(t.db, scope, { q: '', limit: 1 })).toMatchObject({ more: true, people: [{ name: 'Brandon Sanderson' }] })
  })

  it('shows a person with no books (an orphan kept for their names) with zero counts', async () => {
    const scope = await admin()
    const [p] = await t.db.insert(contributors).values({ name: 'Nobody', sortName: 'nobody', normalizedName: 'nobody', curated: true }).returning()
    if (!p) throw new Error('seed failed')
    await seedName(t.db, p.id, 'Nobody')
    expect((await listPeople(t.db, scope, { q: 'nobody', limit: 100 })).people[0]).toMatchObject({ authorOf: 0, translatorOf: 0, narratorOf: 0, illustratorOf: 0 })
  })

  it("a person's book language comes from its edition when the work has none (#124)", async () => {
    const scope = await admin()
    await createWork(t.db, workInput({ title: 'Edition Only', authors: ['Brandon Sanderson'], editions: [{ format: 'physical', language: 'he' }] }))
    const detail = await getPerson(t.db, scope, await idOf('Brandon Sanderson'))
    expect(detail.books.map((b) => [b.title, b.language])).toEqual([['Edition Only', 'he']])
  })

  it("an edition person's book language falls back to a sibling edition's when the edition has none (#124)", async () => {
    const scope = await admin()
    await createWork(t.db, workInput({ title: 'Mixed', authors: ['Someone Else'], editions: [{ format: 'physical', translators: ['Isaac Stewart'] }, { format: 'ebook', language: 'he' }] }))
    const detail = await getPerson(t.db, scope, await idOf('Isaac Stewart'))
    expect(detail.books.map((b) => [b.title, b.role, b.language])).toEqual([['Mixed', 'translator', 'he']])
  })

  it('a person’s detail lists their books with role, credited name and language', async () => {
    const scope = await admin()
    await createWork(t.db, workInput({ title: 'The Way of Kings', authors: ['Brandon Sanderson'], editions: [{ format: 'physical', language: 'en' }] }))
    await createWork(t.db, workInput({ title: 'Mistborn (audio)', authors: ['Someone Else'], editions: [{ format: 'audiobook', narrators: ['Brandon Sanderson'], language: 'he' }] }))
    const detail = await getPerson(t.db, scope, await idOf('Brandon Sanderson'))
    expect(detail.bookCount).toBe(2)
    expect(detail.books.map((b) => [b.title, b.role, b.language])).toEqual([
      ['Mistborn (audio)', 'narrator', 'he'],
      ['The Way of Kings', 'author', 'en'],
    ])
    expect(detail.books.every((b) => b.nameId === detail.names[0]?.id)).toBe(true)
  })

  it('is admin-only and reports a missing person', async () => {
    const member = await loadUserScope(t.db, await seedUser(t.db))
    await expect(listPeople(t.db, member, { q: '', limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(getPerson(t.db, await admin(), '00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
