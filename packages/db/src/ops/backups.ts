import { mkdtemp, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import {
  BACKUP_FORMAT,
  backupFileName,
  DEFAULT_RETENTION,
  notFound,
  parseBackupFileName,
  planPrune,
  type BackupFileInfo,
  type BackupKind,
  type BackupManifest,
} from '@mylib/domain'
import { createDb, OPS_CLOSE_TIMEOUT_SECONDS, type Db } from '../client'
import { failRunningBackupRuns, finishBackupRun, getBackupRetention, getMaintenance, setMaintenance, startBackupRun } from '../repos/system'
import { assets } from '../schema'
import { isSafeRelativePath, verifyBackupZip, writeBackupZip } from './backup-file'
import { databaseName, dropDatabase, listDatabases, OpsBusyError, OpsLockLostError, withOpsLock, type OpsLockGuard } from './database-admin'
import type { OpsEnv } from './env'
import { describeError, exists, syncDir, withTimeLimit } from './fs-utils'
import { lastAppliedMigration } from './migrations'

/** Rows describing this install's live operations, not its data (plan deviation 9). */
export const EXCLUDED_TABLE_DATA = ['public.backup_run', 'public.system_state'] as const
export const UPLOADS_DIR = 'uploads'
const WORK_PREFIX = '.work-'
const RESTORE_WORK_PREFIX = '.restore-'
/**
 * Final fix 6: a backup file being checked before a restore starts (RestoreRunner.start, the upload route).
 * That runs outside the backup lock, so start-up cleanup in another process removes these only once stale.
 */
export const VALIDATION_WORK_PREFIX = '.validate-'
const PREV_ASSETS_PREFIX = '.prev-'
/** An upload (a backup file being received for a manual restore), or a validation, with no activity this long is abandoned. */
const UPLOAD_MAX_AGE_MS = 3_600_000

export interface BackupResult {
  name: string
  sizeBytes: number
  manifest: BackupManifest
  pruned: string[]
}

export interface BackupHooks {
  /** tests: runs between writing the temp zip and verifying it */
  afterZipWritten?: (tmpFile: string) => Promise<void>
}

export function uploadFilePath(backupDir: string, uploadId: string): string {
  return path.join(backupDir, UPLOADS_DIR, `${uploadId}.zip`)
}

export async function hasTable(db: Db, name: string): Promise<boolean> {
  const rows = await db.execute<{ present: boolean }>(sql`select to_regclass(${`public.${name}`}) is not null as present`)
  return rows[0]?.present === true
}

async function freeName(dir: string, appVersion: string, at: Date, kind: BackupKind): Promise<string> {
  for (let offset = 0; ; offset++) {
    const name = backupFileName(appVersion, new Date(at.getTime() + offset * 1000), kind)
    if (!(await exists(path.join(dir, name))) && !(await exists(path.join(dir, `${name}.tmp`)))) return name
  }
}

/** asset.path values whose file is on disk. A missing file is left out and counted, never named in the log. */
async function referencedAssets(db: Db, assetsDir: string): Promise<{ paths: string[]; missing: number }> {
  const rows = await db.selectDistinct({ path: assets.path }).from(assets)
  const paths: string[] = []
  let missing = 0
  for (const row of rows) {
    if (isSafeRelativePath(row.path) && (await exists(path.join(assetsDir, ...row.path.split('/'))))) paths.push(row.path)
    else missing++
  }
  return { paths: paths.sort(), missing }
}

/**
 * 3d item 6: unpatched postgres.js 3.4.9, once a connection closed under a running query, retries a later
 * query's connect for as long as the server answers it with an error (a restarting Postgres's 57P03, say),
 * so recording the run after the database dropped could wait for good. Past this limit the run is left as
 * it is (start-up cleanup fails a run left 'running'), and the bounded close ends the connection.
 *
 * patches/postgres@3.4.9.patch (3d Task 7) fixes the driver: such a query now fails at once with the
 * server's error, which also covers pruneAfterSuccess's unbounded queries on this handle. The limit stays
 * as defence in depth.
 */
const RUN_RECORD_LIMIT_MS = 5_000

export interface CreateBackupOptions extends PruneOptions {
  /** 3d item 4: the lock this backup runs under: its signal stops pg_dump/pg_restore, and assertHeld guards the rename and the pruning */
  lock?: Pick<OpsLockGuard, 'signal' | 'assertHeld'>
}

export async function runBackup(env: OpsEnv, kind: BackupKind, options: { wait?: boolean; hooks?: BackupHooks } = {}): Promise<BackupResult> {
  return withOpsLock(env.databaseUrl, 'backup', (guard) => createBackupLocked(env, kind, options.hooks, { lock: guard }), { wait: options.wait ?? false })
}

/**
 * Spec §4 "Writing": `<name>.tmp` in BACKUP_DIR → fsync → verify → rename → fsync the directory. A failure
 * up to and including that rename deletes the temp file and records the run as failed. The caller holds
 * the backup lock (runBackup, or a restore taking its pre-restore backup).
 *
 * Controller ruling R4: everything that can throw before the rename — including `mkdtemp`/`freeName`
 * against a BACKUP_DIR that is missing or unwritable — runs where a thrown error is caught, so any such
 * failure still closes the DB pool this function opened (the `finally`) and, once a run row exists,
 * marks it failed rather than leaving it 'running' forever.
 *
 * Controller ruling R22: once the zip is verified and renamed into place, the backup itself has already
 * succeeded — nothing that runs afterward (recording the run, statting its size, pruning) may turn it
 * into a failure. Each of those steps is wrapped so its own error is logged (by kind, never by echoing a
 * file path) and swallowed; none of them call `finishBackupRun('failed', …)` and none reject `runBackup`.
 *
 * 3d item 4 (decision 3): with `options.lock`, a lost lock stops pg_dump and the verification, and the
 * zip is renamed into place, and older backups pruned, only after a live check that the lock is held.
 * A failure once the lock is gone is reported as the OpsLockLostError it really is.
 */
export async function createBackupLocked(env: OpsEnv, kind: BackupKind, hooks?: BackupHooks, options: CreateBackupOptions = {}): Promise<BackupResult> {
  const signal = options.lock?.signal
  const now = env.now?.() ?? new Date()
  const handle = createDb(env.databaseUrl, { max: 1 })
  const db = handle.db
  let runId: string | null = null
  let work: string | undefined
  let tmp: string | undefined

  try {
    let name: string
    let manifest: BackupManifest
    try {
      // a pre-upgrade backup can run on a schema older than backup_run
      const recordRuns = await hasTable(db, 'backup_run')
      runId = recordRuns ? await startBackupRun(db, kind) : null
      work = await mkdtemp(path.join(env.backupDir, WORK_PREFIX))
      name = await freeName(env.backupDir, env.appVersion, now, kind)
      tmp = path.join(env.backupDir, `${name}.tmp`)
      const dumpFile = path.join(work, 'db.dump')
      await env.pgTools.dump(env.databaseUrl, dumpFile, { excludeTableData: EXCLUDED_TABLE_DATA, ...(signal === undefined ? {} : { signal }) })
      const lastMigration = await lastAppliedMigration(env.databaseUrl, env.migrationsFolder)
      const covers = await referencedAssets(db, env.assetsDir)
      if (covers.missing > 0) console.warn(`[backup] ${covers.missing} cover file(s) listed in the database were not on disk and are not in this backup`)
      await writeBackupZip(tmp, {
        dumpFile,
        assetsRoot: env.assetsDir,
        assetPaths: covers.paths,
        secretKey: env.appSecretKey,
        manifest: { format: BACKUP_FORMAT, appVersion: env.appVersion, lastMigration, createdAt: now.toISOString(), kind },
      })
      await hooks?.afterZipWritten?.(tmp)
      const verified = await verifyBackupZip(tmp, env.pgTools, work, signal === undefined ? {} : { signal })
      manifest = verified.manifest
      const final = path.join(env.backupDir, name)
      await options.lock?.assertHeld() // 3d item 4 (decision 3): no commit point without the lock
      await rename(tmp, final)
      await syncDir(env.backupDir)
      tmp = undefined // renamed away: a later failure here has nothing left of ours to delete
    } catch (caught) {
      // a pg tool the lost lock stopped fails as 'aborted': report what really happened
      const error: unknown = signal?.aborted === true ? signal.reason : caught
      if (tmp !== undefined) await unlink(tmp).catch(() => undefined)
      // 3d item 6: time-limited, since the failure may be the database dropping (see RUN_RECORD_LIMIT_MS)
      if (runId !== null) await withTimeLimit(finishBackupRun(db, runId, { status: 'failed', error: describeError(error) }), RUN_RECORD_LIMIT_MS, 'recording the failed run').catch(() => undefined)
      throw error
    }

    // From here on (ruling R22) every step below only logs and swallows its own failure.
    let sizeBytes = 0
    try {
      sizeBytes = (await stat(path.join(env.backupDir, name))).size
    } catch (error) {
      console.error(`[backup] could not read the size of the finished ${kind} backup: ${describeError(error)}`)
    }
    if (runId !== null) {
      await withTimeLimit(finishBackupRun(db, runId, { status: 'succeeded', fileName: name, sizeBytes }), RUN_RECORD_LIMIT_MS, 'recording the run').catch((error: unknown) => {
        console.error(`[backup] could not record the successful ${kind} run: ${describeError(error)}`)
      })
    }
    let pruned: string[] = []
    try {
      // 3d item 4: pruning deletes shared files and databases, so it too needs the lock
      await options.lock?.assertHeld()
      pruned = await pruneAfterSuccess(env, db, options)
    } catch (error) {
      if (error instanceof OpsLockLostError) console.warn(`[backup] the lock was lost after the ${kind} backup was saved; pruning skipped`)
      else console.error(`[backup] pruning after a successful ${kind} backup failed; older backups were left in place`)
    }
    return { name, sizeBytes, manifest, pruned }
  } finally {
    if (work !== undefined) {
      await rm(work, { recursive: true, force: true }).catch((error: unknown) => console.error(`[backup] could not remove the work directory: ${describeError(error)}`))
    }
    // 3d item 6: bounded, or a connection dropped under one of its queries would hang start-up here
    await handle.close(OPS_CLOSE_TIMEOUT_SECONDS).catch((error: unknown) => console.error(`[backup] could not close the database connection: ${describeError(error)}`))
  }
}

export async function listBackupFiles(dir: string): Promise<BackupFileInfo[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const info = parseBackupFileName(name)
    return info === null ? [] : [info]
  })
}

