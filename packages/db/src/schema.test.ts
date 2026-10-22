import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { backupSettings, dailyStats, editions, goals, jobRuns, loans, proposals, readingProgress, readingSessions, sets, sourceItems, sources, users, works } from './schema'
import { useTestDb } from './testing'

describe('schema', () => {
  const t = useTestDb()

  it('has pg_trgm installed', async () => {
    const rows = await t.db.execute<{ extname: string }>(sql`select extname from pg_extension`)
    expect(rows.map((r) => r.extname)).toContain('pg_trgm')
  })

  it('stores works with an empty provenance by default', async () => {
    const [row] = await t.db.insert(works).values({ title: 'Dune', sortTitle: 'dune' }).returning()
    expect(row?.provenance).toEqual({})
  })

  it('rejects personal sets without an owner and global sets with one', async () => {
    await expect(t.db.insert(sets).values({ name: 'x', scope: 'personal', kind: 'manual' }).execute()).rejects.toThrow()
    const [u] = await t.db.insert(users).values({ username: 'a', displayName: 'A', passwordHash: 'x' }).returning()
    await expect(
      t.db.insert(sets).values({ name: 'x', scope: 'global', kind: 'manual', ownerUserId: u?.id ?? null }).execute(),
    ).rejects.toThrow()
  })

  it('rejects smart sets without a filter', async () => {
    await expect(t.db.insert(sets).values({ name: 'x', scope: 'global', kind: 'smart' }).execute()).rejects.toThrow()
  })

  it('rejects a reading session with an out-of-range fraction completed', async () => {
    const [u] = await t.db.insert(users).values({ username: 'b', displayName: 'B', passwordHash: 'x' }).returning()
    const [w] = await t.db.insert(works).values({ title: 'Dune', sortTitle: 'dune' }).returning()
    await expect(
      t.db
        .insert(readingSessions)
        .values({
          userId: u?.id ?? '',
          workId: w?.id ?? '',
          mode: 'read',
          startedOn: '2026-01-01',
          outcome: 'finished',
          finishedOn: '2026-01-02',
          fractionCompleted: 1.5,
        })
        .execute(),
    ).rejects.toThrow()
  })

  it('rejects a loan with both or neither borrower fields set', async () => {
    const [u] = await t.db.insert(users).values({ username: 'c', displayName: 'C', passwordHash: 'x' }).returning()
    const [w] = await t.db.insert(works).values({ title: 'Dune', sortTitle: 'dune' }).returning()
    const [e] = await t.db.insert(editions).values({ workId: w?.id ?? '', format: 'physical' }).returning()
    const base = { editionId: e?.id ?? '', lentByUserId: u?.id ?? '', lentOn: '2026-01-01' }
    await expect(t.db.insert(loans).values(base).execute()).rejects.toThrow()
    await expect(
      t.db.insert(loans).values({ ...base, borrowerUserId: u?.id ?? '', borrowerName: 'Dana' }).execute(),
    ).rejects.toThrow()
  })

  it('rejects a goal whose period ends before it starts', async () => {
    const [u] = await t.db.insert(users).values({ username: 'd', displayName: 'D', passwordHash: 'x' }).returning()
    await expect(
      t.db
        .insert(goals)
        .values({ userId: u?.id ?? '', periodStart: '2026-06-01', periodEnd: '2026-01-01', metric: 'books', target: 12 })
        .execute(),
    ).rejects.toThrow()
  })

  it('stores daily stats keyed by user, date and mode', async () => {
    const [u] = await t.db.insert(users).values({ username: 'e', displayName: 'E', passwordHash: 'x' }).returning()
    await t.db.insert(dailyStats).values({ userId: u?.id ?? '', date: '2026-01-01', mode: 'read', words: 500 })
    await expect(
      t.db.insert(dailyStats).values({ userId: u?.id ?? '', date: '2026-01-01', mode: 'read', words: 200 }).execute(),
    ).rejects.toThrow()
  })

  async function seedSource() {
    const [s] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!s) throw new Error('no source')
    return s
  }
  const normalized = { externalId: 'li_1', format: 'audiobook', title: 'X' } as never

  it('keeps one source item per (source, external id)', async () => {
    const s = await seedSource()
    await t.db.insert(sourceItems).values({ sourceId: s.id, externalId: 'li_1', normalized, contentHash: 'h' })
    await expect(
      t.db.insert(sourceItems).values({ sourceId: s.id, externalId: 'li_1', normalized, contentHash: 'h2' }).execute(),
    ).rejects.toThrow()
  })

  it('allows only one pending proposal per source item', async () => {
    const s = await seedSource()
    const [item] = await t.db.insert(sourceItems).values({ sourceId: s.id, externalId: 'li_1', normalized, contentHash: 'h' }).returning()
    const base = { kind: 'source_match' as const, payload: {}, scope: 'catalog' as const, createdBy: 'sync' as const, sourceItemId: item?.id ?? null }
    await t.db.insert(proposals).values({ ...base, status: 'superseded' })
    await t.db.insert(proposals).values(base)
    await expect(t.db.insert(proposals).values(base).execute()).rejects.toThrow()
  })

  it('allows only one running sync per source', async () => {
    const s = await seedSource()
    await t.db.insert(jobRuns).values({ sourceId: s.id, trigger: 'manual', status: 'running' })
    await t.db.insert(jobRuns).values({ sourceId: s.id, trigger: 'manual', status: 'queued' })
    await expect(t.db.insert(jobRuns).values({ sourceId: s.id, trigger: 'schedule', status: 'running' }).execute()).rejects.toThrow()
  })

  it('refuses to delete a user who still has a book borrowed', async () => {
    const [lender] = await t.db.insert(users).values({ username: 'l', displayName: 'L', passwordHash: 'x' }).returning()
    const [borrower] = await t.db.insert(users).values({ username: 'b2', displayName: 'B', passwordHash: 'x' }).returning()
    const [w] = await t.db.insert(works).values({ title: 'Dune', sortTitle: 'dune' }).returning()
    const [e] = await t.db.insert(editions).values({ workId: w?.id ?? '', format: 'physical' }).returning()
    await t.db.insert(loans).values({ editionId: e?.id ?? '', lentByUserId: lender?.id ?? '', borrowerUserId: borrower?.id ?? '', lentOn: '2026-01-01' })
    await expect(t.db.delete(users).where(sql`${users.id} = ${borrower?.id ?? ''}`).execute()).rejects.toThrow()
  })

  it('allows only the row with id 1 in backup_settings', async () => {
    await expect(t.db.insert(backupSettings).values({ id: 2 }).execute()).rejects.toThrow()
    await t.db.insert(backupSettings).values({}).execute()
  })

  it('keeps one progress point per session and day, within range, and drops them with their session', async () => {
    const [u] = await t.db.insert(users).values({ username: 'p', displayName: 'P', passwordHash: 'x' }).returning()
    const [w] = await t.db.insert(works).values({ title: 'Dune', sortTitle: 'dune' }).returning()
    const [s] = await t.db
      .insert(readingSessions)
      .values({ userId: u?.id ?? '', workId: w?.id ?? '', mode: 'read', startedOn: '2026-01-01' })
      .returning()
    const sessionId = s?.id ?? ''
    await t.db.insert(readingProgress).values({ sessionId, occurredOn: '2026-01-02', kind: 'page', value: 10 })
    await expect(t.db.insert(readingProgress).values({ sessionId, occurredOn: '2026-01-02', kind: 'page', value: 20 }).execute()).rejects.toThrow()
    await expect(t.db.insert(readingProgress).values({ sessionId, occurredOn: '2026-01-03', kind: 'page', value: -1 }).execute()).rejects.toThrow()
    await expect(t.db.insert(readingProgress).values({ sessionId, occurredOn: '2026-01-03', kind: 'percent', value: 100.5 }).execute()).rejects.toThrow()
    await t.db.delete(readingSessions).where(sql`${readingSessions.id} = ${sessionId}`)
    expect(await t.db.select().from(readingProgress)).toEqual([])
  })

  it('rejects NaN and infinite progress values (NaN passes ">= 0" in Postgres)', async () => {
    const [u] = await t.db.insert(users).values({ username: 'q', displayName: 'Q', passwordHash: 'x' }).returning()
    const [w] = await t.db.insert(works).values({ title: 'Emma', sortTitle: 'emma' }).returning()
    const [s] = await t.db
      .insert(readingSessions)
      .values({ userId: u?.id ?? '', workId: w?.id ?? '', mode: 'read', startedOn: '2026-01-01' })
      .returning()
    const sessionId = s?.id ?? ''
    for (const [kind, value] of [
      ['page', Number.NaN],
      ['page', Number.POSITIVE_INFINITY],
      ['seconds', Number.NaN],
      ['seconds', Number.POSITIVE_INFINITY],
      ['percent', Number.NaN],
      ['page', Number.NEGATIVE_INFINITY],
    ] as const) {
      await expect(t.db.insert(readingProgress).values({ sessionId, occurredOn: '2026-01-02', kind, value }).execute(), `${kind} ${value}`).rejects.toThrow()
    }
    expect(await t.db.select().from(readingProgress)).toEqual([])
  })
})
