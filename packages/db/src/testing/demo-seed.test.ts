import { and, count, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { LibraryQuery } from '@mylib/domain'
import { getWorkDetail } from '../repos/catalog'
import { listWorks } from '../repos/library'
import { loadUserScope } from '../repos/scope'
import { listGoals } from '../repos/goals'
import { listActivity } from '../repos/activity'
import { createUser, findUserForLogin, listUsers } from '../repos/users'
import { dailyStats, readingProgress, readingSessions, users, workSearch, works } from '../schema'
import { createSecretBox, DEV_SECRET_KEY } from '../secrets'
import { DEMO_HIDDEN_FROM_TEEN, DEMO_HISTORY, DEMO_MEMBERS, DEMO_WORKS } from './demo-data'
import { DemoAlreadySeededError, demoTargetRefusal, seedDemo } from './demo-seed'
import { useTestDb } from './test-db'

const t = useTestDb()
const options = { hashSecret: (s: string) => Promise.resolve(`test-hash:${s}`), secretBox: createSecretBox(DEV_SECRET_KEY), today: '2026-10-05' }

async function rows(table: typeof works | typeof readingSessions | typeof workSearch | typeof users | typeof readingProgress): Promise<number> {
  const [row] = await t.db.select({ n: count() }).from(table)
  return row?.n ?? 0
}

describe('seedDemo', () => {
  it('fills the household, once, and keeps the hidden book hidden', async () => {
    const admin = await createUser(t.db, { username: 'owner', displayName: 'Owner', passwordHash: 'original-hash', role: 'admin' })

    const summary = await seedDemo(t.db, options)

    const sessions = Object.values(DEMO_HISTORY).reduce((n, h) => n + h.sessions.length, 0)
    expect(summary.works).toBe(DEMO_WORKS.length + 1) // + the accepted wanted book
    expect(summary.sessions).toBe(sessions)
    const progressPoints = Object.values(DEMO_HISTORY).reduce((n, h) => n + h.sessions.reduce((m, s) => m + (s.progress?.length ?? 0), 0), 0)
    expect(progressPoints).toBeGreaterThanOrEqual(10)
    expect(summary.progressPoints).toBe(progressPoints)
    expect(await rows(readingProgress)).toBe(progressPoints)
    expect(await rows(works)).toBe(DEMO_WORKS.length + 1)
    expect(await rows(workSearch)).toBe(DEMO_WORKS.length + 1)
    expect(await rows(readingSessions)).toBe(sessions)
    expect(await rows(users)).toBe(1 + DEMO_MEMBERS.length)
    expect(summary.pendingInbox).toBeGreaterThanOrEqual(5)
    expect(summary.csvProposals).toBe(6)
    expect(DEMO_WORKS.length).toBeGreaterThanOrEqual(60)

    // the first admin's login is untouched; the history is theirs
    const owner = await findUserForLogin(t.db, 'owner')
    expect(owner?.passwordHash).toBe('original-hash')
    const scope = await loadUserScope(t.db, admin)
    const library = await listWorks(t.db, scope, LibraryQuery.parse({ limit: 100 }))
    expect(library.total).toBeGreaterThan(40)
    expect(library.items.some((w) => w.rating !== null)).toBe(true)
    const [stats] = await t.db.select({ n: count() }).from(dailyStats).where(eq(dailyStats.userId, admin.id))
    expect(stats?.n ?? 0).toBeGreaterThan(100)
    // the admin's "Small Gods" is at page 182 today, so today (options.today) shows reading
    const [today] = await t.db.select().from(dailyStats).where(and(eq(dailyStats.userId, admin.id), eq(dailyStats.date, options.today), eq(dailyStats.mode, 'read')))
    expect(today?.words ?? 0).toBeGreaterThan(0)
    const goals = await listGoals(t.db, scope)
    expect(goals.some((g) => g.total > 0)).toBe(true)
    expect((await listActivity(t.db, scope)).length).toBeGreaterThan(10)

    // the hidden book stays hidden from the teen, and only from them
    const teenRecord = (await listUsers(t.db)).find((u) => u.username === DEMO_MEMBERS.find((m) => m.who === 'teen')?.username)
    if (!teenRecord) throw new Error('no teen')
    const teen = await loadUserScope(t.db, teenRecord)
    const hiddenTitle = DEMO_WORKS.find((w) => w.key === DEMO_HIDDEN_FROM_TEEN)?.title
    const catalog = await listWorks(t.db, teen, LibraryQuery.parse({ scope: 'catalog', limit: 100 }))
    expect(catalog.items.map((w) => w.title)).not.toContain(hiddenTitle)
    const [hidden] = await t.db.select({ id: works.id }).from(works).where(eq(works.title, hiddenTitle ?? ''))
    await expect(getWorkDetail(t.db, teen, hidden?.id ?? '')).rejects.toThrow()
    await expect(getWorkDetail(t.db, scope, hidden?.id ?? '')).resolves.toMatchObject({ title: hiddenTitle })

    // a second run refuses and changes nothing
    await expect(seedDemo(t.db, options)).rejects.toBeInstanceOf(DemoAlreadySeededError)
    expect(await rows(works)).toBe(DEMO_WORKS.length + 1)
    expect(await rows(users)).toBe(1 + DEMO_MEMBERS.length)
  }, 120_000)

  it('needs an admin to attach the history to, and leaves nothing behind when it fails', async () => {
    await expect(seedDemo(t.db, options)).rejects.toThrow(/first admin/)
    expect(await rows(users)).toBe(0)
    expect(await rows(works)).toBe(0)
  })

  it('only targets a local, non-production database', () => {
    expect(demoTargetRefusal('postgres://mylib:mylib@localhost:5433/mylib', 'development')).toBeNull()
    expect(demoTargetRefusal('postgres://mylib:mylib@127.0.0.1:5433/mylib', undefined)).toBeNull()
    expect(demoTargetRefusal('postgres://mylib:mylib@localhost:5433/mylib', 'production')).toMatch(/production/)
    expect(demoTargetRefusal('postgres://mylib:mylib@192.168.1.20:5432/mylib', undefined)).toMatch(/localhost/)
    expect(demoTargetRefusal('postgres://u:p@db.example.com/mylib', undefined)).toMatch(/localhost/)
    expect(demoTargetRefusal('not a url', undefined)).toMatch(/valid/)
  })
})