export interface BackupListItem {
  name: string
  kind: BackupKind
  appVersion: string
  createdAt: Date
  sizeBytes: number
  /** only verified backups are ever renamed into place (plan deviation 10) */
  verified: true
}

export async function listBackups(dir: string): Promise<BackupListItem[]> {
  const items = await Promise.all(
    (await listBackupFiles(dir)).map(async (file): Promise<BackupListItem | null> => {
      try {
        const info = await stat(path.join(dir, file.name))
        return { ...file, sizeBytes: info.size, verified: true }
      } catch (error) {
        // gone between the readdir and this stat (pruned, or deleted by another process) — just skip it
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }),
  )
  return items.filter((item): item is BackupListItem => item !== null).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.name.localeCompare(a.name))
}

export interface PruneOptions {
  /** backup file names never pruned: a restore protects the backup it is restoring (controller ruling R23) */
  protect?: readonly string[]
}

/** Runs only after a successful backup (spec §4). */
export async function pruneAfterSuccess(env: OpsEnv, db: Db, options: PruneOptions = {}): Promise<string[]> {
  const retention = (await hasTable(db, 'backup_settings')) ? await getBackupRetention(db) : DEFAULT_RETENTION
  const protect = new Set(options.protect ?? [])
  const doomed = planPrune(await listBackupFiles(env.backupDir), retention).filter((name) => !protect.has(name))
  for (const name of doomed) await unlink(path.join(env.backupDir, name)).catch(() => undefined)
  await dropPreviousRestores(env)
  return doomed
}

