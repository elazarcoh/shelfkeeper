import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { sets, userSets } from '../schema'
import { useTestDb } from '../testing'
import { createSession, deleteSession, findSessionUser } from './sessions'
import {
  countUsers,
  createFirstAdmin,
  createUser,
  findUserForLogin,
  setPinHash,
  updateUser,
} from './users'

const newUser = (username: string, role: 'admin' | 'member' = 'member') => ({
  username,
  displayName: username,
  passwordHash: 'hash',
  role,
})

describe('users repository', () => {
  const t = useTestDb()

  it('creates a user with an active "My books" personal set', async () => {
    const user = await createUser(t.db, newUser('Alice'))
    expect(user.username).toBe('alice')
    expect(user.hasPin).toBe(false)
    const mine = await t.db
      .select({ name: sets.name, active: userSets.active })
      .from(sets)
      .innerJoin(userSets, and(eq(userSets.setId, sets.id), eq(userSets.userId, user.id)))
      .where(eq(sets.isDefaultPersonal, true))
    expect(mine).toEqual([{ name: 'My books', active: true }])
  })

  it('assigns global sets marked as defaults for new users', async () => {
    const [kids] = await t.db
      .insert(sets)
      .values({ name: 'Kids shelf', scope: 'global', kind: 'manual', defaultForNewUsers: true })
      .returning()
    const user = await createUser(t.db, newUser('bob'))
    const [row] = await t.db
      .select()
      .from(userSets)
      .where(and(eq(userSets.userId, user.id), eq(userSets.setId, kids?.id ?? '')))
    expect(row).toMatchObject({ active: true, assignedByAdmin: true })
  })

  it('rejects duplicate usernames case-insensitively', async () => {
    await createUser(t.db, newUser('carol'))
    await expect(createUser(t.db, newUser('CAROL'))).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('creates exactly one first admin when two setups race', async () => {
    const results = await Promise.all([
      createFirstAdmin(t.db, { username: 'one', displayName: 'One', passwordHash: 'h' }),
      createFirstAdmin(t.db, { username: 'two', displayName: 'Two', passwordHash: 'h' }),
    ])
    expect(results.filter((r) => r !== null)).toHaveLength(1)
    expect(results.find((r) => r !== null)?.role).toBe('admin')
    expect(await countUsers(t.db)).toBe(1)
  })

  it('refuses to demote the last admin', async () => {
    const admin = await createUser(t.db, newUser('admin', 'admin'))
    await expect(updateUser(t.db, admin.id, { role: 'member' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const second = await createUser(t.db, newUser('admin2', 'admin'))
    await expect(updateUser(t.db, admin.id, { role: 'member' })).resolves.toMatchObject({ role: 'member' })
    await expect(updateUser(t.db, second.id, { role: 'member' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('returns login secrets and reports PIN presence', async () => {
    const user = await createUser(t.db, newUser('dave'))
    await setPinHash(t.db, user.id, 'pinhash')
    const found = await findUserForLogin(t.db, ' Dave ')
    expect(found?.passwordHash).toBe('hash')
    expect(found?.pinHash).toBe('pinhash')
    expect(found?.user.hasPin).toBe(true)
    expect(await findUserForLogin(t.db, 'nobody')).toBeNull()
  })
})

describe('sessions repository', () => {
  const t = useTestDb()

  it('finds the user for a live session and ignores expired or deleted ones', async () => {
    const user = await createUser(t.db, newUser('erin'))
    const now = new Date('2026-06-01T12:00:00Z')
    await createSession(t.db, { id: 'live', userId: user.id, expiresAt: new Date('2026-06-02T00:00:00Z') })
    await createSession(t.db, { id: 'old', userId: user.id, expiresAt: new Date('2026-05-01T00:00:00Z') })
    expect((await findSessionUser(t.db, 'live', now))?.id).toBe(user.id)
    expect(await findSessionUser(t.db, 'old', now)).toBeNull()
    await deleteSession(t.db, 'live')
    expect(await findSessionUser(t.db, 'live', now)).toBeNull()
  })

  it('stores the title languages and returns them on the record', async () => {
    const user = await createUser(t.db, newUser('Dana'))
    expect(user.titleLanguages).toEqual(['en', 'he'])
    const updated = await updateUser(t.db, user.id, { titleLanguages: ['he', 'en'] })
    expect(updated.titleLanguages).toEqual(['he', 'en'])
    expect((await findUserForLogin(t.db, 'dana'))?.user.titleLanguages).toEqual(['he', 'en'])
  })
})
