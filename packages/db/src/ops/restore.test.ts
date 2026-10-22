import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateSourceInput, type MaintenanceState } from '@mylib/domain'
import { createFileAssetStore } from '../asset-store'
import { createDb, type Db } from '../client'
import { loadUserScope } from '../repos/scope'
import { claimSyncRun, createSyncRun } from '../repos/job-runs'
import { createSource, loadSourceForSync } from '../repos/sources'
import { getLastRestore, getMaintenance, markWorkerPaused, setMaintenance } from '../repos/system'
import { backupSettings, jobRuns } from '../schema'
import { createSecretBox, DEV_SECRET_KEY } from '../secrets'
import {
  createScratchDatabase,
  expectTreeKilled,
  fillLibrary,
  hangingTool,
  holdOpsLock,
  loseOpsLock,
  migrationsFolderWith,
  OPS_TABLES,
  resetDatabase,
  rewriteBackup,
  seedCover,
  snapshotPublicTables,
  tempDir,
  TEST_MIGRATIONS_FOLDER,
  TEST_PNG,
  testOpsEnv,
  type ScratchDatabase,
} from '../testing'
import { BACKUP_DUMP, openBackup } from './backup-file'
import { runBackup } from './backups'
import { listDatabases, OpsBusyError, OpsLockLostError, withDatabase } from './database-admin'
import type { OpsEnv } from './env'
import { applyMigrations, MigrationFailedError, migrationStatus, readJournal } from './migrations'
import { createPgTools, PgToolError } from './pg-tools'
import { DEFAULT_WORKER_PAUSE_TIMEOUT_MS, noMaintenanceControl, restoreBackup, type MaintenanceControl } from './restore'

/**
 * Fix round 2 (R7 gap): injection point for the "a non-busy lock error is still recorded" test below.
 * `withOpsLock` is otherwise not something a test can make fail for a reason other than being busy
 * without touching the shared Testcontainers Postgres server itself (the lock always connects to the
 * `postgres` maintenance database, which every other test in this file, and others, also depends on) —
 * mirrors the established `dropDatabase`-mocking pattern in `ops/backups.test.ts`. Defaults to a pure
 * passthrough, so every other test here is unaffected.
 */
const lockFailure = vi.hoisted(() => ({ error: null as Error | null }))
/**
 * 3d item 4: `options` is merged into the next withOpsLock call only (the restore's own lock, never the
 * clean-up's re-take); `beforeSwap` runs right before swapInDatabase does anything.
 */
const lockTweaks = vi.hoisted(() => ({
  options: null as Partial<import('./database-admin').OpsLockOptions> | null,
  beforeSwap: null as (() => Promise<void>) | null,
}))
vi.mock('./database-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database-admin')>()
  const withOpsLock: typeof actual.withOpsLock = (url, lock, fn, options) => {
    if (lockFailure.error) {
      const error = lockFailure.error
      lockFailure.error = null
      return Promise.reject(error)
    }
    const extra = lockTweaks.options
    lockTweaks.options = null
    return actual.withOpsLock(url, lock, fn, { ...options, ...extra })
  }
  const swapInDatabase: typeof actual.swapInDatabase = async (...args) => {
    await lockTweaks.beforeSwap?.()
    await actual.swapInDatabase(...args)
  }
  return { ...actual, withOpsLock, swapInDatabase }
})

const OTHER_KEY = Buffer.from('other-secret-key-for-restore-32!').toString('base64')
const STRAY_KEY = Buffer.from('third-secret-key-for-the-tests!!').toString('base64')
const box = createSecretBox(DEV_SECRET_KEY)
const exclude = { exclude: OPS_TABLES }
/** A worker acknowledgement later than any restore's start: the restore finds the worker paused. */
const WORKER_ACKNOWLEDGED = new Date('2999-01-01T00:00:00Z')
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const coverHashes = (assetsDir: string, paths: readonly string[]) => Object.fromEntries(paths.map((p) => [p, sha(path.join(assetsDir, ...p.split('/')))]))

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function readDump(zipFile: string): Promise<Buffer> {
  const backup = await openBackup(zipFile)
  try {
    return await toBuffer(await backup.read(BACKUP_DUMP))
  } finally {
    backup.close()
  }
}

/** Several MB of poorly compressible text, so the dump is large enough that pg_restore can stop reading it early (the EPIPE path). */
async function addBulkWorks(db: Db, count: number): Promise<void> {
  await db.execute(sql`insert into work (title, sort_title, description)
    select 'Bulk ' || g, 'bulk ' || g, (select string_agg(md5(random()::text || g::text || i::text), '') from generate_series(1, 64) i)
    from generate_series(1, ${count}::int) g`)
}

/** Makes the live data differ from the backup, so a failed restore that swapped anything in would show. */
async function addedAfterTheBackup(db: Db): Promise<void> {
  await db.execute(sql`insert into work (title, sort_title) values ('Added after the backup', 'added after the backup')`)
}

