import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { backupStamp, isWellFormedSecretKey, type BackupManifest, type MaintenanceState, type RestoreCounts, type RestoreSummary } from '@mylib/domain'
import { createDb, OPS_CLOSE_TIMEOUT_SECONDS, type Db } from '../client'
import { failRunningRuns } from '../repos/job-runs'
import { resealSourceSecrets } from '../repos/sources'
import { setLastRestore, setMaintenance, waitForWorkerPause } from '../repos/system'
import { assets } from '../schema'
import { createSecretBox } from '../secrets'
import { BackupInvalidError, copyBackupAssets, verifyBackupZip, type BackupLimits } from './backup-file'
import { createBackupLocked } from './backups'
import { createEmptyDatabase, databaseName, dropDatabase, OpsBusyError, OpsLockLostError, swapInDatabase, withDatabase, withOpsLock } from './database-admin'
import type { OpsEnv } from './env'
import { describeError, describeFsError, sleep } from './fs-utils'
import { applyMigrations, readJournal } from './migrations'

export interface ValidatedBackup {
  manifest: BackupManifest
  /** the dump extracted into the caller's work folder */
  dumpFile: string
  secretKey: string
}

/**
 * Restore step 2 (spec §4):
 * - the manifest is present and its format is known;
 * - every sha256 matches and the dump is readable;
 * - the key is well formed;
 * - the backup's last migration is one this image knows. A newer backup is refused.
 *
 * `limits.statfs` is test-only injection (fix round 1, ruling R26): production never passes it, so the
 * free-space check always uses the real disk (see checkFreeSpace / NotEnoughSpaceError in backup-file.ts).
 */
export async function validateBackup(env: OpsEnv, zipFile: string, workDir: string, limits: BackupLimits = {}): Promise<ValidatedBackup> {
  const verified = await verifyBackupZip(zipFile, env.pgTools, workDir, limits)
  if (!isWellFormedSecretKey(verified.secretKey)) throw new BackupInvalidError('The secret key in the backup is damaged')
  const known = readJournal(env.migrationsFolder).some((entry) => entry.when === verified.manifest.lastMigration.when)
  if (!known) {
    throw new BackupInvalidError(`This backup is from a newer version of My Library (${verified.manifest.appVersion}). Run that version or newer to restore it.`)
  }
  return verified
}

/** How the process running the restore stops and resumes its own work (the app's MaintenanceGate; nothing for the CLI). */
export interface MaintenanceControl {
  enter(state: MaintenanceState): Promise<void>
  leave(): void
}

export const noMaintenanceControl: MaintenanceControl = { enter: () => Promise.resolve(), leave: () => undefined }

export interface RestoreOptions {
  zipFile: string
  control: MaintenanceControl
  /**
   * Shown to the admin (in the maintenance message, the summary and a failed outcome) instead of
   * `zipFile`'s own basename. Deviation (task 11, ruling R10): an uploaded backup is received under a
   * uuid temp file name (`uploads/<uuid>.zip`), which must never be what the admin sees — the app passes
   * the manifest-derived `my-library-<version>-<stamp>-<kind>.zip` name here instead. Defaults to
   * `zipFile`'s basename, which is already the real name for a backup restored from the list, or the CLI.
   */
  displayName?: string
  /** default true; the CLI can skip it when the live database is unusable */
  preRestoreBackup?: boolean
  /** how long to wait for the worker's acknowledgement (default DEFAULT_WORKER_PAUSE_TIMEOUT_MS; a stopped worker never answers) */
  workerPauseTimeoutMs?: number
  /** tests only, never production code: shorten the clean-up's re-take window after a lost lock */
  testOnly?: { retakeWithinMs?: number; retakePollMs?: number }
  /** tests: inject failures between the steps of the restore */
  hooks?: {
    afterPgRestore?: () => Promise<void>
    /** runs inside the re-seal transaction, after the secrets are re-sealed and before it commits */
    afterReseal?: () => Promise<void>
    /** runs right after the swap; its failure must not fail the restore */
    afterSwap?: () => Promise<void>
  }
}

/** Controller ruling R8: longer than the worker's graceful pg-boss stop (45 s), so a working worker always answers in time. */
export const DEFAULT_WORKER_PAUSE_TIMEOUT_MS = 50_000