/** Spec §4 step 9: `<live>_prev_*` databases, and the `assets/.prev-*` folders, go once a newer backup exists. */
export async function dropPreviousRestores(env: OpsEnv): Promise<void> {
  for (const name of await listDatabases(env.databaseUrl, `${databaseName(env.databaseUrl)}_prev_`)) await dropDatabase(env.databaseUrl, name)
  const entries = await readdir(env.assetsDir).catch(() => [] as string[])
  for (const entry of entries) {
    if (entry.startsWith(PREV_ASSETS_PREFIX)) await rm(path.join(env.assetsDir, entry), { recursive: true, force: true })
  }
}

/** Only a finished backup's own name resolves; anything else (a path, a .tmp) is null. */
export function backupFilePath(dir: string, name: string): string | null {
  return parseBackupFileName(name) === null ? null : path.join(dir, name)
}

export async function deleteBackup(dir: string, name: string): Promise<void> {
  const full = backupFilePath(dir, name)
  if (full === null || !(await exists(full))) throw notFound('Backup')
  await unlink(full)
}

async function isStale(full: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(full)).mtimeMs > UPLOAD_MAX_AGE_MS
  } catch {
    return false
  }
}

/** `<name>.tmp` where `<name>` is a backup file name of ours — never a `.tmp` some other process left. */
function isOurTempFile(entry: string): boolean {
  return entry.endsWith('.tmp') && parseBackupFileName(entry.slice(0, -'.tmp'.length)) !== null
}

