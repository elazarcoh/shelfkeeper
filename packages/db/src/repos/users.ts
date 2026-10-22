import { asc, count, eq, sql } from 'drizzle-orm'
import { DomainError, normalizeTitleLanguages, notFound, type UserPatch, type UserRole } from '@mylib/domain'
import type { Db } from '../client'
import { sets, userSets, users } from '../schema'

export interface UserRecord {
  id: string
  username: string
  displayName: string
  role: UserRole
  shareActivity: boolean
  titleLanguages: string[]
  hasPin: boolean
  createdAt: Date
}

export interface NewUser {
  username: string
  displayName: string
  passwordHash: string
  role: UserRole
}

export const userColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  role: users.role,
  shareActivity: users.shareActivity,
  titleLanguages: users.titleLanguages,
  hasPin: sql<boolean>`${users.pinHash} is not null`,
  createdAt: users.createdAt,
}

const FIRST_ADMIN_LOCK = sql`select pg_advisory_xact_lock(7426001)`
const ADMIN_ROLE_LOCK = sql`select pg_advisory_xact_lock(7426002)`

const normalizeUsername = (username: string) => username.trim().toLowerCase()

export async function createUser(db: Db, input: NewUser): Promise<UserRecord> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        username: normalizeUsername(input.username),
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        role: input.role,
      })
      .onConflictDoNothing({ target: users.username })
      .returning(userColumns)
    if (!user) throw new DomainError('CONFLICT', 'That username is already taken')

    const [myBooks] = await tx
      .insert(sets)
      .values({ name: 'My books', scope: 'personal', kind: 'manual', ownerUserId: user.id, isDefaultPersonal: true })
      .returning({ id: sets.id })
    if (!myBooks) throw new Error('Failed to create the default personal set')

    const defaults = await tx.select({ id: sets.id }).from(sets).where(eq(sets.defaultForNewUsers, true))
    await tx.insert(userSets).values([
      { userId: user.id, setId: myBooks.id, active: true, assignedByAdmin: false },
      ...defaults.map((d) => ({ userId: user.id, setId: d.id, active: true, assignedByAdmin: true })),
    ])
    return user
  })
}

/** First-run setup. Serialized with an advisory lock so two racing setups create one admin. */
export async function createFirstAdmin(db: Db, input: Omit<NewUser, 'role'>): Promise<UserRecord | null> {
  return db.transaction(async (tx) => {
    await tx.execute(FIRST_ADMIN_LOCK)
    if ((await countUsers(tx)) > 0) return null
    return createUser(tx, { ...input, role: 'admin' })
  })
}

export async function countUsers(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users)
  return row?.n ?? 0
}

export async function getUser(db: Db, id: string): Promise<UserRecord | null> {
  const [row] = await db.select(userColumns).from(users).where(eq(users.id, id))
  return row ?? null
}

export async function listUsers(db: Db): Promise<UserRecord[]> {
  return db.select(userColumns).from(users).orderBy(asc(users.createdAt))
}

export async function findUserForLogin(
  db: Db,
  username: string,
): Promise<{ user: UserRecord; passwordHash: string; pinHash: string | null } | null> {
  const [row] = await db
    .select({ ...userColumns, passwordHash: users.passwordHash, pinHash: users.pinHash })
    .from(users)
    .where(eq(users.username, normalizeUsername(username)))
  if (!row) return null
  const { passwordHash, pinHash, ...user } = row
  return { user, passwordHash, pinHash }
}

export async function updateUser(db: Db, id: string, patch: UserPatch): Promise<UserRecord> {
  return db.transaction(async (tx) => {
    if (patch.role === 'member') {
      await tx.execute(ADMIN_ROLE_LOCK)
      const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin'))
      if (admins.length === 1 && admins[0]?.id === id) {
        throw new DomainError('CONFLICT', 'The household needs at least one admin')
      }
    }
    const [row] = await tx.update(users).set(patch.titleLanguages ? { ...patch, titleLanguages: normalizeTitleLanguages(patch.titleLanguages) } : patch)
      .where(eq(users.id, id)).returning(userColumns)
    if (!row) throw notFound('User')
    return row
  })
}

export async function setPasswordHash(db: Db, id: string, passwordHash: string): Promise<void> {
  const rows = await db.update(users).set({ passwordHash }).where(eq(users.id, id)).returning({ id: users.id })
  if (rows.length === 0) throw notFound('User')
}

export async function setPinHash(db: Db, id: string, pinHash: string | null): Promise<void> {
  const rows = await db.update(users).set({ pinHash }).where(eq(users.id, id)).returning({ id: users.id })
  if (rows.length === 0) throw notFound('User')
}
