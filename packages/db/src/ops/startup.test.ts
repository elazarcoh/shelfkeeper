import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { describe, expect, it, vi } from 'vitest'
import { DEV_SECRET_KEY } from '../secrets'
import {
  allowConnections,
  createScratchDatabase,
  migrationsFolderWith,
  setDatabaseSetting,
  simulateInterruptedSwap,
  tempDir,
  terminateBackendsRunning,
  TEST_MIGRATIONS_FOLDER,
  testOpsEnv,
  testPgTools,
  waitFor,
} from '../testing'
import { readBackupManifest } from './backup-file'
import { listBackups } from './backups'
import { OpsLockLostError } from './database-admin'
import { exists } from './fs-utils'
import { applyMigrations, migrationStatus, readJournal } from './migrations'
import {
  checkStartup,
  devDataPath,
  devPgToolsOptions,
  ensureDevBackupDir,
  freeBytes,
  hostPathsOverlap,
  MAX_STALLED_ATTEMPTS,
  newUpgradeMemo,
  prepareDatabase,
  VOLUME_MARKER,
  writableDirProblem,
  type StartupCheckInput,
} from './startup'

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

function good(): StartupCheckInput {
  return {
    backupDir: tempDir('backups'),
    assetsDir: tempDir('assets'),
    appSecretKey: DEV_SECRET_KEY,
    hostDataDir: '/Media/komodo/stacks/my-library/data',
    hostBackupDir: '/Media/Backup/my-library',
    protectedPaths: ['/Media/Media', '/Media/Downloads'],
    requireVolumeMarkers: false,
  }
}

