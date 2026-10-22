import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { contributorNames, contributors, editionContributors, editions, sets, workContributors } from '../schema'

/** The people linked to these works (their own credits and their editions') or editions. */
export async function linkedPeople(db: Db, of: { workIds?: readonly string[]; editionIds?: readonly string[] }): Promise<string[]> {
  const workIds = [...(of.workIds ?? [])]
  const editionIds = [...(of.editionIds ?? [])]
  const ids = new Set<string>()
  if (workIds.length > 0) {
    for (const r of await db.select({ id: workContributors.contributorId }).from(workContributors).where(inArray(workContributors.workId, workIds))) ids.add(r.id)
    for (const r of await db
      .select({ id: editionContributors.contributorId })
      .from(editionContributors)
      .innerJoin(editions, eq(editions.id, editionContributors.editionId))
      .where(inArray(editions.workId, workIds)))
      ids.add(r.id)
  }
  if (editionIds.length > 0) {
    for (const r of await db.select({ id: editionContributors.contributorId }).from(editionContributors).where(inArray(editionContributors.editionId, editionIds))) ids.add(r.id)
  }
  return [...ids]
}

/**
 * Removes those of these people that no book credits any more, unless someone curated them, a smart set filters by
 * them (its filter holds their id) or they have more than one name (spec "Orphans": a name is knowledge worth keeping).
 * Call in the same transaction, after the write.
 */
export async function pruneOrphanPeople(db: Db, contributorIds: readonly string[]): Promise<void> {
  const ids = [...new Set(contributorIds)]
  if (ids.length === 0) return
  // lock first: a concurrent write linking one of them holds a key-share lock, so we wait for it and the delete below
  // (a new statement, a fresh snapshot) sees its link instead of cascading it away
  await db.select({ id: contributors.id }).from(contributors).where(inArray(contributors.id, ids)).orderBy(contributors.id).for('update')
  await db
    .delete(contributors)
    .where(
      and(
        inArray(contributors.id, ids),
        eq(contributors.curated, false),
        sql`not exists (select 1 from ${workContributors} where ${workContributors.contributorId} = ${contributors.id})`,
        sql`not exists (select 1 from ${editionContributors} where ${editionContributors.contributorId} = ${contributors.id})`,
        sql`not exists (select 1 from ${sets} where jsonb_path_exists(${sets.filter}, '$.** ? (@.contributorIds[*] == $id)', jsonb_build_object('id', ${contributors.id}::text)))`,
        sql`(select count(*) from ${contributorNames} where ${contributorNames.contributorId} = ${contributors.id}) <= 1`,
      ),
    )
}
