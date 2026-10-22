import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { contributorNames, contributors, workContributors } from '../schema'
import { seedName, useTestDb, workInput } from '../testing'
import { createWork } from './catalog'

describe('credited-name guard', () => {
  const t = useTestDb()
  const person = async (name: string) => (await t.db.select().from(contributors).where(eq(contributors.name, name)))[0]

  it('rejects a link crediting another person’s name, at commit', async () => {
    await createWork(t.db, workInput({ title: 'One', authors: ['Brandon Sanderson'] }))
    await createWork(t.db, workInput({ title: 'Two', authors: ['Isaac Stewart'] }))
    const stewart = await person('Isaac Stewart')
    const sandersonName = (await t.db.select().from(contributorNames).where(eq(contributorNames.name, 'Brandon Sanderson')))[0]
    if (!stewart || !sandersonName) throw new Error('seed failed')
    await expect(
      t.db.transaction(async (tx) => {
        await tx.update(workContributors).set({ nameId: sandersonName.id }).where(eq(workContributors.contributorId, stewart.id))
      }),
    ).rejects.toThrow()
  })

  it('accepts moving a name and its links to another person in one transaction, in either order', async () => {
    await createWork(t.db, workInput({ title: 'One', authors: ['Brandon Sanderson'] }))
    await createWork(t.db, workInput({ title: 'Two', authors: ['Isaac Stewart'] }))
    const sanderson = await person('Brandon Sanderson')
    const stewart = await person('Isaac Stewart')
    if (!sanderson || !stewart) throw new Error('seed failed')
    await t.db.transaction(async (tx) => {
      await tx.update(workContributors).set({ contributorId: sanderson.id }).where(eq(workContributors.contributorId, stewart.id))
      await tx.update(contributorNames).set({ contributorId: sanderson.id }).where(eq(contributorNames.contributorId, stewart.id))
    })
    const links = await t.db.select().from(workContributors)
    expect(links.every((l) => l.contributorId === sanderson.id && l.nameId !== null)).toBe(true)
  })

  it('deleting a name nulls the links crediting it and keeps their person', async () => {
    await createWork(t.db, workInput({ title: 'One', authors: ['Brandon Sanderson'] }))
    const sanderson = await person('Brandon Sanderson')
    if (!sanderson) throw new Error('seed failed')
    const hebrew = await seedName(t.db, sanderson.id, 'ברנדון סנדרסון', 'he')
    await t.db.update(workContributors).set({ nameId: hebrew })
    await t.db.delete(contributorNames).where(eq(contributorNames.id, hebrew))
    const [link] = await t.db.select().from(workContributors)
    expect(link).toMatchObject({ contributorId: sanderson.id, nameId: null })
  })

  it('is deferrable, so the constraint is checked at commit', async () => {
    const rows = await t.db.execute<{ conname: string; condeferrable: boolean; condeferred: boolean }>(
      sql`select conname, condeferrable, condeferred from pg_constraint where conname in ('work_contributor_name_of_person_fk', 'edition_contributor_name_of_person_fk') order by conname`,
    )
    expect(rows.map((r) => [r.conname, r.condeferrable, r.condeferred])).toEqual([
      ['edition_contributor_name_of_person_fk', true, true],
      ['work_contributor_name_of_person_fk', true, true],
    ])
  })
})
