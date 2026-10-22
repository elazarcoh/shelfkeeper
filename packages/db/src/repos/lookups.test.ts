import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { loadUserScope } from './scope'
import { contributorNames, contributors, workContributors } from '../schema'
import { seedName, seedUser, useTestDb, workInput } from '../testing'
import { createWork, updateWork } from './catalog'
import { upsertContributors } from './lookups'

describe('upsertContributors', () => {
  const t = useTestDb()

  it('creates a person with their first name, tagged with the given language', async () => {
    const [ref] = await upsertContributors(t.db, ['ברנדון סנדרסון'], 'he')
    const contributorId = ref?.contributorId ?? ''
    const names = await t.db.select().from(contributorNames).where(eq(contributorNames.contributorId, contributorId))
    expect(names).toEqual([expect.objectContaining({ id: ref?.nameId, name: 'ברנדון סנדרסון', language: 'he' })])
  })

  it('finds a person by any of their names, crediting the spelling used', async () => {
    const [en] = await upsertContributors(t.db, ['Brandon Sanderson'])
    const enId = en?.contributorId ?? ''
    const heId = await seedName(t.db, enId, 'ברנדון סנדרסון', 'he')
    expect(await upsertContributors(t.db, ['ברנדון  סנדרסון', 'brandon sanderson'])).toEqual([
      { contributorId: enId, nameId: heId },
      { contributorId: enId, nameId: en?.nameId },
    ])
    expect(await t.db.select().from(contributors)).toHaveLength(1)
  })

  it('never re-tags a known name', async () => {
    const [ref] = await upsertContributors(t.db, ['Brandon Sanderson'])
    await upsertContributors(t.db, ['Brandon Sanderson'], 'he')
    const [name] = await t.db.select().from(contributorNames).where(eq(contributorNames.id, ref?.nameId ?? ''))
    expect(name?.language).toBeNull()
  })

  it('concurrent first use of a name ends with one person and one name', async () => {
    const results = await Promise.all([1, 2, 3].map(() => t.db.transaction((tx) => upsertContributors(tx, ['Mary Robinette Kowal']))))
    for (const [r] of results) expect(r).toBeDefined()
    expect(new Set(results.map(([r]) => r?.contributorId)).size).toBe(1)
    expect(await t.db.select().from(contributorNames)).toHaveLength(1)
  })
})

describe('replaceAuthors', () => {
  const t = useTestDb()

  it('two spellings of one person are one link, crediting the first spelling', async () => {
    const workId = await createWork(t.db, workInput({ authors: ['Brandon Sanderson'] }))
    const [link] = await t.db.select().from(workContributors).where(eq(workContributors.workId, workId))
    const linkPerson = link?.contributorId ?? ''
    const heId = await seedName(t.db, linkPerson, 'ברנדון סנדרסון', 'he')
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    await updateWork(t.db, admin, workId, { authors: ['ברנדון סנדרסון', 'Brandon Sanderson'] })
    expect(await t.db.select().from(workContributors).where(eq(workContributors.workId, workId))).toEqual([
      expect.objectContaining({ contributorId: linkPerson, nameId: heId, position: 0 }),
    ])
  })
})