async function withDb<T>(url: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const handle = createDb(url, { max: 1 })
  try {
    return await fn(handle.db)
  } finally {
    // 3d item 6: bounded, so a dropped connection never holds a restore (and the shutdown waiting on it) open
    await handle.close(OPS_CLOSE_TIMEOUT_SECONDS)
  }
}

async function restoreCounts(db: Db): Promise<RestoreCounts> {
  const [row] = await db.execute<RestoreCounts>(sql`select
    (select count(*)::int from work) as works,
    (select count(*)::int from edition) as editions,
    (select count(*)::int from reading_session) as sessions,
    (select count(*)::int from proposal) as proposals,
    (select count(*)::int from source) as sources,
    (select count(*)::int from asset where kind = 'cover') as covers`)
  if (!row) throw new Error('The restored database could not be counted')
  return row
}

export const INTERRUPTED_BY_RESTORE = 'Interrupted: the backup was taken while this was running, and was then restored'

/**
 * Final fix 6: the backup may have caught a sync mid-run, or a pg-boss job (a backup, say) active. In the
 * restored database nothing is running them, so they are failed before the swap: otherwise a ghost
 * "running" sync or an active stately backup job would block the next one. pg-boss's own table is only
 * touched when it exists (a backup from before the worker ever started has none). pg-boss's cached list of
 * active singleton keys is cleared too (its monitor recomputes it).
 */
async function settleInterruptedWork(db: Db): Promise<void> {
  await failRunningRuns(db, INTERRUPTED_BY_RESTORE)
  const [row] = await db.execute<{ present: boolean }>(sql`select to_regclass('pgboss.job') is not null as present`)
  if (row?.present !== true) return
  await db.execute(sql`update pgboss.job set state = 'failed', completed_on = now(), output = ${JSON.stringify({ message: INTERRUPTED_BY_RESTORE })}::jsonb where state = 'active'`)
  // 3d item 2: pg-boss 12 caches active stately keys per queue (`singletons_active`) and `fetch` skips them.
  // The restored cache would still list the job failed above. Nulling it fixes what a NEW pg-boss instance
  // sees; a worker that is already running keeps its in-process queue cache for up to 60 s.
  const [cache] = await db.execute<{ present: boolean }>(
    sql`select exists (select 1 from information_schema.columns where table_schema = 'pgboss' and table_name = 'queue' and column_name = 'singletons_active') as present`,
  )
  if (cache?.present === true) await db.execute(sql`update pgboss.queue set singletons_active = null`)
}

