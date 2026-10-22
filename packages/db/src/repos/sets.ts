import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  DomainError,
  notFound,
  type CreateSetInput,
  type FilterNode,
  type SetKind,
  type SetScope,
  type UpdateSetInput,
} from '@mylib/domain'
import type { Db } from '../client'
import { setItems, sets, userHiddenSets, userHiddenWorks, userSets, works } from '../schema'
import { assertVisibleWork, requireAdmin, type UserScope } from './scope'
import { shownTitleField } from './titles'

export interface SetInfo {
  id: string
  name: string
  scope: SetScope
  kind: SetKind
  filter: FilterNode | null
  ownerUserId: string | null
  isDefaultPersonal: boolean
  defaultForNewUsers: boolean
}

export interface SetSummary extends SetInfo {
  active: boolean
  assignedByAdmin: boolean
}

const setColumns = {
  id: sets.id,
  name: sets.name,
  scope: sets.scope,
  kind: sets.kind,
  filter: sets.filter,
  ownerUserId: sets.ownerUserId,
  isDefaultPersonal: sets.isDefaultPersonal,
  defaultForNewUsers: sets.defaultForNewUsers,
}

const flagColumns = {
  active: sql<boolean>`coalesce(${userSets.active}, false)`,
  assignedByAdmin: sql<boolean>`coalesce(${userSets.assignedByAdmin}, false)`,
}

/** Sets this user can see: global sets not hidden from them, plus their own personal sets. */
export function accessibleSets(userId: string): SQL {
  return sql`((${sets.scope} = 'global' and not exists (select 1 from ${userHiddenSets} where ${userHiddenSets.userId} = ${userId} and ${userHiddenSets.setId} = ${sets.id})) or ${sets.ownerUserId} = ${userId})`
}

function summariesFor(db: Db, userId: string) {
  return db
    .select({ ...setColumns, ...flagColumns })
    .from(sets)
    .leftJoin(userSets, and(eq(userSets.setId, sets.id), eq(userSets.userId, userId)))
}

export async function listMySets(db: Db, scope: UserScope): Promise<SetSummary[]> {
  return summariesFor(db, scope.userId)
    .where(accessibleSets(scope.userId))
    .orderBy(desc(sets.isDefaultPersonal), desc(sets.scope), asc(sets.name))
}

export async function getSetForUser(db: Db, scope: UserScope, setId: string): Promise<SetSummary> {
  const [row] = await summariesFor(db, scope.userId).where(and(eq(sets.id, setId), accessibleSets(scope.userId)))
  if (!row) throw notFound('Set')
  return row
}

/** Which of the user's accessible sets hold which of these works (one row per pair). */
export async function listSetMembership(
  db: Db,
  scope: UserScope,
  workIds: readonly string[],
): Promise<{ setId: string; workId: string }[]> {
  if (workIds.length === 0) return []
  return db
    .select({ setId: setItems.setId, workId: setItems.workId })
    .from(setItems)
    .innerJoin(sets, eq(sets.id, setItems.setId))
    .where(and(inArray(setItems.workId, [...workIds]), accessibleSets(scope.userId)))
}

export async function getDefaultPersonalSetId(db: Db, userId: string): Promise<string> {
  const [row] = await db
    .select({ id: sets.id })
    .from(sets)
    .where(and(eq(sets.ownerUserId, userId), eq(sets.isDefaultPersonal, true)))
  if (!row) throw notFound('Default set')
  return row.id
}

function assertCanEdit(scope: UserScope, set: SetInfo): void {
  const allowed = set.scope === 'global' ? scope.role === 'admin' : set.ownerUserId === scope.userId
  if (!allowed) throw new DomainError('FORBIDDEN', 'You cannot change this set')
}

export async function createSet(db: Db, scope: UserScope, input: CreateSetInput): Promise<SetSummary> {
  if (input.scope === 'global') requireAdmin(scope)
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sets)
      .values({
        name: input.name,
        scope: input.scope,
        kind: input.kind,
        ownerUserId: input.scope === 'personal' ? scope.userId : null,
        filter: input.kind === 'smart' ? input.filter : null,
      })
      .returning({ id: sets.id })
    if (!row) throw new Error('set insert failed')
    if (input.scope === 'personal') await tx.insert(userSets).values({ userId: scope.userId, setId: row.id, active: true })
    return getSetForUser(tx, scope, row.id)
  })
}

export async function updateSet(db: Db, scope: UserScope, setId: string, patch: UpdateSetInput): Promise<SetSummary> {
  const set = await getSetForUser(db, scope, setId)
  assertCanEdit(scope, set)
  if (patch.filter !== undefined && set.kind !== 'smart') throw new DomainError('INVALID', 'Only smart sets have filters')
  if (patch.defaultForNewUsers !== undefined && set.scope !== 'global') {
    throw new DomainError('INVALID', 'Only global sets can be defaults for new users')
  }
  await db
    .update(sets)
    .set({ name: patch.name, filter: patch.filter, defaultForNewUsers: patch.defaultForNewUsers })
    .where(eq(sets.id, setId))
  return getSetForUser(db, scope, setId)
}

export async function deleteSet(db: Db, scope: UserScope, setId: string): Promise<void> {
  const set = await getSetForUser(db, scope, setId)
  assertCanEdit(scope, set)
  if (set.isDefaultPersonal) throw new DomainError('CONFLICT', '"My books" cannot be deleted')
  await db.delete(sets).where(eq(sets.id, setId))
}