describe('restore drill (spec §7)', () => {
  let live: ScratchDatabase
  let env: OpsEnv
  const restore = (zipFile: string, overrides: Partial<Parameters<typeof restoreBackup>[1]> = {}, useEnv: OpsEnv = env) =>
    restoreBackup(useEnv, { zipFile, control: noMaintenanceControl, workerPauseTimeoutMs: 0, ...overrides })

  /** Nothing of the failed restore reached the live database: same rows, no half-built database, no maintenance. */
  async function expectLiveUntouched(before: Awaited<ReturnType<typeof snapshotPublicTables>>): Promise<void> {
    expect(await snapshotPublicTables(live.db, exclude)).toEqual(before)
    expect(await listDatabases(live.url, `${live.name}_restore`)).toEqual([])
    expect(await listDatabases(live.url, `${live.name}_prev_`)).toEqual([])
    expect(await getMaintenance(live.db)).toBeNull()
  }

  beforeEach(async () => {
    live = await createScratchDatabase()
    env = testOpsEnv(live.url)
    // stands in for a running worker that has already acknowledged the pause (the R8 test clears it)
    await markWorkerPaused(live.db, WORKER_ACKNOWLEDGED)
    lockFailure.error = null
    lockTweaks.options = null
    lockTweaks.beforeSwap = null
  })
  afterEach(async () => {
    await live.drop()
  })

  it('backs up, wipes and restores every row and every cover exactly, and saved logins still work', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const before = await snapshotPublicTables(live.db, exclude)
    // reading progress (0008) rides in every backup: pg_dump takes the whole database, and only ops tables' data is excluded
    expect(before['reading_progress']).toHaveLength(1)
    const covers = coverHashes(env.assetsDir, filled.coverPaths)
    const logged: string[] = []
    const spies = (['log', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))))
    try {
      const backup = await runBackup(env, 'manual')
      await resetDatabase(live.db)
      await markWorkerPaused(live.db, WORKER_ACKNOWLEDGED)
      rmSync(path.join(env.assetsDir, 'covers'), { recursive: true, force: true })

      const summary = await restore(path.join(env.backupDir, backup.name))

      expect(await snapshotPublicTables(live.db, exclude)).toEqual(before)
      // RP10: the progress point came back from the backup (the snapshot equality above covers every column)
      expect(await live.db.execute(sql`select kind, value, occurred_on::text as on from reading_progress`)).toEqual([{ kind: 'seconds', value: 3600, on: '2026-09-02' }])
      expect(coverHashes(env.assetsDir, filled.coverPaths)).toEqual(covers)
      expect((await loadSourceForSync(live.db, box, filled.sourceId))?.config).toMatchObject({ apiToken: 'abs-token' })
      expect(summary).toMatchObject({
        backupName: backup.name,
        counts: { works: 2, editions: 3, sessions: 1, proposals: 1, sources: 1, covers: 2 },
        resealedSecrets: 0,
        unreadableSecrets: 0,
        unreadableSources: [],
        migrationsApplied: [],
        workerPauseUnconfirmed: false,
      })
      expect(summary.preRestoreBackup).toMatch(/-pre-restore\.zip$/)
      expect(await getMaintenance(live.db)).toBeNull()
      expect(await listDatabases(live.url, `${live.name}_prev_`)).toHaveLength(1)
      const admin = await loadUserScope(live.db, { id: filled.adminId, role: 'admin' })
      expect(await getLastRestore(live.db, admin)).toEqual({ ok: true, summary })
      // backups contain the secret key: it is never logged
      expect(logged.some((line) => line.includes(DEV_SECRET_KEY))).toBe(false)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('re-seals source secrets when this install has a different key', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    const summary = await restore(path.join(env.backupDir, backup.name), {}, { ...env, appSecretKey: OTHER_KEY })
    expect(summary.resealedSecrets).toBe(1)
    expect((await loadSourceForSync(live.db, createSecretBox(OTHER_KEY), filled.sourceId))?.config).toMatchObject({ apiToken: 'abs-token' })
  })

  it('reports source logins that were already unreadable in the backup, by count and by name', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const admin = await loadUserScope(live.db, { id: filled.adminId, role: 'admin' })
    await createSource(
      live.db,
      admin,
      createSecretBox(STRAY_KEY),
      CreateSourceInput.parse({ name: 'Old ABS', config: { kind: 'audiobookshelf', baseUrl: 'http://old.local', apiToken: 'lost' } }),
    )
    const backup = await runBackup(env, 'manual')
    const summary = await restore(path.join(env.backupDir, backup.name), {}, { ...env, appSecretKey: OTHER_KEY })
    expect(summary).toMatchObject({ resealedSecrets: 1, unreadableSecrets: 1, unreadableSources: ['Old ABS'] })
  })

  it('restores a backup from an older version and migrates it', async () => {
    const old = await createScratchDatabase('empty')
    try {
      await applyMigrations(old.url, TEST_MIGRATIONS_FOLDER, { upTo: '0006_asset_hash_cover_checked' })
      await old.db.execute(sql`insert into work (title, sort_title) values ('Old Book', 'old book')`)
      const backup = await runBackup(testOpsEnv(old.url, { appVersion: '0.3.0', backupDir: env.backupDir }), 'pre-upgrade')
      expect(backup.manifest.lastMigration.tag).toBe('0006_asset_hash_cover_checked')
      // the backup predates reading progress (0008)
      expect(await old.db.execute(sql`select to_regclass('public.reading_progress')::text as t`)).toEqual([{ t: null }])

      const summary = await restore(path.join(env.backupDir, backup.name))
      const journal = readJournal(TEST_MIGRATIONS_FOLDER)
      const cut = journal.findIndex((e) => e.tag === '0006_asset_hash_cover_checked')
      expect(summary.migrationsApplied).toEqual(journal.slice(cut + 1).map((e) => e.tag))
      expect(await live.db.execute(sql`select title from work`)).toEqual([{ title: 'Old Book' }])
      // RP10: the forward migration created reading_progress, and it is empty
      expect(summary.migrationsApplied).toContain('0008_reading_progress')
      expect(await live.db.execute(sql`select count(*)::int as n from reading_progress`)).toEqual([{ n: 0 }])
      expect((await migrationStatus(live.url, TEST_MIGRATIONS_FOLDER)).pending).toEqual([])
    } finally {
      await old.drop()
    }
  })

  it('refuses a backup from a newer version and leaves the live data untouched', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    await addedAfterTheBackup(live.db)
    const before = await snapshotPublicTables(live.db, exclude)
    const newer = path.join(tempDir('zip'), 'newer.zip')
    await rewriteBackup(path.join(env.backupDir, backup.name), newer, { manifest: (m) => ({ ...m, appVersion: '9.0.0', lastMigration: { tag: '0042_future', when: 9_999_999_999_999 } }) })
    await expect(restore(newer)).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('newer version') as unknown })
    await expectLiveUntouched(before)
    // Fix round 2 (describeFsError regression): a BackupInvalidError's readable message is stored, not
    // its DomainError `code` ("INVALID") — BackupInvalidError has a `.code` too, but it's not a Node
    // system error (no `errno`/`syscall`), so describeFsError must fall back to the real message.
    const admin = await loadUserScope(live.db, { id: filled.adminId, role: 'admin' })
    expect(await getLastRestore(live.db, admin)).toMatchObject({ ok: false, error: expect.stringContaining('newer version') as unknown })
  })

  // Fix round 2 (R7 gap): mkdtemp used to run before the inner try, so a failure there — BACKUP_DIR
  // unwritable or gone, say — was never recorded anywhere. Also doubles as a describeFsError regression
  // check the other way: this genuinely IS a Node system error, so its code (not a generic message) is
  // what should be stored.
  it('records a failed restore when mkdtemp itself fails, before the inner try used to start', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    const missingBackupDir = path.join(tempDir('zip'), 'does-not-exist')
    await expect(restore(path.join(env.backupDir, backup.name), {}, { ...env, backupDir: missingBackupDir })).rejects.toThrow()
    const admin = await loadUserScope(live.db, { id: filled.adminId, role: 'admin' })
    expect(await getLastRestore(live.db, admin)).toMatchObject({ ok: false, backupName: backup.name, error: 'ENOENT' })
  })

  // Fix round 2 (R7 gap): a lock-acquisition failure that isn't OpsBusyError (a bad connection, say) is
  // just as unattended-to as a busy one unless the outer catch records anything the inner one didn't get
  // a chance to, not only that one specific error class.
  it('records a failed restore when the lock cannot be acquired for a reason other than being busy', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    lockFailure.error = new Error('connection refused (test)')
    await expect(restore(path.join(env.backupDir, backup.name))).rejects.toThrow('connection refused (test)')
    const admin = await loadUserScope(live.db, { id: filled.adminId, role: 'admin' })
    expect(await getLastRestore(live.db, admin)).toMatchObject({ ok: false, backupName: backup.name, error: 'connection refused (test)' })
  })

  it('refuses a corrupted or truncated zip and leaves the live data untouched', async () => {
    await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    await addedAfterTheBackup(live.db)
    const before = await snapshotPublicTables(live.db, exclude)
    const tampered = path.join(tempDir('zip'), 'tampered.zip')
    await rewriteBackup(path.join(env.backupDir, backup.name), tampered, { replace: { 'secret.key': Buffer.from('tampered') }, keepChecksums: true })
    const truncated = path.join(tempDir('zip'), 'truncated.zip')
    const whole = readFileSync(path.join(env.backupDir, backup.name))
    writeFileSync(truncated, whole.subarray(0, Math.floor(whole.length / 2)))
    for (const bad of [tampered, truncated]) await expect(restore(bad)).rejects.toMatchObject({ code: 'INVALID' })
    await expectLiveUntouched(before)
  })

  it('leaves the live database untouched when the restore fails after pg_restore', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    await addedAfterTheBackup(live.db)
    const before = await snapshotPublicTables(live.db, exclude)
    await expect(restore(path.join(env.backupDir, backup.name), { hooks: { afterPgRestore: () => Promise.reject(new Error('injected failure')) } })).rejects.toThrow('injected failure')
    await expectLiveUntouched(before)
    const admin = await loadUserScope(live.db, { id: filled.adminId, role: 'admin' })
    expect(await getLastRestore(live.db, admin)).toMatchObject({ ok: false, backupName: backup.name, error: 'injected failure' })
  })

  it('leaves the live database untouched when a migration fails on the restored database', async () => {
    await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    await addedAfterTheBackup(live.db)
    const before = await snapshotPublicTables(live.db, exclude)
    const broken = migrationsFolderWith([{ tag: '9000_broken', sql: 'create table restore_probe (id int);\n--> statement-breakpoint\nselect 1 / 0;' }])
    await expect(restore(path.join(env.backupDir, backup.name), {}, { ...env, migrationsFolder: broken })).rejects.toBeInstanceOf(MigrationFailedError)
    await expectLiveUntouched(before)
    expect(await live.db.execute(sql`select to_regclass('public.restore_probe') is null as absent`)).toEqual([{ absent: true }])
  })

  it('leaves the live database untouched when re-sealing the secrets fails', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    await addedAfterTheBackup(live.db)
    const before = await snapshotPublicTables(live.db, exclude)
    await expect(
      restore(path.join(env.backupDir, backup.name), { hooks: { afterReseal: () => Promise.reject(new Error('injected re-seal failure')) } }, { ...env, appSecretKey: OTHER_KEY }),
    ).rejects.toThrow('injected re-seal failure')
    await expectLiveUntouched(before)
    // the live source is still sealed with the live key
    expect((await loadSourceForSync(live.db, box, filled.sourceId))?.config).toMatchObject({ apiToken: 'abs-token' })
  })

  it('leaves the live database untouched when the pre-restore backup fails', async () => {
    await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    await addedAfterTheBackup(live.db)
    const before = await snapshotPublicTables(live.db, exclude)
    const pgTools = { ...env.pgTools, dump: () => Promise.reject(new Error('injected dump failure')) }
    await expect(restore(path.join(env.backupDir, backup.name), {}, { ...env, pgTools })).rejects.toThrow('injected dump failure')
    await expectLiveUntouched(before)
  })

  it('leaves the live database untouched when merging the covers fails', async () => {
    await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    await addedAfterTheBackup(live.db)
    const before = await snapshotPublicTables(live.db, exclude)
    const notADirectory = path.join(tempDir('assets'), 'not-a-directory')
    writeFileSync(notADirectory, '')
    await expect(restore(path.join(env.backupDir, backup.name), { preRestoreBackup: false }, { ...env, assetsDir: notADirectory })).rejects.toThrow()
    await expectLiveUntouched(before)
  })

  it('leaves maintenance alone and still leaves the gate when entering maintenance fails', async () => {
    const backup = await runBackup(env, 'manual')
    const other: MaintenanceState = { reason: 'config', message: 'set before the restore', since: new Date().toISOString(), backupName: null }
    await setMaintenance(live.db, other)
    const events: string[] = []
    const control: MaintenanceControl = {
      enter: () => {
        events.push('enter')
        return Promise.reject(new Error('the gate refused'))
      },
      leave: () => void events.push('leave'),
    }
    await expect(restore(path.join(env.backupDir, backup.name), { control })).rejects.toThrow('the gate refused')
    expect(events).toEqual(['enter', 'leave'])
    // never written, so never cleared: the value from before the restore is still there
    expect(await getMaintenance(live.db)).toEqual(other)
    expect(await listDatabases(live.url, `${live.name}_restore`)).toEqual([])
  })

  it('never prunes the backup it is restoring, even the oldest kept pre-restore backup (ruling R23)', async () => {
    await fillLibrary(live.db, env.assetsDir, box)
    await live.db.insert(backupSettings).values({ keepScheduled: 1, keepPreUpgrade: 1, keepPreRestore: 1 })
    const target = await runBackup(env, 'pre-restore')
    const summary = await restore(path.join(env.backupDir, target.name))
    expect(summary.preRestoreBackup).toMatch(/-pre-restore\.zip$/)
    expect(summary.preRestoreBackup).not.toBe(target.name)
    expect(existsSync(path.join(env.backupDir, target.name))).toBe(true)
  })

  // Fix round 1 (ruling R26): the file actually being restored is protected from pruning by its own
  // real name, independent of `displayName` (the app passes a manifest-derived name for an uploaded
  // backup, which never matches any file on disk). Without that split, this backup — the sole
  // "pre-restore" file kept, with retention 1 — would be pruned by the pre-restore backup the restore
  // itself takes, exactly like the R23 case above, the moment `protect` matched on the wrong name.
  it('protects the restore target by its own file name, not by displayName (ruling R26)', async () => {
    await fillLibrary(live.db, env.assetsDir, box)
    await live.db.insert(backupSettings).values({ keepScheduled: 1, keepPreUpgrade: 1, keepPreRestore: 1 })
    const target = await runBackup(env, 'pre-restore')
    const cosmeticName = 'my-library-0.0.0-19991231T235959Z-manual.zip'
    const summary = await restore(path.join(env.backupDir, target.name), { displayName: cosmeticName })
    expect(summary.backupName).toBe(cosmeticName)
    expect(summary.preRestoreBackup).toMatch(/-pre-restore\.zip$/)
    expect(summary.preRestoreBackup).not.toBe(target.name)
    expect(existsSync(path.join(env.backupDir, target.name))).toBe(true)
  })

  it('never fails once the databases are swapped: a later failure is logged and the summary returned', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const before = await snapshotPublicTables(live.db, exclude)
    const backup = await runBackup(env, 'manual')
    await addedAfterTheBackup(live.db)
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')))
    try {
      const summary = await restore(path.join(env.backupDir, backup.name), { hooks: { afterSwap: () => Promise.reject(new Error('injected after-swap failure')) } })
      expect(summary.backupName).toBe(backup.name)
    } finally {
      spy.mockRestore()
    }
    expect(errors.some((line) => line.includes('injected after-swap failure'))).toBe(true)
    expect(await snapshotPublicTables(live.db, exclude)).toEqual(before)
    expect(await getMaintenance(live.db)).toBeNull()
    const admin = await loadUserScope(live.db, { id: filled.adminId, role: 'admin' })
    expect(await getLastRestore(live.db, admin)).toMatchObject({ ok: true, summary: { backupName: backup.name } })
  })

  it('moves covers the restored library does not use aside, and removes them after the next successful backup', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    const bytes = Uint8Array.from([...TEST_PNG, 99])
    const extra = await createFileAssetStore(env.assetsDir).put(bytes, 'png')
    const [edition] = await live.db.execute<{ id: string }>(sql`select id from edition order by id limit 1`)
    await seedCover(live.db, edition?.id ?? '', { ...extra, mime: 'image/png' })

    await restore(path.join(env.backupDir, backup.name))

    expect(existsSync(path.join(env.assetsDir, ...extra.path.split('/')))).toBe(false)
    const aside = readdirSync(env.assetsDir).filter((entry) => entry.startsWith('.prev-'))
    expect(aside).toHaveLength(1)
    const moved = path.join(env.assetsDir, aside[0] ?? '', ...extra.path.split('/'))
    expect(sha(moved)).toBe(createHash('sha256').update(bytes).digest('hex'))
    for (const kept of filled.coverPaths) expect(existsSync(path.join(env.assetsDir, ...kept.split('/')))).toBe(true)

    await runBackup(env, 'manual')
    expect(readdirSync(env.assetsDir).filter((entry) => entry.startsWith('.prev-'))).toEqual([])
  })

  it('fails the sync runs and pg-boss jobs the backup caught mid-flight, so no ghost blocks "Back up now" (final fix 6)', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const runId = await createSyncRun(live.db, { sourceId: filled.sourceId, trigger: 'schedule', requestedBy: null })
    await claimSyncRun(live.db, runId)
    // a stand-in for pg-boss's own table (packages/db does not depend on pg-boss): the columns the restore touches
    await live.db.execute(sql`create schema pgboss`)
    await live.db.execute(sql`create type pgboss.job_state as enum ('created', 'retry', 'active', 'completed', 'cancelled', 'failed')`)
    await live.db.execute(sql`create table pgboss.job (id uuid primary key default gen_random_uuid(), name text not null, state pgboss.job_state not null, completed_on timestamptz, output jsonb)`)
    await live.db.execute(sql`insert into pgboss.job (name, state) values ('backup', 'active'), ('source-sync', 'created')`)
    const backup = await runBackup(env, 'manual')

    await restore(path.join(env.backupDir, backup.name))

    const [run] = await live.db.select().from(jobRuns).where(eq(jobRuns.id, runId))
    expect(run).toMatchObject({ status: 'failed', error: expect.stringContaining('restore') as unknown })
    const jobs = await live.db.execute<{ name: string; state: string; done: boolean }>(sql`select name, state::text as state, completed_on is not null as done from pgboss.job order by name`)
    expect([...jobs]).toEqual([
      { name: 'backup', state: 'failed', done: true },
      { name: 'source-sync', state: 'created', done: false },
    ])
  })

  it('goes on when the worker never confirms the pause, and says so (ruling R8)', async () => {
    expect(DEFAULT_WORKER_PAUSE_TIMEOUT_MS).toBe(50_000)
    await markWorkerPaused(live.db, null)
    const backup = await runBackup(env, 'manual')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const summary = await restore(path.join(env.backupDir, backup.name))
      expect(summary.workerPauseUnconfirmed).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('worker'))
    } finally {
      warn.mockRestore()
    }
  })

  describe('with a multi-MB library', () => {
    it('restores every row exactly', async () => {
      await fillLibrary(live.db, env.assetsDir, box)
      await addBulkWorks(live.db, 2500)
      const before = await snapshotPublicTables(live.db, exclude)
      const backup = await runBackup(env, 'manual')
      expect(backup.manifest.files.find((f) => f.path === BACKUP_DUMP)?.size).toBeGreaterThan(2 * 1024 * 1024)
      await resetDatabase(live.db)
      await markWorkerPaused(live.db, WORKER_ACKNOWLEDGED)

      const summary = await restore(path.join(env.backupDir, backup.name))

      expect(summary.counts.works).toBe(2502)
      expect(await snapshotPublicTables(live.db, exclude)).toEqual(before)
    })

    it('leaves the live database untouched when pg_restore fails part-way through the dump', async () => {
      await fillLibrary(live.db, env.assetsDir, box)
      await addBulkWorks(live.db, 2500)
      const backup = await runBackup(env, 'manual')
      await addedAfterTheBackup(live.db)
      const before = await snapshotPublicTables(live.db, exclude)
      // the table of contents stays readable (validation passes); the data half-way through does not
      const dump = await readDump(path.join(env.backupDir, backup.name))
      const middle = Math.floor(dump.length / 2)
      dump.fill(0xff, middle, middle + 4096)
      const broken = path.join(tempDir('zip'), 'broken-data.zip')
      await rewriteBackup(path.join(env.backupDir, backup.name), broken, { replace: { [BACKUP_DUMP]: dump } })

      await expect(restore(broken)).rejects.toMatchObject({ name: 'PgToolError', kind: 'exit' } satisfies Partial<PgToolError>)
      await expectLiveUntouched(before)
    })
  })

  it('refuses a restore while a backup runs', async () => {
    const filled = await fillLibrary(live.db, env.assetsDir, box)
    const backup = await runBackup(env, 'manual')
    const release = gate()
    const reached = gate()
    const running = runBackup(env, 'scheduled', {
      hooks: {
        afterZipWritten: async () => {
          reached.open()
          await release.opened
        },
      },
    })
    await reached.opened
    await expect(restore(path.join(env.backupDir, backup.name))).rejects.toBeInstanceOf(OpsBusyError)
    // Fix round 1 (ruling R7): an OpsBusyError from the lock means restoreBackup's own callback never
    // ran at all, so nothing inside it could have recorded the failure — it's recorded around the lock
    // instead, with a clear, non-technical busy message (never a path, never the raw lock error text).
    const admin = await loadUserScope(live.db, { id: filled.adminId, role: 'admin' })
    expect(await getLastRestore(live.db, admin)).toMatchObject({
      ok: false,
      backupName: backup.name,
      error: expect.stringContaining('already running') as unknown,
    })
    release.open()
    await running
  })

  it('keeps the previous database until the next successful backup', async () => {
    const backup = await runBackup(env, 'manual')
    await restore(path.join(env.backupDir, backup.name))
    expect(await listDatabases(live.url, `${live.name}_prev_`)).toHaveLength(1)
    await runBackup(env, 'manual')
    expect(await listDatabases(live.url, `${live.name}_prev_`)).toEqual([])
  })

  it('holds maintenance for the whole restore, in this process and in the database, and ends it', async () => {
    const backup = await runBackup(env, 'manual')
    const events: string[] = []
    const control: MaintenanceControl = {
      enter: (state: MaintenanceState) => {
        events.push(`enter:${state.reason}`)
        return Promise.resolve()
      },
      leave: () => void events.push('leave'),
    }
    let during: MaintenanceState | null = null
    await restore(path.join(env.backupDir, backup.name), {
      control,
      hooks: {
        afterPgRestore: async () => {
          during = await getMaintenance(live.db)
        },
      },
    })
    expect(events).toEqual(['enter:restore', 'leave'])
    expect(during).toMatchObject({ reason: 'restore', backupName: backup.name })
    expect(await getMaintenance(live.db)).toBeNull()
    // the previous database, kept for a manual look, is not left in maintenance either
    const [prev] = await listDatabases(live.url, `${live.name}_prev_`)
    const handle = createDb(withDatabase(live.url, prev ?? 'missing'), { max: 1 })
    try {
      expect(await getMaintenance(handle.db)).toBeNull()
    } finally {
      await handle.close()
    }
  })

  it('fails cleanly when pg_restore hangs past its time limit: the tool is killed, the live database untouched, the lock free (3d item 3)', async () => {
    const backup = await runBackup(env, 'manual')
    await addedAfterTheBackup(live.db)
    const before = await snapshotPublicTables(live.db, exclude)
    const tool = hangingTool()
    const hung = createPgTools({ prefix: tool.prefix, timeoutsMs: { restore: 2_000 }, killGraceMs: 3_000 })
    const hangingEnv: OpsEnv = { ...env, pgTools: { ...env.pgTools, restore: (url, file, opts) => hung.restore(url, file, opts) } }
    await expect(restore(path.join(env.backupDir, backup.name), {}, hangingEnv)).rejects.toMatchObject({ name: 'PgToolError', kind: 'timeout' })
    await expectLiveUntouched(before)
    await expectTreeKilled(tool)
    expect(readdirSync(env.backupDir).filter((entry) => entry.startsWith('.restore-'))).toEqual([])
    // the lock is free: a backup can run at once
    expect((await runBackup(env, 'manual')).name).toMatch(/-manual\.zip$/)
  })

  describe('losing the backup lock (3d item 4)', () => {
    const quiet = () => (['warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined))
    let spies: ReturnType<typeof quiet> = []
    beforeEach(() => {
      spies = quiet()
    })
    afterEach(() => {
      for (const spy of spies) spy.mockRestore()
    })

    /** 3d final fix (review #3): a holder that keeps the lock is waited out for this long, not the production 15 s. */
    const SHORT_RETAKE = { retakeWithinMs: 300, retakePollMs: 100 }

    /** What another backup or restore leaves while it runs: its restore database and its maintenance flag. */
    async function expectAnotherHoldersStateLeftAlone(): Promise<void> {
      expect(await listDatabases(live.url, `${live.name}_restore`)).toEqual([`${live.name}_restore`])
      expect(await getMaintenance(live.db)).toMatchObject({ reason: 'restore' })
      expect(await listDatabases(live.url, `${live.name}_prev_`)).toEqual([])
    }

    it('never swaps when its lock session was lost mid-restore: the live database stays untouched', async () => {
      const filled = await fillLibrary(live.db, env.assetsDir, box)
      const backup = await runBackup(env, 'manual')
      await addedAfterTheBackup(live.db)
      const before = await snapshotPublicTables(live.db, exclude)
      // the default 5 s heartbeat has not fired by the swap: the live check before it is what stops it
      await expect(restore(path.join(env.backupDir, backup.name), { hooks: { afterPgRestore: () => loseOpsLock(live.url, 'backup') } })).rejects.toBeInstanceOf(OpsLockLostError)
      await expectLiveUntouched(before)
      const admin = await loadUserScope(live.db, { id: filled.adminId, role: 'admin' })
      expect(await getLastRestore(live.db, admin)).toMatchObject({ ok: false, error: expect.stringContaining('lock was lost') as unknown })
    })

    it('a lock lost during the pre-restore backup stops the restore before it builds anything (review focus 5)', async () => {
      const backup = await runBackup(env, 'manual')
      await addedAfterTheBackup(live.db)
      const before = await snapshotPublicTables(live.db, exclude)
      const real = env.pgTools
      const pgRestore = vi.fn((url: string, dumpFile: string, options?: { signal?: AbortSignal }) => real.restore(url, dumpFile, options))
      const losing: OpsEnv = {
        ...env,
        pgTools: {
          ...real,
          dump: async (url, outFile, options) => {
            await loseOpsLock(live.url, 'backup')
            await real.dump(url, outFile, options)
          },
          restore: pgRestore,
        },
      }
      await expect(restore(path.join(env.backupDir, backup.name), {}, losing)).rejects.toBeInstanceOf(OpsLockLostError)
      await expectLiveUntouched(before)
      expect(pgRestore).not.toHaveBeenCalled()
      expect(readdirSync(env.backupDir).filter((name) => name.endsWith('-pre-restore.zip'))).toEqual([])
    })

    it('a loss found by the swap itself marks the lock lost: while another holder has it, neither the restore database nor maintenance is touched (rulings P1, P5)', async () => {
      const backup = await runBackup(env, 'manual')
      const other: { release?: () => Promise<void> } = {}
      lockTweaks.beforeSwap = async () => {
        await loseOpsLock(live.url, 'backup')
        other.release = await holdOpsLock(live.url, 'backup')
      }
      try {
        await expect(restore(path.join(env.backupDir, backup.name), { preRestoreBackup: false, testOnly: SHORT_RETAKE })).rejects.toBeInstanceOf(OpsLockLostError)
        expect(other.release).toBeDefined()
        await expectAnotherHoldersStateLeftAlone()
      } finally {
        await other.release?.()
      }
    })

    it('a loss found mid-restore leaves the restore database and maintenance alone while another holder has the lock (ruling P5)', async () => {
      const backup = await runBackup(env, 'manual')
      const other: { release?: () => Promise<void> } = {}
      const takeOver = async () => {
        await loseOpsLock(live.url, 'backup')
        other.release = await holdOpsLock(live.url, 'backup')
      }
      try {
        await expect(restore(path.join(env.backupDir, backup.name), { preRestoreBackup: false, hooks: { afterPgRestore: takeOver }, testOnly: SHORT_RETAKE })).rejects.toBeInstanceOf(OpsLockLostError)
        expect(other.release).toBeDefined()
        await expectAnotherHoldersStateLeftAlone()
      } finally {
        await other.release?.()
      }
    })

    it('a lock session that still holds the lock for ~2 s after the loss does not strand maintenance: the clean-up keeps trying, re-takes it and runs (3d final fix, review #3)', async () => {
      const backup = await runBackup(env, 'manual')
      await addedAfterTheBackup(live.db)
      const before = await snapshotPublicTables(live.db, exclude)
      // stands in for our own lost session whose backend has not exited yet: it holds the lock for ~2 s more
      const dying: { ended?: Promise<void> } = {}
      const loseButKeepHolding = async () => {
        await loseOpsLock(live.url, 'backup')
        const release = await holdOpsLock(live.url, 'backup')
        dying.ended = new Promise((resolve) => setTimeout(resolve, 2_000)).then(release)
      }
      try {
        await expect(restore(path.join(env.backupDir, backup.name), { preRestoreBackup: false, hooks: { afterPgRestore: loseButKeepHolding } })).rejects.toBeInstanceOf(OpsLockLostError)
        expect(dying.ended).toBeDefined()
        // the restore database dropped and maintenance cleared, under the lock re-taken once the old session ended
        await expectLiveUntouched(before)
      } finally {
        await dying.ended
      }
    }, 60_000)

    it('a lock another holder keeps the whole time: the clean-up gives up after its window, leaves the flag alone and says so (3d final fix, review #3)', async () => {
      const backup = await runBackup(env, 'manual')
      const other: { release?: () => Promise<void>; tookOverAt: number } = { tookOverAt: Number.POSITIVE_INFINITY }
      const takeOver = async () => {
        await loseOpsLock(live.url, 'backup')
        other.release = await holdOpsLock(live.url, 'backup')
        other.tookOverAt = Date.now()
      }
      const [warn] = spies
      try {
        await expect(
          restore(path.join(env.backupDir, backup.name), { preRestoreBackup: false, hooks: { afterPgRestore: takeOver }, testOnly: { retakeWithinMs: 1_500, retakePollMs: 100 } }),
        ).rejects.toBeInstanceOf(OpsLockLostError)
        // it really kept trying for its window before giving up
        expect(Date.now() - other.tookOverAt).toBeGreaterThanOrEqual(1_500)
        expect(other.release).toBeDefined()
        await expectAnotherHoldersStateLeftAlone()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('another backup or restore still held it after 1.5 s'))
      } finally {
        await other.release?.()
      }
    }, 60_000)

    it('a heartbeat that fails on a session still alive ends that session, so the clean-up re-takes the lock and still runs (ruling P8)', async () => {
      const backup = await runBackup(env, 'manual')
      await addedAfterTheBackup(live.db)
      const before = await snapshotPublicTables(live.db, exclude)
      const failing = { value: false }
      const failed = gate()
      lockTweaks.options = {
        heartbeatMs: 50,
        testOnly: {
          check: () => {
            if (!failing.value) return Promise.resolve(true)
            failed.open()
            return Promise.reject(Object.assign(new Error('simulated heartbeat failure'), { code: 'XX000' }))
          },
        },
      }
      const failTheHeartbeat = async () => {
        failing.value = true
        await failed.opened
      }
      await expect(restore(path.join(env.backupDir, backup.name), { preRestoreBackup: false, hooks: { afterPgRestore: failTheHeartbeat } })).rejects.toBeInstanceOf(OpsLockLostError)
      // the restore database dropped and maintenance cleared, under the re-taken lock
      await expectLiveUntouched(before)
    })

    it('a lock lost silently while the restore fails for another reason: a live check in the catch leaves the restore database and maintenance alone (fix round 1)', async () => {
      const backup = await runBackup(env, 'manual')
      const other: { release?: () => Promise<void> } = {}
      const loseSilentlyThenFail = async () => {
        // the default 5 s heartbeat has not noticed: only the catch's own live check can
        await loseOpsLock(live.url, 'backup')
        other.release = await holdOpsLock(live.url, 'backup')
        throw new Error('injected unrelated failure')
      }
      try {
        // the restore's own failure is what it reports
        await expect(restore(path.join(env.backupDir, backup.name), { preRestoreBackup: false, hooks: { afterPgRestore: loseSilentlyThenFail }, testOnly: SHORT_RETAKE })).rejects.toThrow('injected unrelated failure')
        expect(other.release).toBeDefined()
        await expectAnotherHoldersStateLeftAlone()
      } finally {
        await other.release?.()
      }
    })
  })
})