describe('checkStartup (spec §3)', () => {
  it('passes a correct configuration', async () => {
    expect(await checkStartup(good())).toEqual([])
  })

  it('refuses a missing or malformed APP_SECRET_KEY', async () => {
    expect(await checkStartup({ ...good(), appSecretKey: '' })).toEqual([expect.stringContaining('APP_SECRET_KEY')])
    expect(await checkStartup({ ...good(), appSecretKey: 'c2hvcnQ=' })).toEqual([expect.stringContaining('APP_SECRET_KEY')])
  })

  it('refuses a missing BACKUP_DIR', async () => {
    expect(await checkStartup({ ...good(), backupDir: path.join(tempDir('x'), 'missing') })).toEqual(['BACKUP_DIR does not exist'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a BACKUP_DIR the app cannot write', async () => {
    const input = good()
    chmodSync(input.backupDir, 0o555)
    try {
      expect(await checkStartup(input)).toEqual(['BACKUP_DIR is not writable by the app'])
    } finally {
      chmodSync(input.backupDir, 0o755)
    }
  })

  it('refuses a BACKUP_DIR that is a file, not a folder (portable: no chmod needed)', async () => {
    const filePath = path.join(tempDir('notadir'), 'this-is-a-file')
    writeFileSync(filePath, '')
    expect(await checkStartup({ ...good(), backupDir: filePath })).toEqual(['BACKUP_DIR is not a folder'])
  })

  it('fix round 1: writableDirProblem reports "not writable" from an injected probe, on every platform', async () => {
    const dir = tempDir('probe-write-fails')
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const result = await writableDirProblem(dir, { write: () => Promise.reject(eacces), unlink: () => Promise.resolve() })
    expect(result).toBe('is not writable by the app')
  })

  it('fix round 1: reports clearly when the write-test file cannot be removed, and listBackups ignores the leftover', async () => {
    const dir = tempDir('probe-unlink-fails')
    const realWrite = (p: string) => writeFileSync(p, '')
    const result = await writableDirProblem(dir, {
      write: (p) => Promise.resolve(realWrite(p)),
      unlink: () => Promise.reject(new Error('permission denied')),
    })
    expect(result).toMatch(/could not remove it afterwards \(permission denied\)/)
    const leftovers = readdirSync(dir).filter((name) => name.startsWith('.write-test-'))
    expect(leftovers).toHaveLength(1)
    expect(await listBackups(dir)).toEqual([])
  })

  it('refuses a backup folder inside the data folder, or the other way round, by real path', async () => {
    const input = good()
    const inside = path.join(input.assetsDir, 'backups')
    mkdirSync(inside)
    expect(await checkStartup({ ...input, backupDir: inside })).toEqual([expect.stringContaining('overlap')])
    const around = tempDir('around')
    const assetsInside = path.join(around, 'assets')
    mkdirSync(assetsInside)
    expect(await checkStartup({ ...input, backupDir: around, assetsDir: assetsInside })).toEqual([expect.stringContaining('overlap')])
  })

  it('refuses host paths that overlap the protected media folders or each other', async () => {
    expect(await checkStartup({ ...good(), hostBackupDir: '/Media/Media/Audiobooks/backups' })).toEqual(['BACKUP_DIR overlaps the protected path /Media/Media.'])
    expect(await checkStartup({ ...good(), hostDataDir: '/Media/Downloads/' })).toEqual(['DATA_DIR overlaps the protected path /Media/Downloads.'])
    expect(await checkStartup({ ...good(), hostBackupDir: '/Media/komodo/stacks/my-library/data/backups' })).toEqual(['BACKUP_DIR and DATA_DIR overlap on the host.'])
    expect(await checkStartup({ ...good(), hostDataDir: '/Media' })).toEqual([
      'BACKUP_DIR and DATA_DIR overlap on the host.',
      'DATA_DIR overlaps the protected path /Media/Media.',
      'DATA_DIR overlaps the protected path /Media/Downloads.',
    ])
    expect(hostPathsOverlap('/Media/MediaBackup', '/Media/Media')).toBe(false)
    expect(hostPathsOverlap('./data', '/Media/Media')).toBe(false)
  })

  it('fix round 1: is silent about a non-absolute host path outside production', async () => {
    const input = { ...good(), hostBackupDir: 'backups', hostDataDir: 'data', protectedPaths: ['Media/Media'] }
    expect(await checkStartup(input)).toEqual([])
    expect(await checkStartup({ ...input, nodeEnv: 'development' })).toEqual([])
  })

  it('fix round 1: refuses a non-absolute HOST_BACKUP_DIR, HOST_DATA_DIR or PROTECTED_PATHS entry in production', async () => {
    const input = { ...good(), nodeEnv: 'production', hostBackupDir: 'backups', hostDataDir: 'data', protectedPaths: ['Media/Media'] }
    expect(await checkStartup(input)).toEqual(['BACKUP_DIR must be an absolute path.', 'DATA_DIR must be an absolute path.', 'PROTECTED_PATHS entry "Media/Media" must be an absolute path.'])
  })

  it('refuses to start when a volume marker is missing', async () => {
    const input = { ...good(), requireVolumeMarkers: true }
    expect(await checkStartup(input)).toHaveLength(2)
    writeFileSync(path.join(input.assetsDir, VOLUME_MARKER), '')
    writeFileSync(path.join(input.backupDir, VOLUME_MARKER), '')
    expect(await checkStartup(input)).toEqual([])
  })

  it('reports free space on a folder', async () => {
    expect(await freeBytes(tempDir('free'))).toBeGreaterThan(0)
    expect(await freeBytes(path.join(tempDir('free'), 'missing'))).toBeNull()
  })
})

describe('dev-mode ops defaults (Ruling R5, T9/T10, F6): pnpm dev must not get stuck in maintenance', () => {
  it('creates the default BACKUP_DIR outside production, but never touches it in production', async () => {
    const root = tempDir('devroot')
    const dir = path.join(root, 'data', 'backups')
    await ensureDevBackupDir(undefined, dir)
    expect(await exists(dir)).toBe(true)
    await rm(dir, { recursive: true, force: true })
    await ensureDevBackupDir('production', dir)
    expect(await exists(dir)).toBe(false)
  })

  it('leaves an existing BACKUP_DIR alone', async () => {
    const dir = tempDir('devroot2')
    await ensureDevBackupDir(undefined, dir)
    expect(await exists(dir)).toBe(true)
  })

  it('fix round 1: keeps a file already inside an existing BACKUP_DIR', async () => {
    const dir = tempDir('devroot3')
    writeFileSync(path.join(dir, 'keep-me.txt'), 'hello')
    await ensureDevBackupDir(undefined, dir)
    expect(readFileSync(path.join(dir, 'keep-me.txt'), 'utf8')).toBe('hello')
  })

  it('resolves a relative data dir against the workspace root outside production, so the server and the worker share it', () => {
    const root = tempDir('workspace')
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    const server = path.join(root, 'apps', 'server')
    const worker = path.join(root, 'apps', 'worker')
    mkdirSync(server, { recursive: true })
    mkdirSync(worker, { recursive: true })
    const expected = path.join(root, 'data', 'backups')
    expect(devDataPath(undefined, './data/backups', server)).toBe(expected)
    expect(devDataPath('development', './data/backups', worker)).toBe(expected)
    expect(devDataPath('production', './data/backups', server)).toBe('./data/backups')
    const absolute = path.join(root, 'elsewhere')
    expect(devDataPath(undefined, absolute, server)).toBe(absolute)
  })

  it('splits PG_TOOLS_PREFIX on whitespace for createPgTools, but only outside production', () => {
    expect(devPgToolsOptions(undefined, 'docker exec -i  mylib-dev-db-1').prefix).toEqual(['docker', 'exec', '-i', 'mylib-dev-db-1'])
    // unset outside production: the dev compose container (the server AND the worker run pg_dump)
    const dev = devPgToolsOptions('development', undefined)
    expect(dev.prefix).toEqual(['docker', 'exec', '-i', '-e', 'PGPASSWORD', 'mylib-dev-db-1'])
    // inside the container the server is its own localhost:5432, not the host's published 5433
    expect(dev.rewriteUrl?.('postgres://mylib:mylib@localhost:5433/mylib')).toBe('postgres://mylib:mylib@localhost:5432/mylib')
    expect(devPgToolsOptions(undefined, '')).toEqual({})
    expect(devPgToolsOptions('production', 'docker exec -i mylib-dev-db-1')).toEqual({})
  })
})

describe('prepareDatabase (spec §5)', () => {
  const journal = readJournal(TEST_MIGRATIONS_FOLDER)

  it('migrates an empty database without a backup (a first install)', async () => {
    const s = await createScratchDatabase('empty')
    try {
      const env = testOpsEnv(s.url)
      expect(await prepareDatabase(env)).toEqual({ kind: 'ready', applied: journal.map((e) => e.tag), preUpgradeBackup: null })
      expect(readdirSync(env.backupDir)).toEqual([])
    } finally {
      await s.drop()
    }
  })

  it('backs up before migrating an older database', async () => {
    const s = await createScratchDatabase('empty')
    try {
      await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER, { upTo: '0006_asset_hash_cover_checked' })
      const env = testOpsEnv(s.url)
      const outcome = await prepareDatabase(env)
      if (outcome.kind !== 'ready') throw new Error(`expected ready, got ${outcome.state.message}`)
      expect(outcome.applied).toEqual(journal.slice(journal.findIndex((e) => e.tag === '0006_asset_hash_cover_checked') + 1).map((e) => e.tag))
      expect(outcome.preUpgradeBackup).toMatch(/-pre-upgrade\.zip$/)
      const manifest = await readBackupManifest(path.join(env.backupDir, outcome.preUpgradeBackup ?? ''))
      expect(manifest.lastMigration.tag).toBe('0006_asset_hash_cover_checked')
    } finally {
      await s.drop()
    }
  })

  it('refuses a database newer than this app', async () => {
    const s = await createScratchDatabase()
    try {
      await s.db.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-the-future', 9999999999999)`)
      const env = testOpsEnv(s.url)
      expect(await prepareDatabase(env)).toMatchObject({ kind: 'maintenance', state: { reason: 'newer-database', backupName: null } })
      expect(readdirSync(env.backupDir)).toEqual([])
    } finally {
      await s.drop()
    }
  })

  it('fix round 1: refuses a database migrated only partway that also has an unknown row, without a backup, leaving migrations untouched', async () => {
    const s = await createScratchDatabase('empty')
    try {
      await applyMigrations(s.url, TEST_MIGRATIONS_FOLDER, { upTo: '0006_asset_hash_cover_checked' })
      await s.db.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-the-future', 9999999999999)`)
      const before = await migrationStatus(s.url, TEST_MIGRATIONS_FOLDER)
      const env = testOpsEnv(s.url)
      expect(await prepareDatabase(env)).toMatchObject({ kind: 'maintenance', state: { reason: 'newer-database', backupName: null } })
      expect(readdirSync(env.backupDir)).toEqual([])
      expect(await migrationStatus(s.url, TEST_MIGRATIONS_FOLDER)).toEqual(before)
    } finally {
      await s.drop()
    }
  })

  it('stops in maintenance, naming the migration and the backup, when a migration fails', async () => {
    const s = await createScratchDatabase()
    try {
      const folder = migrationsFolderWith([{ tag: '9999_broken', sql: 'CREATE TABLE "half_done" ("id" integer);--> statement-breakpoint\nSELECT 1/0;' }])
      const outcome = await prepareDatabase(testOpsEnv(s.url, { migrationsFolder: folder }))
      if (outcome.kind !== 'maintenance') throw new Error('expected maintenance')
      expect(outcome.state.reason).toBe('upgrade-failed')
      expect(outcome.state.message).toContain('9999_broken')
      expect(outcome.state.backupName).toMatch(/-pre-upgrade\.zip$/)
      expect(outcome.state.message).toContain(outcome.state.backupName ?? 'missing')
      expect((await migrationStatus(s.url, folder)).last?.tag).toBe(journal.at(-1)?.tag)
    } finally {
      await s.drop()
    }
  })

  it('fix round 1: also stops in maintenance, naming the backup, when applyMigrations throws something other than MigrationFailedError', async () => {
    const s = await createScratchDatabase()
    try {
      const folder = migrationsFolderWith([{ tag: '9999_ghost', sql: 'CREATE TABLE "ghost" ("id" integer);' }])
      // Deleting the migration's own .sql file makes drizzle's readMigrationFiles throw a plain Error
      // (not MigrationFailedError) from inside applyMigrations, before any transaction is opened.
      rmSync(path.join(folder, '9999_ghost.sql'))
      const outcome = await prepareDatabase(testOpsEnv(s.url, { migrationsFolder: folder }))
      if (outcome.kind !== 'maintenance') throw new Error('expected maintenance')
      expect(outcome.state.reason).toBe('upgrade-failed')
      // 3d item 7 (Task 2 review): names the migration that never started, not "Migration unknown failed"
      expect(outcome.state.message).toContain('Migrating stopped before 9999_ghost started')
      expect(outcome.state.message).not.toContain('unknown')
      expect(outcome.state.backupName).toMatch(/-pre-upgrade\.zip$/)
      expect(outcome.state.message).toContain(outcome.state.backupName ?? 'missing')
      expect((await migrationStatus(s.url, folder)).last?.tag).toBe(journal.at(-1)?.tag)
    } finally {
      await s.drop()
    }
  })

  it('does not migrate when the pre-upgrade backup fails', async () => {
    const s = await createScratchDatabase()
    try {
      const folder = migrationsFolderWith([{ tag: '9999_fine', sql: 'CREATE TABLE "fine_table" ("id" integer);' }])
      const failing = { ...testPgTools(), dump: () => Promise.reject(new Error('disk full')) }
      const outcome = await prepareDatabase(testOpsEnv(s.url, { migrationsFolder: folder, pgTools: failing }))
      expect(outcome).toMatchObject({ kind: 'maintenance', state: { reason: 'backup-failed' } })
      expect((await migrationStatus(s.url, folder)).pending.map((e) => e.tag)).toEqual(['9999_fine'])
    } finally {
      await s.drop()
    }
  })

  it('names the failed migration and the earlier ones of this upgrade that were applied (3d item 7, Task 2 review)', async () => {
    const s = await createScratchDatabase()
    try {
      const folder = migrationsFolderWith([
        { tag: '9998_fine', sql: 'CREATE TABLE "fine_table" ("id" integer);' },
        { tag: '9999_broken', sql: 'SELECT 1/0;' },
      ])
      const outcome = await prepareDatabase(testOpsEnv(s.url, { migrationsFolder: folder }))
      if (outcome.kind !== 'maintenance') throw new Error('expected maintenance')
      expect(outcome.state.message).toContain('Migration 9999_broken failed and was rolled back')
      expect(outcome.state.message).toContain('Earlier migrations of this upgrade were applied: 9998_fine.')
      expect((await migrationStatus(s.url, folder)).pending.map((e) => e.tag)).toEqual(['9999_broken'])
    } finally {
      await s.drop()
    }
  })

  it('a migrate lock lost between two migrations stops before the second one, and is not a verdict: the retry finishes the upgrade (3d items 4 and 7)', async () => {
    const s = await createScratchDatabase()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const key = `mylib:migrate:${s.name}`
      // the first migration drops the connection holding the migrate lock, as a network blip would
      const loseTheLock = `select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted and objsubid = 1 and objid = (hashtext('${key}')::bigint & 4294967295)::oid;`
      const folder = migrationsFolderWith([
        { tag: '9998_lose_the_lock', sql: `CREATE TABLE "first_table" ("id" integer);--> statement-breakpoint\n${loseTheLock}` },
        { tag: '9999_second', sql: 'CREATE TABLE "second_table" ("id" integer);' },
      ])
      const env = testOpsEnv(s.url, { migrationsFolder: folder })
      const upgrade = newUpgradeMemo()
      const lost: unknown = await prepareDatabase(env, { upgrade }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(lost).toMatchObject({ name: 'DatabaseUnreachableError', code: 'OPS_LOCK_LOST' })
      const cause = (lost as Error).cause
      expect(cause).toBeInstanceOf(OpsLockLostError)
      expect((cause as Error).message).toContain('migration lock')
      expect((await migrationStatus(s.url, folder)).pending.map((e) => e.tag)).toEqual(['9999_second'])
      expect(await s.db.execute(sql`select to_regclass('public.second_table') is null as absent`)).toEqual([{ absent: true }])
      // a real loss remembers where it stopped (Task 4 re-review, minor B)
      expect(upgrade.inFlight).toBe('9999_second')

      // the lock died with its session, not with the database: the retry (9998 is already applied) finishes the upgrade with the same backup,
      // and reports every migration this start-up applied, across both attempts (fix round 1, review #4)
      expect(await prepareDatabase(env, { upgrade })).toEqual({ kind: 'ready', applied: ['9998_lose_the_lock', '9999_second'], preUpgradeBackup: upgrade.preUpgradeBackup })
      expect(upgrade.preUpgradeBackup).toMatch(/-pre-upgrade\.zip$/)
      expect(await listBackups(env.backupDir)).toHaveLength(1)
    } finally {
      error.mockRestore()
      await s.drop()
    }
  })

  // fix round 1 (review #5): the DDL runs first, so the kill lands after it inside the open transaction
  const SLOW_MIGRATION = [
    'CREATE TABLE "slow_table" ("id" integer);',
    '--> statement-breakpoint',
    "SELECT pg_sleep(CASE WHEN current_setting('mylib.test_slow', true) = 'on' THEN 60 ELSE 0 END);",
  ].join('\n')

  it('a connection dropped mid-migration is not a verdict: nothing half-applied, and the retry reuses the same pre-upgrade backup (3d item 7)', async () => {
    const s = await createScratchDatabase()
    try {
      const folder = migrationsFolderWith([{ tag: '9999_slow', sql: SLOW_MIGRATION }])
      const env = testOpsEnv(s.url, { migrationsFolder: folder })
      await setDatabaseSetting(s.url, 'mylib.test_slow', 'on')
      const [rowsBefore] = await s.db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
      const upgrade = newUpgradeMemo()
      // the expectation is attached before the kill: the attempt can reject while waitFor is still polling
      // postgres.js reports a session the server ended mid-query as its socket closing, not the 57P01 the server sent
      const first = expect(prepareDatabase(env, { upgrade })).rejects.toMatchObject({ name: 'DatabaseUnreachableError', code: 'CONNECTION_CLOSED' })
      await waitFor(async () => (await terminateBackendsRunning(s.url, 'pg_sleep')) > 0, 'the slow migration to start', undefined, 60_000)
      await first
      // the CREATE TABLE that had already run and the bookkeeping row rolled back together (decision 5)
      const [table] = await s.db.execute<{ present: boolean }>(sql`select to_regclass('public.slow_table') is not null as present`)
      expect(table?.present).toBe(false)
      const [rowsAfter] = await s.db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
      expect(rowsAfter?.n).toBe(rowsBefore?.n)
      expect((await migrationStatus(s.url, folder)).pending.map((e) => e.tag)).toEqual(['9999_slow'])
      expect(upgrade.preUpgradeBackup).toMatch(/-pre-upgrade\.zip$/)

      await setDatabaseSetting(s.url, 'mylib.test_slow', null)
      expect(await prepareDatabase(env, { upgrade })).toEqual({ kind: 'ready', applied: ['9999_slow'], preUpgradeBackup: upgrade.preUpgradeBackup })
      expect((await listBackups(env.backupDir)).map((b) => b.name)).toEqual([upgrade.preUpgradeBackup])
    } finally {
      await s.drop()
    }
  }, 90_000)

  it('keeps one pre-upgrade backup across repeated losses (3d item 7, review focus 2)', async () => {
    const s = await createScratchDatabase()
    try {
      const folder = migrationsFolderWith([{ tag: '9999_slow', sql: SLOW_MIGRATION }])
      const env = testOpsEnv(s.url, { migrationsFolder: folder })
      await setDatabaseSetting(s.url, 'mylib.test_slow', 'on')
      const upgrade = newUpgradeMemo()
      for (let loss = 0; loss < 2; loss++) {
        // attached before the kill, so a rejection during waitFor is never unhandled
        const attempt = expect(prepareDatabase(env, { upgrade })).rejects.toMatchObject({ name: 'DatabaseUnreachableError' })
        await waitFor(async () => (await terminateBackendsRunning(s.url, 'pg_sleep')) > 0, 'the slow migration to start', undefined, 60_000)
        await attempt
      }
      await setDatabaseSetting(s.url, 'mylib.test_slow', null)
      expect(await prepareDatabase(env, { upgrade })).toMatchObject({ kind: 'ready', applied: ['9999_slow'] })
      expect(await listBackups(env.backupDir)).toHaveLength(1)
    } finally {
      await s.drop()
    }
  }, 90_000)

  it('a pre-upgrade backup that fails because the database went away is not a verdict, and nothing is migrated (3d item 7)', async () => {
    const s = await createScratchDatabase()
    try {
      const folder = migrationsFolderWith([{ tag: '9999_fine', sql: 'CREATE TABLE "fine_table" ("id" integer);' }])
      const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      const failing = { ...testPgTools(), dump: () => Promise.reject(refused) }
      await expect(prepareDatabase(testOpsEnv(s.url, { migrationsFolder: folder, pgTools: failing }))).rejects.toMatchObject({ name: 'DatabaseUnreachableError', code: 'ECONNREFUSED' })
      expect((await migrationStatus(s.url, folder)).pending.map((e) => e.tag)).toEqual(['9999_fine'])
    } finally {
      await s.drop()
    }
  })

  it('a connection dropped during the pre-upgrade backup own query is not a hang: the attempt rejects and the retry finishes (3d item 6, Task 4 review finding 1)', async () => {
    const s = await createScratchDatabase()
    const blocker = postgres(s.url, { max: 1, onnotice: () => undefined })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const release = gate()
    // a box, not a `let`: it is set inside a closure
    const lock: { holding: Promise<unknown> | null; guard: ReturnType<typeof setTimeout> | undefined } = { holding: null, guard: undefined }
    try {
      const folder = migrationsFolderWith([{ tag: '9999_fine', sql: 'CREATE TABLE "fine_table" ("id" integer);' }])
      const tools = testPgTools()
      // once pg_dump is done, the backup's own query on the asset table is made to block, so the drop lands mid-query
      const pgTools = {
        ...tools,
        dump: async (...args: Parameters<typeof tools.dump>) => {
          await tools.dump(...args)
          if (lock.holding === null) {
            let locked!: () => void
            const isLocked = new Promise<void>((resolve) => {
              locked = resolve
            })
            lock.holding = blocker.begin(async (tx) => {
              await tx`lock table asset in access exclusive mode`
              locked()
              await release.opened
            })
            await isLocked
          }
        },
      }
      const env = testOpsEnv(s.url, { migrationsFolder: folder, pgTools })
      const upgrade = newUpgradeMemo()
      // settled at once, so a rejection before the race below is never unhandled
      const first = prepareDatabase(env, { upgrade }).then(
        () => 'resolved',
        (e: unknown) => e,
      )
      const blocked = async (): Promise<boolean> => {
        const [row] = await s.db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'active' and wait_event_type = 'Lock' and query ilike '%from "asset"%'`)
        return (row?.n ?? 0) > 0
      }
      await waitFor(blocked, 'the backup query on the asset table to block', undefined, 30_000)
      // the database goes away for real: the running query's connection drops, and new ones are refused
      await simulateInterruptedSwap(s.url)
      expect(await terminateBackendsRunning(s.url, 'from "asset"')).toBe(1)
      release.open()
      const began = Date.now()
      const outcome: unknown = await Promise.race([
        first,
        new Promise((resolve) => {
          lock.guard = setTimeout(() => resolve('still hanging'), 20_000)
        }),
      ])
      expect(outcome).toMatchObject({ name: 'DatabaseUnreachableError', code: 'CONNECTION_CLOSED' })
      // bounded: the backup's close gives up within its time limit instead of waiting forever
      expect(Date.now() - began).toBeLessThan(15_000)
      expect(upgrade.preUpgradeBackup).toBeNull()

      await allowConnections(s.url)
      expect((await migrationStatus(s.url, folder)).pending.map((e) => e.tag)).toEqual(['9999_fine'])

      const second = await prepareDatabase(env, { upgrade })
      expect(second).toMatchObject({ kind: 'ready', applied: ['9999_fine'] })
      expect(await listBackups(env.backupDir)).toHaveLength(1)
    } finally {
      clearTimeout(lock.guard)
      release.open()
      await lock.holding
      await blocker.end({ timeout: 1 })
      await allowConnections(s.url)
      error.mockRestore()
      await s.drop()
    }
  }, 90_000)

  it('a lock check that always fails while the database answers ends in upgrade-failed after MAX_STALLED_ATTEMPTS attempts (fix round 1, review #2)', async () => {
    const s = await createScratchDatabase()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const folder = migrationsFolderWith([{ tag: '9999_never', sql: 'CREATE TABLE "never_table" ("id" integer);' }])
      const env = testOpsEnv(s.url, { migrationsFolder: folder })
      const upgrade = newUpgradeMemo()
      const testOnly = { lockCheck: () => Promise.resolve(false) }
      for (let attempt = 1; attempt < MAX_STALLED_ATTEMPTS; attempt++) {
        await expect(prepareDatabase(env, { upgrade, testOnly })).rejects.toMatchObject({ name: 'DatabaseUnreachableError', code: 'OPS_LOCK_LOST' })
      }
      const outcome = await prepareDatabase(env, { upgrade, testOnly })
      if (outcome.kind !== 'maintenance') throw new Error('expected maintenance')
      expect(outcome.state).toMatchObject({ reason: 'upgrade-failed', backupName: upgrade.preUpgradeBackup })
      expect(outcome.state.message).toContain(`Upgrading kept failing at migration 9999_never: ${MAX_STALLED_ATTEMPTS} attempts in a row`)
      expect(outcome.state.message).toContain('(last: OPS_LOCK_LOST)')
      expect(outcome.state.message).not.toContain('Earlier migrations')
      expect(outcome.state.message).toContain(upgrade.preUpgradeBackup ?? 'missing')
      expect((await migrationStatus(s.url, folder)).pending.map((e) => e.tag)).toEqual(['9999_never'])
      expect(await listBackups(env.backupDir)).toHaveLength(1)
    } finally {
      error.mockRestore()
      warn.mockRestore()
      await s.drop()
    }
  }, 90_000)

  it('progress resets the stall count: only attempts in a row at the same migration count (fix round 1, review #2)', async () => {
    const s = await createScratchDatabase()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const folder = migrationsFolderWith([
        { tag: '9998_a', sql: 'CREATE TABLE "a_table" ("id" integer);' },
        { tag: '9999_b', sql: 'CREATE TABLE "b_table" ("id" integer);' },
      ])
      const env = testOpsEnv(s.url, { migrationsFolder: folder })
      const upgrade = newUpgradeMemo()
      const stuck = { testOnly: { lockCheck: () => Promise.resolve(false) } }
      // one short of the bound at 9998_a…
      for (let attempt = 1; attempt < MAX_STALLED_ATTEMPTS; attempt++) {
        await expect(prepareDatabase(env, { upgrade, ...stuck })).rejects.toMatchObject({ code: 'OPS_LOCK_LOST' })
      }
      // …then an attempt that applies 9998_a and loses the lock before 9999_b: progress, so not a verdict
      const progress = { testOnly: { lockCheck: async () => (await migrationStatus(s.url, folder)).pending[0]?.tag === '9998_a' } }
      await expect(prepareDatabase(env, { upgrade, ...progress })).rejects.toMatchObject({ code: 'OPS_LOCK_LOST' })
      expect(upgrade.stalled).toEqual({ tag: '9999_b', attempts: 1 })
      // the count starts again at 9999_b
      for (let attempt = 2; attempt < MAX_STALLED_ATTEMPTS; attempt++) {
        await expect(prepareDatabase(env, { upgrade, ...stuck })).rejects.toMatchObject({ code: 'OPS_LOCK_LOST' })
      }
      const outcome = await prepareDatabase(env, { upgrade, ...stuck })
      if (outcome.kind !== 'maintenance') throw new Error('expected maintenance')
      expect(outcome.state.message).toContain('Upgrading kept failing at migration 9999_b')
      expect(outcome.state.message).toContain('Earlier migrations of this upgrade were applied: 9998_a.')
    } finally {
      error.mockRestore()
      warn.mockRestore()
      await s.drop()
    }
  }, 90_000)

  it('a backup lock that is always lost during the pre-upgrade backup ends in backup-failed after MAX_STALLED_ATTEMPTS attempts (3d final fix, review #2)', async () => {
    const s = await createScratchDatabase()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const folder = migrationsFolderWith([{ tag: '9999_never', sql: 'CREATE TABLE "never_table" ("id" integer);' }])
      const pgTools = { ...testPgTools(), dump: () => Promise.reject(new OpsLockLostError('backup')) }
      const env = testOpsEnv(s.url, { migrationsFolder: folder, pgTools })
      const upgrade = newUpgradeMemo()
      for (let attempt = 1; attempt < MAX_STALLED_ATTEMPTS; attempt++) {
        await expect(prepareDatabase(env, { upgrade })).rejects.toMatchObject({ name: 'DatabaseUnreachableError', code: 'OPS_LOCK_LOST' })
      }
      const outcome = await prepareDatabase(env, { upgrade })
      if (outcome.kind !== 'maintenance') throw new Error('expected maintenance')
      expect(outcome.state).toMatchObject({ reason: 'backup-failed', backupName: null })
      expect(outcome.state.message).toContain(`The pre-upgrade backup kept failing: ${MAX_STALLED_ATTEMPTS} attempts in a row lost the database or the backup lock`)
      expect(outcome.state.message).toContain('(last: OPS_LOCK_LOST)')
      expect(outcome.state.message).toContain('nothing was migrated')
      expect((await migrationStatus(s.url, folder)).pending.map((e) => e.tag)).toEqual(['9999_never'])
      expect(await listBackups(env.backupDir)).toHaveLength(0)
    } finally {
      error.mockRestore()
      warn.mockRestore()
      await s.drop()
    }
  }, 90_000)

  it('a pre-upgrade backup that succeeds resets the count of backup lock losses (3d final fix, review #2)', async () => {
    const s = await createScratchDatabase()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const folder = migrationsFolderWith([{ tag: '9999_b', sql: 'CREATE TABLE "b_table" ("id" integer);' }])
      const tools = testPgTools()
      const backupLock = { lost: true }
      const pgTools = { ...tools, dump: (...args: Parameters<typeof tools.dump>) => (backupLock.lost ? Promise.reject(new OpsLockLostError('backup')) : tools.dump(...args)) }
      const env = testOpsEnv(s.url, { migrationsFolder: folder, pgTools })
      const upgrade = newUpgradeMemo()
      // one short of the bound during the backup…
      for (let attempt = 1; attempt < MAX_STALLED_ATTEMPTS; attempt++) {
        await expect(prepareDatabase(env, { upgrade })).rejects.toMatchObject({ code: 'OPS_LOCK_LOST' })
      }
      expect(upgrade.stalled).toEqual({ tag: '<pre-upgrade backup>', attempts: MAX_STALLED_ATTEMPTS - 1 })
      // …then the backup succeeds and the migrate lock is lost: not a verdict, and the count starts again at the migration
      backupLock.lost = false
      const stuck = { testOnly: { lockCheck: () => Promise.resolve(false) } }
      await expect(prepareDatabase(env, { upgrade, ...stuck })).rejects.toMatchObject({ code: 'OPS_LOCK_LOST' })
      expect(upgrade.preUpgradeBackup).toMatch(/-pre-upgrade\.zip$/)
      expect(upgrade.stalled).toEqual({ tag: '9999_b', attempts: 1 })
      expect(await prepareDatabase(env, { upgrade })).toMatchObject({ kind: 'ready', applied: ['9999_b'] })
    } finally {
      error.mockRestore()
      warn.mockRestore()
      await s.drop()
    }
  }, 90_000)

  it('reports a migration whose COMMIT landed though its acknowledgement was lost (fix round 1, review #4)', async () => {
    const s = await createScratchDatabase()
    try {
      const folder = migrationsFolderWith([
        { tag: '9998_acked', sql: 'CREATE TABLE "acked_table" ("id" integer);' },
        { tag: '9999_unacked', sql: 'CREATE TABLE "unacked_table" ("id" integer);' },
      ])
      // what an attempt that lost the database during 9999_unacked's COMMIT leaves behind: both applied in
      // the database, but only 9998_acked heard of, and 9999_unacked the migration it was at
      await applyMigrations(s.url, folder)
      const upgrade = newUpgradeMemo()
      upgrade.applied.push('9998_acked')
      upgrade.inFlight = '9999_unacked'
      expect(await prepareDatabase(testOpsEnv(s.url, { migrationsFolder: folder }), { upgrade })).toEqual({ kind: 'ready', applied: ['9998_acked', '9999_unacked'], preUpgradeBackup: null })
    } finally {
      await s.drop()
    }
  })

  it('two start-ups at once migrate once', async () => {
    const s = await createScratchDatabase('empty')
    try {
      const env = testOpsEnv(s.url)
      const [a, b] = await Promise.all([prepareDatabase(env), prepareDatabase(env)])
      const applied = [a, b].map((o) => (o.kind === 'ready' ? o.applied.length : -1)).sort((x, y) => x - y)
      expect(applied).toEqual([0, journal.length])
      const rows = await s.db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
      expect(rows[0]?.n).toBe(journal.length)
    } finally {
      await s.drop()
    }
  })
})
