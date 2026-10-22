import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { createScratchDatabase, migrationsFolderWith, tempDir } from '../testing'
import { applyMigrations, defaultMigrationsFolder, lastAppliedMigration, MigrationFailedError, migrationStatus, readJournal } from './migrations'

const journal = readJournal(defaultMigrationsFolder)

describe('migrations', () => {
  it('applies every migration to an empty database, recorded the way drizzle records them', async () => {
    const s = await createScratchDatabase('empty')
    try {
      expect(await applyMigrations(s.url, defaultMigrationsFolder)).toEqual(journal.map((e) => e.tag))
      expect(await migrationStatus(s.url, defaultMigrationsFolder)).toMatchObject({ pending: [], unknown: [], last: journal.at(-1) })
      expect(await applyMigrations(s.url, defaultMigrationsFolder)).toEqual([])
      const rows = await s.db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
      expect(rows[0]?.n).toBe(journal.length)
      expect(await lastAppliedMigration(s.url, defaultMigrationsFolder)).toEqual(journal.at(-1))
    } finally {
      await s.drop()
    }
  })

  it('builds an older schema with upTo, then applies only what is pending', async () => {
    const s = await createScratchDatabase('empty')
    try {
      const upTo = '0004_work_search_title_trgm'
      const cut = journal.findIndex((e) => e.tag === upTo)
      expect(await applyMigrations(s.url, defaultMigrationsFolder, { upTo })).toEqual(journal.slice(0, cut + 1).map((e) => e.tag))
      const status = await migrationStatus(s.url, defaultMigrationsFolder)
      expect(status.pending.map((e) => e.tag)).toEqual(journal.slice(cut + 1).map((e) => e.tag))
      expect(await applyMigrations(s.url, defaultMigrationsFolder)).toEqual(journal.slice(cut + 1).map((e) => e.tag))
    } finally {
      await s.drop()
    }
  })

  it('reports migrations this image does not know (a newer database)', async () => {
    const s = await createScratchDatabase()
    try {
      await s.db.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-the-future', 9999999999999)`)
      expect((await migrationStatus(s.url, defaultMigrationsFolder)).unknown).toEqual([9_999_999_999_999])
    } finally {
      await s.drop()
    }
  })

  it('rolls back only the failing migration and names it', async () => {
    const folder = migrationsFolderWith([
      { tag: '9998_fine', sql: 'CREATE TABLE "fine_table" ("id" integer);' },
      { tag: '9999_broken', sql: 'CREATE TABLE "half_done" ("id" integer);--> statement-breakpoint\nSELECT 1/0;' },
    ])
    const s = await createScratchDatabase()
    try {
      const failure = await applyMigrations(s.url, folder).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(MigrationFailedError)
      expect(failure).toMatchObject({ tag: '9999_broken' })
      const [row] = await s.db.execute<{ fine: string | null; half: string | null }>(sql`select to_regclass('public.fine_table')::text as fine, to_regclass('public.half_done')::text as half`)
      expect(row).toEqual({ fine: 'fine_table', half: null })
      expect((await migrationStatus(s.url, folder)).last?.tag).toBe('9998_fine')
    } finally {
      await s.drop()
    }
  })

  it('runs beforeEach before every pending migration, and applies none once it throws (3d item 4)', async () => {
    const folder = migrationsFolderWith([
      { tag: '9998_first', sql: 'CREATE TABLE "first_table" ("id" integer);' },
      { tag: '9999_second', sql: 'CREATE TABLE "second_table" ("id" integer);' },
    ])
    const s = await createScratchDatabase()
    try {
      const calls = { count: 0 }
      const beforeEach = () => (++calls.count === 2 ? Promise.reject(new Error('the lock is gone')) : Promise.resolve())
      await expect(applyMigrations(s.url, folder, { beforeEach })).rejects.toThrow('the lock is gone')
      expect(calls.count).toBe(2)
      expect((await migrationStatus(s.url, folder)).pending.map((e) => e.tag)).toEqual(['9999_second'])
    } finally {
      await s.drop()
    }
  })

  // Ruling R20: the Pi's real database was migrated by drizzle's own migrator (this is 3b's code, and
  // the upgrade path for every already-running install), never by applyMigrations. A database it left
  // behind must look, to this migrator, exactly like one applyMigrations built from scratch: nothing
  // pending, nothing unknown, and the same (hash, created_at) bookkeeping rows.
  it("is compatible with drizzle's own migrator: a database it migrated looks identical to one this migrator built", async () => {
    const legacy = await createScratchDatabase('empty')
    const fresh = await createScratchDatabase('empty')
    try {
      const legacyClient = postgres(legacy.url, { max: 1, onnotice: () => undefined })
      try {
        await migrate(drizzle(legacyClient), { migrationsFolder: defaultMigrationsFolder })
      } finally {
        await legacyClient.end()
      }

      expect(await applyMigrations(legacy.url, defaultMigrationsFolder)).toEqual([])
      const legacyStatus = await migrationStatus(legacy.url, defaultMigrationsFolder)
      expect(legacyStatus.pending).toEqual([])
      expect(legacyStatus.unknown).toEqual([])

      await applyMigrations(fresh.url, defaultMigrationsFolder)

      const bookkeepingRows = (s: typeof legacy) =>
        s.db.execute<{ hash: string; created_at: string }>(sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at`)
      expect(await bookkeepingRows(legacy)).toEqual(await bookkeepingRows(fresh))
    } finally {
      await legacy.drop()
      await fresh.drop()
    }
  })

  it('rejects an unknown upTo tag before opening a database connection', async () => {
    await expect(applyMigrations('postgres://unused/db', defaultMigrationsFolder, { upTo: 'nope' })).rejects.toThrow('Unknown migration nope')
  })

  it('readJournal rejects a malformed journal with a clear error naming the file', () => {
    const dir = tempDir('bad-journal')
    mkdirSync(path.join(dir, 'meta'), { recursive: true })
    const journalPath = path.join(dir, 'meta', '_journal.json')
    writeFileSync(journalPath, JSON.stringify({ version: '7', dialect: 'postgresql', entries: [{ idx: 0, version: '7', tag: '0000_x' }] }))
    expect(() => readJournal(dir)).toThrow(`Malformed migration journal at ${journalPath}`)
  })
})
