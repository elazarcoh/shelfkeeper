import { and, eq, gt } from 'drizzle-orm'
import type { Db } from '../client'
import { authSessions, users } from '../schema'
import { userColumns, type UserRecord } from './users'

export async function createSession(db: Db, session: { id: string; userId: string; expiresAt: Date }): Promise<void> {
  await db.insert(authSessions).values(session)
}

export async function findSessionUser(db: Db, sessionId: string, now: Date): Promise<UserRecord | null> {
  const [row] = await db
    .select(userColumns)
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.id, sessionId), gt(authSessions.expiresAt, now)))
  return row ?? null
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.id, sessionId))
}

export async function deleteSessionsForUser(db: Db, userId: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.userId, userId))
}
