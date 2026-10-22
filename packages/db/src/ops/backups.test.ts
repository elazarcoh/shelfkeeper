import { mkdirSync, readdirSync, readFileSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { backupFileName, type MaintenanceState } from '@mylib/domain'
import { createFileAssetStore } from '../asset-store'
import { getMaintenance, setMaintenance, startBackupRun } from '../repos/system'
import { backupRuns, backupSettings } from '../schema'
import { expectTreeKilled, hangingTool, holdOpsLock, loseOpsLock, seedCover, seedWork, TEST_MIGRATIONS_FOLDER, TEST_PNG, testOpsEnv, useTestDb } from '../testing'
import { BackupInvalidError } from './backup-file'
import { cleanupBackupLeftovers, createBackupLocked, deleteBackup, listBackups, runBackup, UPLOADS_DIR, VALIDATION_WORK_PREFIX } from './backups'
import { createEmptyDatabase, databaseName, dropDatabase, listDatabases, OpsBusyError, OpsLockLostError, withOpsLock } from './database-admin'
import { createPgTools } from './pg-tools'
import { readJournal } from './migrations'

/**
 * Injection point for the R22 pruning-failure test below: `dropDatabase` is the one uncaught call inside
 * `dropPreviousRestores` (everything else in `pruneAfterSuccess` already swallows its own errors), so
 * making it throw on demand is the most direct way to make pruning itself fail without breaking every
 * other test in this file, which all rely on the real database-admin functions.
 */
const pruneFailure = vi.hoisted(() => ({ enabled: false }))
vi.mock('./database-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database-admin')>()
  return {
    ...actual,
    dropDatabase: async (url: string, name: string) => {
      if (pruneFailure.enabled) throw new Error('simulated: could not drop the previous-restore database')
      return actual.dropDatabase(url, name)
    },
  }
})

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

