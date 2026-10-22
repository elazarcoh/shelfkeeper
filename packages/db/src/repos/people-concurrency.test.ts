import { eq, sql } from 'drizzle-orm'
import { normalizeText, sortName } from '@mylib/domain'
import { describe, expect, it } from 'vitest'
import type { Db } from '../client'
import { contributorNames, contributors } from '../schema'
import { useTestDb, waitFor, workInput } from '../testing'
import { createWork } from './catalog'
import { upsertContributors, type PersonRef } from './lookups'

describe('resolving names while an admin edit holds the people', () => {
  const t = useTestDb()

  const idOf = async (name: string) => (await t.db.select({ id: contributors.id }).from(contributors).where(eq(contributors.name, name)))[0]?.id ?? ''

  /** Runs `edit` in a transaction that stays open until `upsertContributors(names)` is seen waiting on a lock, then commits it. */
  async function resolveDuring(edit: (tx: Db) => Promise<void>, names: string[]): Promise<PersonRef[]> {
    let release = (): void => undefined
    let locked = (): void => undefined
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const editing = t.db.transaction(async (tx) => {
      await edit(tx)
      locked()
      await new Promise<void>((resolve) => (release = resolve))
    })
    await isLocked
    const resolving = upsertContributors(t.db, names)
    try {
      await waitFor(async () => {
        const [row] = await t.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%for key share%'`,
        )
        return (row?.n ?? 0) > 0
      }, 'upsertContributors to wait for the person')
    } finally {
      release()
      await editing
    }
    return resolving
  }

  /** The name's row agrees with the ref, so a link made from it passes migration 0018's guard. */
  async function expectConsistent(ref: PersonRef | undefined) {
    const [name] = await t.db.select().from(contributorNames).where(eq(contributorNames.id, ref?.nameId ?? ''))
    expect(name?.contributorId).toBe(ref?.contributorId)
  }

  /** One person credited as both spellings (what a merge leaves). */
  async function mergedSanderson() {
    await createWork(t.db, workInput({ title: 'The Way of Kings', authors: ['Brandon Sanderson'] }))
    const personId = await idOf('Brandon Sanderson')
    await t.db.insert(contributorNames).values({ contributorId: personId, name: 'ברנדון סנדרסון', normalizedName: normalizeText('ברנדון סנדרסון'), language: 'he' })
    return personId
  }

  it('waits for a merge in flight, then resolves to the person that now owns the name', async () => {
    await createWork(t.db, workInput({ title: 'The Way of Kings', authors: ['Brandon Sanderson'] }))
    await createWork(t.db, workInput({ title: 'דרך המלכים', authors: ['ברנדון סנדרסון'] }))
    const goneId = await idOf('Brandon Sanderson')
    const keptId = await idOf('ברנדון סנדרסון')
    // a merge in flight: the person locked FOR UPDATE, their name moved, the person deleted
    const [ref] = await resolveDuring(async (tx) => {
      await tx.select({ id: contributors.id }).from(contributors).where(eq(contributors.id, goneId)).for('update')
      await tx.update(contributorNames).set({ contributorId: keptId }).where(eq(contributorNames.contributorId, goneId))
      await tx.delete(contributors).where(eq(contributors.id, goneId))
    }, ['Brandon Sanderson'])
    expect(ref?.contributorId).toBe(keptId)
    await expectConsistent(ref)
    expect(await t.db.select().from(contributors)).toHaveLength(1)
  })

  it('waits for a split in flight, then resolves to the person the name was split off to', async () => {
    const personId = await mergedSanderson()
    const hebrew = 'ברנדון סנדרסון'
    let splitId = ''
    // a split in flight: the person locked FOR UPDATE, a new person made, the name moved to them
    const [ref] = await resolveDuring(async (tx) => {
      await tx.select({ id: contributors.id }).from(contributors).where(eq(contributors.id, personId)).for('update')
      const [created] = await tx.insert(contributors).values({ name: hebrew, sortName: sortName(hebrew), normalizedName: normalizeText(hebrew) }).returning({ id: contributors.id })
      splitId = created?.id ?? ''
      await tx.update(contributorNames).set({ contributorId: splitId }).where(eq(contributorNames.normalizedName, normalizeText(hebrew)))
    }, [hebrew])
    expect(ref?.contributorId).toBe(splitId)
    await expectConsistent(ref)
  })

  it('waits for a name removal in flight, then gives the spelling a person of its own', async () => {
    const personId = await mergedSanderson()
    const hebrew = 'ברנדון סנדרסון'
    // a removal in flight: the person locked FOR UPDATE, the name deleted
    const [ref] = await resolveDuring(async (tx) => {
      await tx.select({ id: contributors.id }).from(contributors).where(eq(contributors.id, personId)).for('update')
      await tx.delete(contributorNames).where(eq(contributorNames.normalizedName, normalizeText(hebrew)))
    }, [hebrew])
    expect(ref?.contributorId).not.toBe(personId)
    await expectConsistent(ref)
    expect(await t.db.select().from(contributors)).toHaveLength(2)
  })
})
