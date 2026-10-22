import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { WishFields, type ExtractedPage } from '@mylib/domain'
import { contributorNames, contributors, workContributors } from '../schema'
import { seedName, seedUser, useTestDb, workInput } from '../testing'
import { createWork, deleteWork, getWorkDetail, mergeWorks, updateEdition, updateWork } from './catalog'
import { pruneOrphanPeople } from './people'
import { createSet } from './sets'
import { loadUserScope } from './scope'
import { addWishFromPage, removeWish } from './wishlist'

describe('orphan people', () => {
  const t = useTestDb()
  const admin = async () => loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
  const names = async () => (await t.db.select({ name: contributors.name }).from(contributors)).map((r) => r.name).sort()

  it('deleting one of two books keeps the person; deleting the last removes them and their name', async () => {
    const scope = await admin()
    const a = await createWork(t.db, workInput({ title: 'One' }))
    const b = await createWork(t.db, workInput({ title: 'Two' }))
    await deleteWork(t.db, scope, a)
    expect(await names()).toEqual(['Brandon Sanderson'])
    await deleteWork(t.db, scope, b)
    expect(await t.db.select().from(contributors)).toEqual([])
    expect(await t.db.select().from(contributorNames)).toEqual([])
  })

  it('a person with two names, or curated, is kept with no books', async () => {
    const scope = await admin()
    const w = await createWork(t.db, workInput({ authors: ['Brandon Sanderson', 'Isaac Stewart'] }))
    const people = await t.db.select().from(contributors)
    const sanderson = people.find((p) => p.name === 'Brandon Sanderson')
    const stewart = people.find((p) => p.name === 'Isaac Stewart')
    if (!sanderson || !stewart) throw new Error('seed failed')
    await seedName(t.db, sanderson.id, 'ברנדון סנדרסון', 'he')
    await t.db.update(contributors).set({ curated: true }).where(eq(contributors.id, stewart.id))
    await deleteWork(t.db, scope, w)
    expect(await names()).toEqual(['Brandon Sanderson', 'Isaac Stewart'])
  })

  it('re-saving the same authors keeps the people', async () => {
    const scope = await admin()
    const w = await createWork(t.db, workInput())
    const before = await t.db.select({ id: contributors.id }).from(contributors)
    await updateWork(t.db, scope, w, { authors: ['Brandon Sanderson'] })
    expect(await t.db.select({ id: contributors.id }).from(contributors)).toEqual(before)
  })

  it('replacing an author prunes the old one', async () => {
    const scope = await admin()
    const w = await createWork(t.db, workInput({ authors: ['A'] }))
    await updateWork(t.db, scope, w, { authors: ['B'] })
    expect(await names()).toEqual(['B'])
  })

  it('a translator removed from an edition is pruned', async () => {
    const scope = await admin()
    const w = await createWork(t.db, workInput({ editions: [{ format: 'physical', translators: ['Tina Translator'] }] }))
    expect(await names()).toContain('Tina Translator')
    const editionId = (await getWorkDetail(t.db, scope, w)).editions[0]?.id ?? ''
    await updateEdition(t.db, scope, editionId, { translators: [] })
    expect(await names()).toEqual(['Brandon Sanderson'])
  })

  it('merging works keeps people still linked through moved editions', async () => {
    const scope = await admin()
    const target = await createWork(t.db, workInput({ title: 'Target', authors: ['Target Author'] }))
    const source = await createWork(t.db, workInput({ title: 'Source', authors: ['Source Author'], editions: [{ format: 'audiobook', narrators: ['Nora Narrator'] }] }))
    await mergeWorks(t.db, scope, target, [source])
    const got = await names()
    expect(got).toContain('Nora Narrator')
    expect(got).toContain('Target Author')
    expect(got).not.toContain('Source Author')
  })

  it('removing a wish that deletes its book prunes its author', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db, { username: 'dana' }))
    const page: ExtractedPage = {
      provider: 'simania',
      providerId: '1',
      url: 'https://simania.co.il/bookdetails.php?item_id=1',
      title: 'המושבה האבודה',
      subtitle: null,
      authors: ['אואן קולפר'],
      translators: [],
      publisher: null,
      year: null,
      publishedOn: null,
      pageCount: null,
      isbn13: null,
      isbn10: null,
      series: null,
      language: 'he',
      coverUrl: null,
      description: null,
      volume: null,
      importedTitle: null,
    }
    const { workId } = await addWishFromPage(t.db, scope, { page, target: { action: 'create_work' }, fields: WishFields.parse({ formats: ['physical'], language: 'he', note: null }) })
    expect(await names()).toEqual(['אואן קולפר'])
    await removeWish(t.db, scope, workId)
    expect(await names()).toEqual([])
  })

  it('a person moved from narrators to translators in one save keeps their id', async () => {
    const scope = await admin()
    const w = await createWork(t.db, workInput({ editions: [{ format: 'audiobook', narrators: ['Nora Narrator'] }] }))
    const editionId = (await getWorkDetail(t.db, scope, w)).editions[0]?.id ?? ''
    const [before] = await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, 'Nora Narrator'))
    await updateEdition(t.db, scope, editionId, { narrators: [], translators: ['Nora Narrator'] })
    const edition = (await getWorkDetail(t.db, scope, w)).editions[0]
    expect(edition?.narrators).toEqual([])
    expect(edition?.translators).toEqual([{ id: before?.id, name: 'Nora Narrator' }])
  })

  it("new edition people get the edition's language", async () => {
    const scope = await admin()
    const w = await createWork(t.db, workInput({ authors: ['אואן קולפר'], editions: [{ format: 'physical', language: 'he', translators: ['עפרה אביגד'] }] }))
    const editionId = (await getWorkDetail(t.db, scope, w)).editions[0]?.id ?? ''
    await updateEdition(t.db, scope, editionId, { narrators: ['נורה'] })
    const langOf = async (name: string) => (await t.db.select().from(contributorNames).where(eq(contributorNames.name, name)))[0]?.language
    expect(await langOf('עפרה אביגד')).toBe('he')
    expect(await langOf('נורה')).toBe('he')
    await updateEdition(t.db, scope, editionId, { language: 'en', translators: ['Tina'] })
    expect(await langOf('Tina')).toBe('en')
  })

  it('a person a smart set filters by is kept when their last book goes; an unreferenced one is pruned', async () => {
    const scope = await admin()
    const a = await createWork(t.db, workInput({ title: 'One', authors: ['Kept Author'] }))
    const b = await createWork(t.db, workInput({ title: 'Two', authors: ['Gone Author'] }))
    const person = async (name: string) => (await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, name)))[0]?.id ?? ''
    // nested under and/not: filters nest
    await createSet(t.db, scope, {
      kind: 'smart',
      scope: 'global',
      name: 'Kept',
      filter: { op: 'and', nodes: [{ op: 'format', formats: ['physical'] }, { op: 'not', node: { op: 'author', contributorIds: [await person('Kept Author')] } }] },
    })
    await deleteWork(t.db, scope, a)
    await deleteWork(t.db, scope, b)
    expect(await names()).toEqual(['Kept Author'])
  })

  it('pruning waits for a concurrent write that links the person, and keeps them', async () => {
    const w = await createWork(t.db, workInput())
    const [link] = await t.db.select().from(workContributors).where(eq(workContributors.workId, w))
    if (!link) throw new Error('seed failed')
    await t.db.delete(workContributors).where(eq(workContributors.workId, w))
    let release: () => void = () => undefined
    const hold = new Promise<void>((r) => (release = r))
    let linked: () => void = () => undefined
    const isLinked = new Promise<void>((r) => (linked = r))
    // B links the person again and stays open
    const b = t.db.transaction(async (tx) => {
      await tx.insert(workContributors).values({ workId: w, contributorId: link.contributorId, nameId: link.nameId, position: 0 })
      linked()
      await hold
    })
    await isLinked
    let pruned = false
    const a = t.db.transaction((tx) => pruneOrphanPeople(tx, [link.contributorId])).then(() => (pruned = true))
    await new Promise((r) => setTimeout(r, 300))
    expect(pruned).toBe(false)
    release()
    await Promise.all([a, b])
    expect(await names()).toEqual(['Brandon Sanderson'])
    expect(await t.db.select().from(workContributors).where(eq(workContributors.workId, w))).toHaveLength(1)
  })
})
