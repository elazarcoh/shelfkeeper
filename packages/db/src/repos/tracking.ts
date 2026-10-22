import { and, asc, eq, sql } from 'drizzle-orm'
import { DomainError, type ReadingStatus } from '@mylib/domain'
import type { Db } from '../client'
import { queueEntries, userWorks, works } from '../schema'
import { assertVisibleWork, type UserScope } from './scope'

async function upsertUserWork(
  db: Db,
  scope: UserScope,
  workId: string,
  values: Partial<Pick<typeof userWorks.$inferInsert, 'status' | 'rating' | 'ratedAt' | 'review'>>,
): Promise<void> {
  await assertVisibleWork(db, scope, workId)
  await db
    .insert(userWorks)
    .values({ userId: scope.userId, workId, ...values })
    .onConflictDoUpdate({ target: [userWorks.userId, userWorks.workId], set: { ...values, updatedAt: new Date() } })
}

export async function setStatus(db: Db, scope: UserScope, workId: string, status: ReadingStatus): Promise<void> {
  await upsertUserWork(db, scope, workId, { status })
}

export async function setRating(db: Db, scope: UserScope, workId: string, rating: number | null): Promise<void> {
  await upsertUserWork(db, scope, workId, { rating, ratedAt: rating === null ? null : new Date() })
}

export async function setReview(db: Db, scope: UserScope, workId: string, review: string | null): Promise<void> {
  await upsertUserWork(db, scope, workId, { review })
}

export async function listQueueIds(db: Db, scope: UserScope): Promise<string[]> {
  const rows = await db
    .select({ workId: queueEntries.workId })
    .from(queueEntries)
    .innerJoin(works, eq(works.id, queueEntries.workId))
    .where(and(eq(queueEntries.userId, scope.userId), scope.visible))
    .orderBy(asc(queueEntries.position), asc(queueEntries.addedAt))
  return rows.map((r) => r.workId)
}

export async function addToQueue(db: Db, scope: UserScope, workId: string, where: 'top' | 'bottom'): Promise<void> {
  await db.transaction(async (tx) => {
    await assertVisibleWork(tx, scope, workId)
    await tx.delete(queueEntries).where(and(eq(queueEntries.userId, scope.userId), eq(queueEntries.workId, workId)))
    const [edge] = await tx
      .select({
        min: sql<number | null>`min(${queueEntries.position})`,
        max: sql<number | null>`max(${queueEntries.position})`,
      })
      .from(queueEntries)
      .where(eq(queueEntries.userId, scope.userId))
    const position = where === 'top' ? (edge?.min ?? 1) - 1 : (edge?.max ?? 0) + 1
    await tx.insert(queueEntries).values({ userId: scope.userId, workId, position })
  })
}

export async function removeFromQueue(db: Db, scope: UserScope, workId: string): Promise<void> {
  await assertVisibleWork(db, scope, workId)
  await db.delete(queueEntries).where(and(eq(queueEntries.userId, scope.userId), eq(queueEntries.workId, workId)))
}

/** #85 Undo of a start: puts the book back at the Up next position it had (moved there if it is already in Up next). */
export async function restoreToQueue(db: Db, scope: UserScope, workId: string, position: number): Promise<void> {
  await db.transaction(async (tx) => {
    await assertVisibleWork(tx, scope, workId)
    await tx.delete(queueEntries).where(and(eq(queueEntries.userId, scope.userId), eq(queueEntries.workId, workId)))
    await tx.insert(queueEntries).values({ userId: scope.userId, workId, position })
  })
}

export async function reorderQueue(db: Db, scope: UserScope, workIds: readonly string[]): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await listQueueIds(tx, scope)
    const isPermutation =
      current.length === workIds.length &&
      new Set(workIds).size === workIds.length &&
      workIds.every((id) => current.includes(id))
    if (!isPermutation) throw new DomainError('CONFLICT', 'Up next changed — refresh and try again')
    for (const [index, workId] of workIds.entries()) {
      await tx
        .update(queueEntries)
        .set({ position: index + 1 })
        .where(and(eq(queueEntries.userId, scope.userId), eq(queueEntries.workId, workId)))
    }
  })
}