/** After the swap: covers the restored database does not reference move to `assets/<aside>/` (plan deviation 7). */
async function moveUnreferencedAssets(assetsDir: string, keep: ReadonlySet<string>, aside: string): Promise<number> {
  let moved = 0
  let entries: string[]
  try {
    entries = await readdir(path.join(assetsDir, 'covers'), { recursive: true })
  } catch (error) {
    // no covers folder at all: nothing to move. Any other error is the caller's to log.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  for (const entry of entries) {
    const rel = `covers/${entry.split(path.sep).join('/')}`
    const full = path.join(assetsDir, 'covers', entry)
    if (rel.endsWith('.tmp') || keep.has(rel) || !(await stat(full)).isFile()) continue
    const target = path.join(assetsDir, aside, ...rel.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await rename(full, target)
    moved++
  }
  return moved
}

/**
 * 3d item 4 (decision 3, ruling P5): after the lock was lost, `<live>_restore` and the maintenance flag
 * may already belong to another backup or restore. They are touched only under a re-taken lock, all at
 * once; while someone else holds it, none of them is (start-up cleanup handles whatever a dead process
 * leaves). The lost lock's own session was ended before the guard aborted (ruling P8).
 *
 * 3d final fix (review #3): that end gives up after 5 s and only destroys the client socket, so the old
 * backend may still be exiting, and holding the lock, a moment longer. A held lock is therefore tried
 * again every `pollMs` for up to `withinMs` before it counts as another backup or restore's.
 */
async function underRetakenLock(env: OpsEnv, steps: readonly { what: string; run: () => Promise<unknown> }[], retake: { withinMs: number; pollMs: number }): Promise<void> {
  if (steps.length === 0) return
  const what = steps.map((step) => step.what).join(' and ')
  const deadline = Date.now() + retake.withinMs
  for (;;) {
    try {
      await withOpsLock(env.databaseUrl, 'backup', async () => {
        for (const step of steps) {
          try {
            await step.run()
          } catch (error) {
            console.error(`[restore] ${step.what} failed: ${describeError(error)}`)
          }
        }
      })
      return
    } catch (error) {
      if (!(error instanceof OpsBusyError)) {
        console.error(`[restore] could not re-take the lock for ${what}: ${describeError(error)}`)
        return
      }
      if (Date.now() >= deadline) {
        console.warn(`[restore] the lock was lost and another backup or restore still held it after ${retake.withinMs / 1000} s; ${what} was left alone`)
        return
      }
    }
    await sleep(retake.pollMs)
  }
}

/** 3d final fix (review #3): how long the clean-up after a lost lock keeps trying to re-take it, and how often. */
export const RESTORE_RETAKE_WITHIN_MS = 15_000
export const RESTORE_RETAKE_POLL_MS = 500

/**
 * Spec §4 restore, holding the backup lock throughout:
 * 1. validate;
 * 2. enter maintenance, in this process and in `system_state`, and wait for the worker;
 * 3. take the pre-restore backup;
 * 4. `pg_restore` into `<live>_restore`, then migrate;
 * 5. re-seal the secrets, in one transaction;
 * 6. merge the covers in;
 * 7. swap the databases;
 * 8. move unused covers aside;
 * 9. record the summary and leave maintenance.
 *
 * Steps 4–6 only ever touch `<live>_restore` and the asset store. A failure before the swap leaves the
 * live database's data untouched: it records the failure there and drops the half-built restore database.
 * After the swap nothing rejects: later failures are logged and the summary is returned (ruling R22).
 * The backup being restored is never pruned by the pre-restore backup (ruling R23).
 *
 * 3d item 4: a lost lock stops the pg tools (the guard's signal), and a live check precedes each write
 * to shared state: entering maintenance, building `<live>_restore`, and the swap (which re-checks inside
 * its own rename transaction). After a lost lock, clean-up of shared state runs only under a re-taken lock.
 */
export async function restoreBackup(env: OpsEnv, options: RestoreOptions): Promise<RestoreSummary> {
  // Ruling R26: the file actually being restored is protected from pruning by its own name — independent
  // of `displayName`, which only changes what the admin sees (an uploaded backup's uuid temp name, say).
  const fileName = path.basename(options.zipFile)
  const backupName = options.displayName ?? fileName
  // Ruling R7 (fix round 2): set the moment the inner catch below records — or, once `swapped` is true,
  // deliberately decides not to (ruling R22: never overwrite a summary that's about to be returned) — so
  // the outer catch, which exists only to record what never reached the inner try at all (the lock itself
  // refused, busy or not), never double-records what the inner one already handled.
  // A plain `let` here defeats @typescript-eslint/no-unnecessary-condition below: TS narrows a captured
  // variable to its initial literal at the outer catch, not accounting for the inner callback's own
  // reassignment happening first — a mutable box sidesteps that (property reads/writes aren't narrowed
  // the same way).
  const recorded = { value: false }
  try {
    return await withOpsLock(env.databaseUrl, 'backup', async (guard) => {
      // Fix round 2 (R7 gap): mkdtemp, databaseName and reading the clock used to run here, before this
      // try, so a failure among them was never recorded anywhere. `restoreName`/`work` are declared here
      // (not `const`) only so the catch/finally below can still see them even when they're never
      // assigned (a failure before that line); each gets a `const` alias right after its real assignment
      // so nothing further down loses that narrowing inside a closure (a `let`, even one only ever
      // assigned once, stays possibly-`undefined` there, unlike a `const`).
      let restoreName: string | undefined
      let work: string | undefined
      let preRestoreBackup: string | null = null
      let controlEntered = false
      let entered = false
      let swapped = false
      // 3d item 4 (ruling P1): set by the catch for a loss the guard or the swap found; a box, like `recorded`
      const lockLost = { value: false }
      try {
        const now = env.now ?? (() => new Date())
        const startedAt = now()
        const live = databaseName(env.databaseUrl)
        restoreName = `${live}_restore`
        const restoreDbName = restoreName
        const prevName = `${live}_prev_${backupStamp(startedAt).toLowerCase()}`
        work = await mkdtemp(path.join(env.backupDir, '.restore-'))
        const workDir = work
        const state: MaintenanceState = {
          reason: 'restore',
          message: `Restoring ${backupName}. This takes a few minutes; the page reloads by itself when it is done.`,
          since: startedAt.toISOString(),
          backupName,
        }

        const validated = await validateBackup(env, options.zipFile, workDir, { signal: guard.signal })

        await guard.assertHeld()
        controlEntered = true
        await options.control.enter(state)
        entered = true
        const pauseTimeoutMs = options.workerPauseTimeoutMs ?? DEFAULT_WORKER_PAUSE_TIMEOUT_MS
        const workerPaused = await withDb(env.databaseUrl, async (db) => {
          await setMaintenance(db, state)
          return waitForWorkerPause(db, startedAt, pauseTimeoutMs)
        })
        if (!workerPaused) {
          // ruling R8: go on. A worker still stopping only writes sync results and covers, which the next sync redoes.
          console.warn(`[restore] the worker did not confirm it paused within ${Math.round(pauseTimeoutMs / 1000)} s; restoring anyway`)
        }
        // ruling R23 (and R26): the pre-restore backup's pruning never deletes the file being restored,
        // matched by its own real name — never by `displayName`, which may be a different, cosmetic name
        // (an uploaded backup's manifest-derived name, say) that doesn't exist on disk at all.
        const protect = path.relative(path.resolve(env.backupDir), path.resolve(options.zipFile)) === fileName ? [fileName] : []
        if (options.preRestoreBackup !== false) preRestoreBackup = (await createBackupLocked(env, 'pre-restore', undefined, { protect, lock: guard })).name

        // `<live>_restore` may be another restore's once the lock is gone: never drop or build it without the lock
        await guard.assertHeld()
        await createEmptyDatabase(env.databaseUrl, restoreDbName)
        const restoreUrl = withDatabase(env.databaseUrl, restoreDbName)
        await env.pgTools.restore(restoreUrl, validated.dumpFile, { signal: guard.signal })
        await options.hooks?.afterPgRestore?.()
        const migrationsApplied = await applyMigrations(restoreUrl, env.migrationsFolder, { signal: guard.signal, beforeEach: () => guard.assertHeld() })
        const staged = await withDb(restoreUrl, async (db) => {
          const secrets = await db.transaction(async (tx) => {
            const result = await resealSourceSecrets(tx, createSecretBox(validated.secretKey), createSecretBox(env.appSecretKey))
            await options.hooks?.afterReseal?.()
            await settleInterruptedWork(tx)
            // the worker reconnects to this database after the swap: it must find maintenance still on
            await setMaintenance(tx, state)
            return result
          })
          const rows = await db.selectDistinct({ path: assets.path }).from(assets)
          return { secrets, counts: await restoreCounts(db), keep: new Set(rows.map((r) => r.path)) }
        })
        await copyBackupAssets(options.zipFile, env.assetsDir)

        // a live check here also catches a heartbeat failure whose session is still being ended…
        await guard.assertHeld()
        // …and the swap checks again, before refusing connections and inside its rename transaction
        await swapInDatabase(env.databaseUrl, restoreDbName, prevName, { lockHolder: guard.holder })
        swapped = true

        // Ruling R22 applied to restores: the restored database is live now. Nothing below may fail the
        // restore; each step logs its own failure (never a path or a secret) and the summary is returned.
        const afterSwap = async (what: string, step: () => Promise<unknown>, describe: (error: unknown) => string = describeError): Promise<void> => {
          try {
            await step()
          } catch (error) {
            console.error(`[restore] the restore succeeded, but ${what} failed: ${describe(error)}`)
          }
        }
        await afterSwap('the after-swap step', () => options.hooks?.afterSwap?.() ?? Promise.resolve())
        await afterSwap('clearing maintenance on the previous database', () => withDb(withDatabase(env.databaseUrl, prevName), (db) => setMaintenance(db, null)))
        await afterSwap('moving unused covers aside', () => moveUnreferencedAssets(env.assetsDir, staged.keep, `.prev-${backupStamp(startedAt)}`), describeFsError)
        const summary: RestoreSummary = {
          backupName,
          preRestoreBackup,
          counts: staged.counts,
          resealedSecrets: staged.secrets.resealed,
          unreadableSecrets: staged.secrets.unreadable,
          unreadableSources: staged.secrets.unreadableSources,
          migrationsApplied,
          workerPauseUnconfirmed: !workerPaused,
          finishedAt: now().toISOString(),
        }
        await afterSwap('recording the restore', () => withDb(env.databaseUrl, (db) => setLastRestore(db, { ok: true, summary })))
        return summary
      } catch (caught) {
        recorded.value = true
        // a pg tool the lost lock stopped fails as 'aborted': report what really happened. Decided before the
        // live check below, so a failure for another reason is still reported as itself.
        const error: unknown = guard.signal.aborted ? guard.signal.reason : caught
        // ruling P1 and fix round 1: always a live check before any shared-state clean-up. It catches a loss
        // only the swap found, and one nothing noticed yet; either way it marks the guard lost (ending its
        // session, aborting its signal), and the finally takes the re-taken-lock path.
        await guard.assertHeld().catch(() => undefined)
        lockLost.value = guard.signal.aborted || caught instanceof OpsLockLostError
        if (!swapped) {
          // after a lost lock the finally drops it, under a re-taken lock
          if (restoreName !== undefined && !lockLost.value) {
            await dropDatabase(env.databaseUrl, restoreName).catch((dropError: unknown) => {
              console.error('[restore] could not drop the half-built restore database:', describeError(dropError))
            })
          }
          await withDb(env.databaseUrl, (db) => setLastRestore(db, { ok: false, backupName, preRestoreBackup, error: describeFsError(error), at: (env.now ?? (() => new Date()))().toISOString() })).catch(
            (recordError: unknown) => {
              console.error('[restore] could not record the failed restore:', describeError(recordError))
            },
          )
        }
        throw error
      } finally {
        const clearMaintenance = () => withDb(env.databaseUrl, (db) => setMaintenance(db, null))
        if (lockLost.value || guard.signal.aborted) {
          // decision 3: shared state only under a re-taken lock, all of it or none
          const name = swapped ? undefined : restoreName
          await underRetakenLock(env, [
            ...(name === undefined ? [] : [{ what: 'dropping the half-built restore database', run: () => dropDatabase(env.databaseUrl, name) }]),
            ...(entered ? [{ what: 'clearing maintenance', run: clearMaintenance }] : []),
          ], { withinMs: options.testOnly?.retakeWithinMs ?? RESTORE_RETAKE_WITHIN_MS, pollMs: options.testOnly?.retakePollMs ?? RESTORE_RETAKE_POLL_MS })
        } else if (entered) {
          await clearMaintenance().catch((error: unknown) => {
            console.error('[restore] could not clear maintenance:', describeError(error))
          })
        }
        // this process's own state: always
        if (controlEntered) {
          try {
            options.control.leave()
          } catch (error) {
            console.error('[restore] could not leave maintenance in this process:', describeError(error))
          }
        }
        if (work !== undefined) {
          await rm(work, { recursive: true, force: true }).catch((error: unknown) => {
            console.error('[restore] could not remove the work directory:', describeFsError(error))
          })
        }
      }
    })
  } catch (error) {
    // Ruling R7 (fix round 2): whatever reaches here that the inner catch above never got a chance to
    // record — the lock itself refused (busy, or for any other reason: a bad connection, say) — is
    // recorded here, exactly once. `recorded` is only ever set by the inner catch, so this never
    // double-records an error that already went through it and was rethrown (which is the common case:
    // the inner catch's own `throw error` is what usually lands here too, via withOpsLock's rejection).
    if (!recorded.value) {
      await withDb(env.databaseUrl, (db) => setLastRestore(db, { ok: false, backupName, preRestoreBackup: null, error: describeFsError(error), at: (env.now ?? (() => new Date()))().toISOString() })).catch(
        (recordError: unknown) => {
          console.error('[restore] could not record the failed restore:', describeError(recordError))
        },
      )
    }
    throw error
  }
}