describe('backups', () => {
  const t = useTestDb()

  it('writes a verified backup, records the run and leaves nothing temporary behind', async () => {
    const env = testOpsEnv(t.url)
    const cover = await createFileAssetStore(env.assetsDir).put(TEST_PNG, 'png')
    const work = await seedWork(t.db, { title: 'Dune', formats: ['physical'] })
    await seedCover(t.db, work.editionIds[0] ?? '', { ...cover, mime: 'image/png' })

    const result = await runBackup(env, 'manual')
    expect(result.name).toMatch(/^my-library-0\.4\.0-test-\d{8}T\d{6}Z-manual\.zip$/)
    expect(readdirSync(env.backupDir)).toEqual([result.name])
    expect(result.manifest.files.map((f) => f.path)).toEqual(['db.dump', `assets/${cover.path}`, 'secret.key'])
    expect(result.manifest.lastMigration.tag).toBe(readJournal(TEST_MIGRATIONS_FOLDER).at(-1)?.tag)
    const [run] = await t.db.select().from(backupRuns)
    expect(run).toMatchObject({ kind: 'manual', status: 'succeeded', fileName: result.name, sizeBytes: result.sizeBytes })
  })

  it('refuses a second backup while one runs', async () => {
    const env = testOpsEnv(t.url)
    const release = gate()
    const reached = gate()
    const first = runBackup(env, 'scheduled', {
      hooks: {
        afterZipWritten: async () => {
          reached.open()
          await release.opened
        },
      },
    })
    await reached.opened
    await expect(runBackup(env, 'manual')).rejects.toBeInstanceOf(OpsBusyError)
    release.open()
    await first
  })

  it('never overwrites a backup made in the same second', async () => {
    const at = new Date('2026-09-28T03:00:00Z')
    const env = testOpsEnv(t.url, { now: () => at })
    const a = await runBackup(env, 'manual')
    const b = await runBackup(env, 'manual')
    expect(a.name).toBe('my-library-0.4.0-test-20260928T030000Z-manual.zip')
    expect(b.name).toBe('my-library-0.4.0-test-20260928T030001Z-manual.zip')
    expect(readdirSync(env.backupDir).sort()).toEqual([a.name, b.name])
  })

  it('a disk-full failure removes the temp file and keeps older backups', async () => {
    const env = testOpsEnv(t.url)
    const older = await runBackup(env, 'manual')
    const before = readFileSync(path.join(env.backupDir, older.name))
    const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    await expect(runBackup(env, 'scheduled', { hooks: { afterZipWritten: () => Promise.reject(enospc) } })).rejects.toThrow('ENOSPC')
    expect(readdirSync(env.backupDir)).toEqual([older.name])
    expect(readFileSync(path.join(env.backupDir, older.name)).equals(before)).toBe(true)
    const runs = await t.db.select().from(backupRuns).orderBy(backupRuns.startedAt)
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'failed'])
    expect(runs[1]?.error).toContain('no space left on device')
  })

  it('deletes the temp file and records the failure when verification fails', async () => {
    const env = testOpsEnv(t.url)
    const truncate = (tmp: string) => {
      truncateSync(tmp, Math.floor(readFileSync(tmp).length / 2))
      return Promise.resolve()
    }
    await expect(runBackup(env, 'manual', { hooks: { afterZipWritten: truncate } })).rejects.toBeInstanceOf(BackupInvalidError)
    expect(readdirSync(env.backupDir)).toEqual([])
    const [run] = await t.db.select().from(backupRuns)
    expect(run?.status).toBe('failed')
  })

  it('marks the backup run failed and never leaves it running when BACKUP_DIR does not exist (controller ruling R4)', async () => {
    const missingDir = path.join(tmpdir(), `mylib-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const env = testOpsEnv(t.url, { backupDir: missingDir })
    await expect(runBackup(env, 'manual')).rejects.toThrow()
    const [run] = await t.db.select().from(backupRuns)
    expect(run?.status).toBe('failed')
    // the DB pool opened for that attempt, and the backup lock it held, must have been released —
    // not left dangling — or this second backup would hang or throw OpsBusyError
    const again = await runBackup(testOpsEnv(t.url), 'manual')
    expect(again.name).toMatch(/\.zip$/)
  })

  it('prunes per kind after a success, never manual backups, never the newest, and never a foreign or in-progress file', async () => {
    const env = testOpsEnv(t.url)
    await t.db.insert(backupSettings).values({ keepScheduled: 1, keepPreUpgrade: 1, keepPreRestore: 1 })
    const old = (kind: 'scheduled' | 'manual' | 'pre-upgrade', iso: string) => {
      const name = backupFileName('0.3.0', new Date(iso), kind)
      writeFileSync(path.join(env.backupDir, name), 'old')
      return name
    }
    const s1 = old('scheduled', '2026-01-01T00:00:00Z')
    const s2 = old('scheduled', '2026-01-02T00:00:00Z')
    const manual = old('manual', '2020-01-01T00:00:00Z')
    const upgrade = old('pre-upgrade', '2026-01-01T00:00:00Z')
    // neither a file pruning has no business touching: a foreign file that isn't one of ours, and the
    // in-progress temp file of a backup that is itself about to be pruned
    const foreignZip = 'foo.zip'
    writeFileSync(path.join(env.backupDir, foreignZip), 'not ours')
    const strayTmp = `${s1}.tmp`
    writeFileSync(path.join(env.backupDir, strayTmp), 'in progress')
    const fresh = await runBackup(env, 'scheduled')
    expect(fresh.pruned.sort()).toEqual([s1, s2].sort())
    expect(readdirSync(env.backupDir).sort()).toEqual([fresh.name, manual, upgrade, foreignZip, strayTmp].sort())
  })

  it('never prunes a protected backup (controller ruling R23: a restore protects the backup it restores)', async () => {
    const env = testOpsEnv(t.url)
    await t.db.insert(backupSettings).values({ keepScheduled: 1, keepPreUpgrade: 1, keepPreRestore: 1 })
    const older = backupFileName('0.3.0', new Date('2026-01-01T00:00:00Z'), 'pre-restore')
    const oldest = backupFileName('0.3.0', new Date('2025-01-01T00:00:00Z'), 'pre-restore')
    writeFileSync(path.join(env.backupDir, older), 'old')
    writeFileSync(path.join(env.backupDir, oldest), 'older')
    const fresh = await createBackupLocked(env, 'pre-restore', undefined, { protect: [older] })
    expect(fresh.pruned).toEqual([oldest])
    expect(readdirSync(env.backupDir).sort()).toEqual([fresh.name, older].sort())
  })

  it('a pruning failure never fails the run: the backup still succeeds and stays listed (controller ruling R22)', async () => {
    const env = testOpsEnv(t.url)
    const live = databaseName(t.url)
    const staleDb = `${live}_prev_20260101t000000z`
    await createEmptyDatabase(t.url, staleDb)
    pruneFailure.enabled = true
    try {
      const result = await runBackup(env, 'manual')
      expect(result.name).toMatch(/\.zip$/)
      const [run] = await t.db.select().from(backupRuns)
      expect(run?.status).toBe('succeeded')
      expect((await listBackups(env.backupDir)).map((b) => b.name)).toEqual([result.name])
    } finally {
      pruneFailure.enabled = false
      await dropDatabase(t.url, staleDb)
    }
  })

  it('drops previous-restore databases and asset folders after a successful backup', async () => {
    const env = testOpsEnv(t.url)
    const live = databaseName(t.url)
    await createEmptyDatabase(t.url, `${live}_prev_20260101t000000z`)
    mkdirSync(path.join(env.assetsDir, '.prev-20260101T000000Z', 'covers'), { recursive: true })
    await runBackup(env, 'manual')
    expect(await listDatabases(t.url, `${live}_prev_`)).toEqual([])
    expect(readdirSync(env.assetsDir)).toEqual([])
  })

  it('lists backups newest first and deletes only by backup name', async () => {
    const env = testOpsEnv(t.url)
    const a = await runBackup(env, 'manual', {})
    const b = await runBackup(testOpsEnv(t.url, { backupDir: env.backupDir, now: () => new Date(Date.now() + 5000) }), 'scheduled')
    expect((await listBackups(env.backupDir)).map((x) => [x.name, x.kind, x.verified])).toEqual([
      [b.name, 'scheduled', true],
      [a.name, 'manual', true],
    ])
    await expect(deleteBackup(env.backupDir, `../${a.name}`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await deleteBackup(env.backupDir, a.name)
    expect(readdirSync(env.backupDir)).toEqual([b.name])
  })

  it('cleans up what a killed backup or restore left behind', async () => {
    const env = testOpsEnv(t.url)
    const live = databaseName(t.url)
    writeFileSync(path.join(env.backupDir, 'my-library-0.4.0-20260928T030000Z-manual.zip.tmp'), 'partial')
    mkdirSync(path.join(env.backupDir, '.work-abc'))
    mkdirSync(path.join(env.backupDir, '.restore-def'))
    mkdirSync(path.join(env.backupDir, 'uploads'))
    const staleUpload = path.join(env.backupDir, 'uploads', '11111111-1111-4111-8111-111111111111.zip')
    writeFileSync(staleUpload, 'old upload')
    const dayAgo = new Date(Date.now() - 25 * 3_600_000)
    utimesSync(staleUpload, dayAgo, dayAgo)
    await startBackupRun(t.db, 'manual')
    await createEmptyDatabase(t.url, `${live}_restore`)

    expect((await cleanupBackupLeftovers(env)).removed).toBe(4)
    expect(readdirSync(env.backupDir)).toEqual(['uploads'])
    expect(readdirSync(path.join(env.backupDir, 'uploads'))).toEqual([])
    expect(await listDatabases(t.url, `${live}_restore`)).toEqual([])
    const [run] = await t.db.select().from(backupRuns)
    expect(run).toMatchObject({ status: 'failed', error: 'Interrupted: the process stopped during this backup' })
  })

  it('start-up cleanup removes only our own temp files, skips directories in uploads/, and leaves a fresh upload alone', async () => {
    const env = testOpsEnv(t.url)
    const ourTmp = 'my-library-0.4.0-20260928T030000Z-manual.zip.tmp'
    writeFileSync(path.join(env.backupDir, ourTmp), 'partial')
    // a `.tmp` file that is not one of ours (its base does not parse as a backup file name) must survive
    writeFileSync(path.join(env.backupDir, 'notes.tmp'), 'not ours')
    const uploads = path.join(env.backupDir, UPLOADS_DIR)
    mkdirSync(uploads, { recursive: true })
    const freshUpload = path.join(uploads, '22222222-2222-4222-8222-222222222222.zip')
    writeFileSync(freshUpload, 'fresh')
    const oldUpload = path.join(uploads, '33333333-3333-4333-8333-333333333333.zip')
    writeFileSync(oldUpload, 'old')
    const overAnHourAgo = new Date(Date.now() - 2 * 3_600_000)
    utimesSync(oldUpload, overAnHourAgo, overAnHourAgo)
    // a directory inside uploads/ must never be treated as a file (and must not throw)
    mkdirSync(path.join(uploads, 'a-directory'))

    const result = await cleanupBackupLeftovers(env)
    expect(result.removed).toBe(2) // our own .tmp, and the old upload
    expect(readdirSync(env.backupDir).sort()).toEqual(['notes.tmp', UPLOADS_DIR].sort())
    expect(readdirSync(uploads).sort()).toEqual(['22222222-2222-4222-8222-222222222222.zip', 'a-directory'].sort())
  })

  it('leaves an upload still streaming and a validation still running in another process alone, and removes them once over an hour old (final fix 6)', async () => {
    const env = testOpsEnv(t.url)
    const overAnHourAgo = new Date(Date.now() - 2 * 3_600_000)
    const freshValidation = path.join(env.backupDir, `${VALIDATION_WORK_PREFIX}fresh`)
    const oldValidation = path.join(env.backupDir, `${VALIDATION_WORK_PREFIX}old`)
    mkdirSync(freshValidation)
    mkdirSync(oldValidation)
    utimesSync(oldValidation, overAnHourAgo, overAnHourAgo)
    const uploads = path.join(env.backupDir, UPLOADS_DIR)
    mkdirSync(uploads, { recursive: true })
    const streaming = path.join(uploads, '44444444-4444-4444-8444-444444444444.zip.tmp')
    const abandoned = path.join(uploads, '55555555-5555-4555-8555-555555555555.zip.tmp')
    writeFileSync(streaming, 'still arriving')
    writeFileSync(abandoned, 'gave up')
    utimesSync(abandoned, overAnHourAgo, overAnHourAgo)

    expect((await cleanupBackupLeftovers(env)).removed).toBe(2)
    expect(readdirSync(env.backupDir).sort()).toEqual([`${VALIDATION_WORK_PREFIX}fresh`, UPLOADS_DIR].sort())
    expect(readdirSync(uploads)).toEqual(['44444444-4444-4444-8444-444444444444.zip.tmp'])
  })

  it('a pg_dump hung past its time limit is killed: the run fails, nothing temporary is left, and the lock is free again (3d item 3)', async () => {
    const env = testOpsEnv(t.url)
    const tool = hangingTool()
    const hung = createPgTools({ prefix: tool.prefix, timeoutsMs: { dump: 2_000 }, killGraceMs: 3_000 })
    await expect(runBackup({ ...env, pgTools: { ...env.pgTools, dump: (url, out, opts) => hung.dump(url, out, opts) } }, 'manual')).rejects.toMatchObject({ name: 'PgToolError', kind: 'timeout' })
    expect(readdirSync(env.backupDir)).toEqual([])
    const [run] = await t.db.select().from(backupRuns)
    expect(run).toMatchObject({ status: 'failed', error: expect.stringContaining('did not finish within') as unknown })
    await expectTreeKilled(tool)
    expect(await withOpsLock(env.databaseUrl, 'backup', () => Promise.resolve('free'))).toBe('free')
  })

  it('a backup whose lock session is lost stops before renaming its zip into place (3d item 4)', async () => {
    const env = testOpsEnv(t.url)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(runBackup(env, 'manual', { hooks: { afterZipWritten: () => loseOpsLock(env.databaseUrl, 'backup') } })).rejects.toBeInstanceOf(OpsLockLostError)
    } finally {
      error.mockRestore()
    }
    expect(readdirSync(env.backupDir)).toEqual([])
    const [run] = await t.db.select().from(backupRuns)
    expect(run?.status).toBe('failed')
  })

  it.each([
    ['before its file removals: nothing at all is touched', 'files', true],
    ['after its file removals: the restore database, the runs and maintenance are left alone', 'shared-state', false],
  ] as const)('start-up cleanup that loses its lock %s while another holder has it (3d item 4, ruling P5, fix round 1)', async (_, stage, workDirKept) => {
    const env = testOpsEnv(t.url)
    const live = databaseName(t.url)
    mkdirSync(path.join(env.backupDir, '.work-abc'))
    await startBackupRun(t.db, 'manual')
    await createEmptyDatabase(t.url, `${live}_restore`)
    const restoring: MaintenanceState = { reason: 'restore', message: 'another restore', since: new Date().toISOString(), backupName: 'x.zip' }
    await setMaintenance(t.db, restoring)
    const other: { release?: () => Promise<void> } = {}
    const logs = (['warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined))
    try {
      await cleanupBackupLeftovers(env, {
        testOnly: {
          beforeLiveCheck: async (at) => {
            if (at !== stage) return
            await loseOpsLock(env.databaseUrl, 'backup')
            other.release = await holdOpsLock(env.databaseUrl, 'backup')
          },
        },
      })
      expect(other.release).toBeDefined()
      expect(readdirSync(env.backupDir).includes('.work-abc')).toBe(workDirKept)
      expect(await listDatabases(t.url, `${live}_restore`)).toEqual([`${live}_restore`])
      const [run] = await t.db.select().from(backupRuns)
      expect(run?.status).toBe('running')
      expect(await getMaintenance(t.db)).toEqual(restoring)
    } finally {
      for (const spy of logs) spy.mockRestore()
      await other.release?.()
      await dropDatabase(t.url, `${live}_restore`)
    }
  })
})