/**
 * Start-up, in the app and the worker: removes what a killed backup or restore left behind. That is our
 * own temp zips, work folders, uploads that look abandoned, a half-built `<live>_restore` database, runs
 * still marked running, and a restore's maintenance flag (restores run in-process, so a restart means it
 * died). Skipped while another process holds the backup lock. This never throws — a step it cannot
 * complete is logged (by count, never by path) and the rest still runs.
 *
 * 3d item 4 (ruling P5, fix round 1): the files, the restore database, the run rows and the maintenance
 * flag may belong to another process once our lock is gone. A live check that it is held runs before the
 * file removals, and again before the shared-state writes; once it fails, nothing more is touched.
 */
export async function cleanupBackupLeftovers(
  env: OpsEnv,
  options: { /** tests only, never production code: runs right before each live check */ testOnly?: { beforeLiveCheck?: (stage: 'files' | 'shared-state') => Promise<void> } } = {},
): Promise<{ removed: number }> {
  try {
    return await withOpsLock(env.databaseUrl, 'backup', async (guard) => {
      const stillHeld = async (stage: 'files' | 'shared-state'): Promise<boolean> => {
        await options.testOnly?.beforeLiveCheck?.(stage)
        try {
          await guard.assertHeld()
          return true
        } catch {
          console.warn(`[backup] start-up cleanup: the lock was lost; ${stage === 'files' ? 'nothing' : 'the restore database, backup runs and maintenance'} was touched`)
          return false
        }
      }
      if (!(await stillHeld('files'))) return { removed: 0 }
      let removed = 0
      for (const entry of await readdir(env.backupDir).catch(() => [] as string[])) {
        const ours = isOurTempFile(entry) || entry.startsWith(WORK_PREFIX) || entry.startsWith(RESTORE_WORK_PREFIX)
        if (ours || (entry.startsWith(VALIDATION_WORK_PREFIX) && (await isStale(path.join(env.backupDir, entry))))) {
          try {
            await rm(path.join(env.backupDir, entry), { recursive: true, force: true })
            removed++
          } catch (error) {
            console.error(`[backup] start-up cleanup: could not remove a leftover entry: ${describeError(error)}`)
          }
        }
      }
      const uploads = path.join(env.backupDir, UPLOADS_DIR)
      let uploadErrors = 0
      for (const entry of await readdir(uploads).catch(() => [] as string[])) {
        const full = path.join(uploads, entry)
        try {
          const info = await stat(full)
          if (!info.isFile()) continue // never touch a directory in uploads/
          // final fix 6: a `.tmp` may still be streaming in the app while the worker starts — only its age says it's abandoned
          if (Date.now() - info.mtimeMs > UPLOAD_MAX_AGE_MS) {
            await rm(full, { force: true })
            removed++
          }
        } catch (error) {
          // gone between the readdir and this stat (finished and moved, or removed already) — not an error
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') uploadErrors++
        }
      }
      if (uploadErrors > 0) console.error(`[backup] start-up cleanup: could not check ${uploadErrors} upload(s)`)
      if (!(await stillHeld('shared-state'))) return { removed }
      try {
        await dropDatabase(env.databaseUrl, `${databaseName(env.databaseUrl)}_restore`)
      } catch (error) {
        console.error(`[backup] start-up cleanup: could not drop the half-built restore database: ${describeError(error)}`)
      }
      const handle = createDb(env.databaseUrl, { max: 1 })
      try {
        if (await hasTable(handle.db, 'backup_run')) await failRunningBackupRuns(handle.db, 'Interrupted: the process stopped during this backup')
        if ((await hasTable(handle.db, 'system_state')) && (await getMaintenance(handle.db))?.reason === 'restore') await setMaintenance(handle.db, null)
      } catch (error) {
        console.error(`[backup] start-up cleanup: could not update run or maintenance state: ${describeError(error)}`)
      } finally {
        await handle.close(OPS_CLOSE_TIMEOUT_SECONDS).catch(() => undefined)
      }
      return { removed }
    })
  } catch (error) {
    if (error instanceof OpsBusyError) return { removed: 0 }
    console.error(`[backup] start-up cleanup failed: ${describeError(error)}`)
    return { removed: 0 }
  }
}
