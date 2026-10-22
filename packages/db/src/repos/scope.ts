import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { DomainError, SmartFilter, notFound, type FilterNode, type UserRole } from '@mylib/domain'
import type { Db } from '../client'
import { queueEntries, readingSessions, setItems, sets, userHiddenSets, userHiddenWorks, userSets, userWorks, users, works } from '../schema'
import { compileFilter } from './filter-sql'

declare const scopeBrand: unique symbol

/**
 * Everything a per-user work query needs, as SQL correlated to "work"."id".
 * Only loadUserScope creates one, so queries cannot forget visibility. It is a per-request snapshot.
 */
export interface UserScope {
  readonly userId: string
  readonly role: UserRole
  /** this person's preferred title languages, in order (#145) */
  readonly languages: readonly string[]
  /** works this user may see at all */
  readonly visible: SQL
  /** visible works that are in this user's personal library */
  readonly inLibrary: SQL
  readonly [scopeBrand]: true
}

function storedFilter(raw: FilterNode | null): FilterNode {
  return SmartFilter.parse(raw)
}

export async function loadUserScope(db: Db, user: { id: string; role: UserRole }): Promise<UserScope> {
  const u = user.id
  const [hiddenSmart, activeSmart, [me]] = await Promise.all([
    db
      .select({ filter: sets.filter })
      .from(userHiddenSets)
      .innerJoin(sets, eq(sets.id, userHiddenSets.setId))
      .where(and(eq(userHiddenSets.userId, u), eq(sets.kind, 'smart'))),
    db
      .select({ filter: sets.filter })
      .from(userSets)
      .innerJoin(sets, eq(sets.id, userSets.setId))
      .where(and(eq(userSets.userId, u), eq(userSets.active, true), eq(sets.kind, 'smart'))),
    db.select({ languages: users.titleLanguages }).from(users).where(eq(users.id, u)),
  ])

  const hiddenChecks: SQL[] = [
    sql`not exists (select 1 from ${userHiddenWorks} where ${userHiddenWorks.userId} = ${u} and ${userHiddenWorks.workId} = ${works.id})`,
    sql`not exists (select 1 from ${userHiddenSets} join ${setItems} on ${setItems.setId} = ${userHiddenSets.setId} where ${userHiddenSets.userId} = ${u} and ${setItems.workId} = ${works.id})`,
    // coalesce: a NULL filter result (e.g. unknown language) means "not in the set", so stays visible
    ...hiddenSmart.map((s) => sql`not coalesce(${compileFilter(storedFilter(s.filter), u)}, false)`),
  ]
  const visible = sql`(${sql.join(hiddenChecks, sql` and `)})`

  const membership: SQL[] = [
    sql`exists (select 1 from ${userSets} join ${setItems} on ${setItems.setId} = ${userSets.setId} where ${userSets.userId} = ${u} and ${userSets.active} and ${setItems.workId} = ${works.id})`,
    ...activeSmart.map((s) => compileFilter(storedFilter(s.filter), u)),
    sql`exists (select 1 from ${userWorks} where ${userWorks.userId} = ${u} and ${userWorks.workId} = ${works.id} and (${userWorks.status} <> 'none' or ${userWorks.rating} is not null))`,
    sql`exists (select 1 from ${queueEntries} where ${queueEntries.userId} = ${u} and ${queueEntries.workId} = ${works.id})`,
    sql`exists (select 1 from ${readingSessions} where ${readingSessions.userId} = ${u} and ${readingSessions.workId} = ${works.id})`,
  ]
  const inLibrary = sql`(${visible} and (${sql.join(membership, sql` or `)}))`

  return { userId: u, role: user.role, languages: me?.languages ?? ['en', 'he'], visible, inLibrary } as unknown as UserScope
}

/** Which of these works this scope may see at all — for filtering a catalog-wide result (e.g. match candidates) down to one viewer's visibility. */
export async function visibleWorkIds(db: Db, scope: UserScope, workIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (workIds.length === 0) return new Set()
  const rows = await db
    .select({ id: works.id })
    .from(works)
    .where(and(inArray(works.id, [...new Set(workIds)]), scope.visible))
  return new Set(rows.map((r) => r.id))
}

export async function assertVisibleWork(db: Db, scope: UserScope, workId: string): Promise<void> {
  const [row] = await db
    .select({ id: works.id })
    .from(works)
    .where(and(eq(works.id, workId), scope.visible))
    .limit(1)
  if (!row) throw notFound('Book')
}

export function requireAdmin(scope: Pick<UserScope, 'role'>): void {
  if (scope.role !== 'admin') throw new DomainError('FORBIDDEN', 'Admins only')
}