async function editableManualSet(db: Db, scope: UserScope, setId: string): Promise<SetSummary> {
  const set = await getSetForUser(db, scope, setId)
  assertCanEdit(scope, set)
  if (set.kind !== 'manual') throw new DomainError('INVALID', 'Smart sets fill themselves from their filter')
  return set
}

export async function addWorkToSet(db: Db, scope: UserScope, setId: string, workId: string): Promise<void> {
  await editableManualSet(db, scope, setId)
  await assertVisibleWork(db, scope, workId)
  await db.insert(setItems).values({ setId, workId }).onConflictDoNothing()
}

export async function removeWorkFromSet(db: Db, scope: UserScope, setId: string, workId: string): Promise<void> {
  await editableManualSet(db, scope, setId)
  await assertVisibleWork(db, scope, workId)
  await db.delete(setItems).where(and(eq(setItems.setId, setId), eq(setItems.workId, workId)))
}

export async function setSetActive(db: Db, scope: UserScope, setId: string, active: boolean): Promise<void> {
  await getSetForUser(db, scope, setId)
  await db
    .insert(userSets)
    .values({ userId: scope.userId, setId, active })
    .onConflictDoUpdate({ target: [userSets.userId, userSets.setId], set: { active } })
}

// ---- admin ---------------------------------------------------------------

async function globalSetOrInvalid(db: Db, setId: string): Promise<void> {
  const [row] = await db.select({ scope: sets.scope }).from(sets).where(eq(sets.id, setId))
  if (!row) throw notFound('Set')
  if (row.scope !== 'global') throw new DomainError('INVALID', 'Only global sets can be assigned or hidden')
}

export async function listGlobalSets(db: Db, admin: UserScope): Promise<SetInfo[]> {
  requireAdmin(admin)
  return db.select(setColumns).from(sets).where(eq(sets.scope, 'global')).orderBy(asc(sets.name))
}

export async function listUserSetAssignments(
  db: Db,
  admin: UserScope,
  userId: string,
): Promise<(SetSummary & { hidden: boolean })[]> {
  requireAdmin(admin)
  return db
    .select({ ...setColumns, ...flagColumns, hidden: sql<boolean>`${userHiddenSets.setId} is not null` })
    .from(sets)
    .leftJoin(userSets, and(eq(userSets.setId, sets.id), eq(userSets.userId, userId)))
    .leftJoin(userHiddenSets, and(eq(userHiddenSets.setId, sets.id), eq(userHiddenSets.userId, userId)))
    .where(eq(sets.scope, 'global'))
    .orderBy(asc(sets.name))
}

export async function assignSetToUser(
  db: Db,
  admin: UserScope,
  userId: string,
  setId: string,
  assigned: boolean,
): Promise<void> {
  requireAdmin(admin)
  await globalSetOrInvalid(db, setId)
  await db
    .insert(userSets)
    .values({ userId, setId, assignedByAdmin: assigned, active: assigned })
    .onConflictDoUpdate({
      target: [userSets.userId, userSets.setId],
      // Unassigning turns off only what the admin turned on; a set the user activated themselves stays active.
      set: {
        assignedByAdmin: assigned,
        active: assigned ? true : sql`case when ${userSets.assignedByAdmin} then false else ${userSets.active} end`,
      },
    })
}

export async function hideWorkFromUser(db: Db, admin: UserScope, userId: string, workId: string): Promise<void> {
  requireAdmin(admin)
  await db.insert(userHiddenWorks).values({ userId, workId, hiddenBy: admin.userId }).onConflictDoNothing()
}

export async function unhideWorkFromUser(db: Db, admin: UserScope, userId: string, workId: string): Promise<void> {
  requireAdmin(admin)
  await db.delete(userHiddenWorks).where(and(eq(userHiddenWorks.userId, userId), eq(userHiddenWorks.workId, workId)))
}

export async function hideSetFromUser(db: Db, admin: UserScope, userId: string, setId: string): Promise<void> {
  requireAdmin(admin)
  await globalSetOrInvalid(db, setId)
  await db.insert(userHiddenSets).values({ userId, setId, hiddenBy: admin.userId }).onConflictDoNothing()
}

export async function unhideSetFromUser(db: Db, admin: UserScope, userId: string, setId: string): Promise<void> {
  requireAdmin(admin)
  await db.delete(userHiddenSets).where(and(eq(userHiddenSets.userId, userId), eq(userHiddenSets.setId, setId)))
}

export async function listHiddenForUser(
  db: Db,
  admin: UserScope,
  userId: string,
): Promise<{ works: { id: string; title: string }[]; sets: { id: string; name: string }[] }> {
  requireAdmin(admin)
  const [hiddenWorks, hiddenSets] = await Promise.all([
    db
      .select({ id: works.id, title: shownTitleField(works.id, admin.languages, 'title') })
      .from(userHiddenWorks)
      .innerJoin(works, eq(works.id, userHiddenWorks.workId))
      .where(eq(userHiddenWorks.userId, userId))
      .orderBy(asc(shownTitleField(works.id, admin.languages, 'sort_title')), asc(works.id)),
    db
      .select({ id: sets.id, name: sets.name })
      .from(userHiddenSets)
      .innerJoin(sets, eq(sets.id, userHiddenSets.setId))
      .where(eq(userHiddenSets.userId, userId))
      .orderBy(asc(sets.name)),
  ])
  return { works: hiddenWorks, sets: hiddenSets }
}
