import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { describeError, describeFsError, OpsBusyError, restoreBackup, setLastRestore, validateBackup, VALIDATION_WORK_PREFIX, withOpsLock, type Db, type OpsEnv, type RestoreOptions } from '@mylib/db'
import { backupFileName, DomainError } from '@mylib/domain'
import type { MaintenanceGate } from '../maintenance'

export interface RestoreRunnerDeps {
  ops: OpsEnv
  gate: MaintenanceGate
  db: Db
  /** tests: 0 (no worker) */
  workerPauseTimeoutMs?: number
  /** tests: hooks passed straight through to restoreBackup, read fresh on every run (so a test can arm one right before calling start()) */
  hooks?: () => RestoreOptions['hooks']
}

/**
 * One restore at a time, in this process (plan deviation 1).
 * - The file is validated before answering, so a bad file is refused on the spot.
 * - The restore itself then runs in the background while the gate shows the maintenance page.
 * - The backup lock inside restoreBackup also keeps the worker's backups out.
 *
 * Deviation (ruling R7): every way `start()` can fail — a restore already running in this process, a
 * backup running elsewhere, or a validation failure — records a failed `last_restore` outcome before
 * rethrowing, not only a failure inside the background `run()`. Otherwise an admin who reloads the
 * Backups page later has no idea why nothing happened. (Fix round 1 — R7: a failure from *inside*
 * `restoreBackup` itself, including a lock held by a concurrent backup or restore in another process,
 * is instead recorded by `restoreBackup` — see packages/db/src/ops/restore.ts — so it is never
 * double-recorded here.)
 */
export class RestoreRunner {
  private busy = false
  private running: Promise<void> = Promise.resolve()
  private closing = false

  constructor(private readonly deps: RestoreRunnerDeps) {}

  /** Final fix 2: a graceful shutdown has begun — every later start() is refused; one already running finishes. */
  stopAccepting(): void {
    this.closing = true
  }

  /**
   * `knownName` is the backup's real file name when the caller already knows it (restoring from the
   * list): pass it, so recording never needs to wait for the manifest. Left out for an upload, whose
   * only name up to this point is a uuid temp filename that must never reach an admin (ruling R10) —
   * `backupName` stays the neutral placeholder below until the manifest is read.
   */
  async start(zipFile: string, options: { deleteAfter: boolean; knownName?: string }): Promise<{ backupName: string }> {
    let backupName = options.knownName ?? 'uploaded backup'
    if (this.closing) {
      const error = new DomainError('CONFLICT', 'My Library is shutting down. Try again once it is back.')
      await this.recordFailure(backupName, error.message)
      throw error
    }
    if (this.busy || this.deps.gate.state !== null) {
      const error = new DomainError('CONFLICT', 'A restore is already running')
      await this.recordFailure(backupName, error.message)
      throw error
    }
    this.busy = true
    try {
      // final fix 6: probe the backup lock itself (never waiting), not a backup_run row a dead process may have left 'running'
      try {
        await withOpsLock(this.deps.ops.databaseUrl, 'backup', () => Promise.resolve())
      } catch (error) {
        if (error instanceof OpsBusyError) throw new DomainError('CONFLICT', 'A backup is running. Try again when it finishes.')
        throw error
      }
      const work = await mkdtemp(path.join(this.deps.ops.backupDir, VALIDATION_WORK_PREFIX))
      try {
        const validated = await validateBackup(this.deps.ops, zipFile, work)
        // Ruling R10: an upload's display name becomes the manifest-derived name once it's known; a
        // restore from the list already had its real name from the start (`knownName`).
        backupName = options.knownName ?? backupFileName(validated.manifest.appVersion, new Date(validated.manifest.createdAt), validated.manifest.kind)
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    } catch (error) {
      this.busy = false
      await this.recordFailure(backupName, describeFsError(error))
      throw error
    }
    this.running = this.run(zipFile, backupName, options.deleteAfter)
    return { backupName }
  }

  /** Resolves once no restore is running (tests, and a graceful shutdown). */
  idle(): Promise<void> {
    return this.running
  }

  private async recordFailure(backupName: string, error: string): Promise<void> {
    await setLastRestore(this.deps.db, { ok: false, backupName, preRestoreBackup: null, error, at: new Date().toISOString() }).catch((recordError: unknown) => {
      console.error('[restore] could not record the failed restore:', describeError(recordError))
    })
  }

  private async run(zipFile: string, backupName: string, deleteAfter: boolean): Promise<void> {
    try {
      const hooks = this.deps.hooks?.()
      const summary = await restoreBackup(this.deps.ops, {
        zipFile,
        displayName: backupName,
        control: this.deps.gate.control(),
        // exactOptionalPropertyTypes: only set `hooks`/`workerPauseTimeoutMs` when there's a real value
        ...(hooks === undefined ? {} : { hooks }),
        ...(this.deps.workerPauseTimeoutMs === undefined ? {} : { workerPauseTimeoutMs: this.deps.workerPauseTimeoutMs }),
      })
      console.log(`[restore] restored ${summary.backupName}: ${summary.counts.works} books, ${summary.counts.covers} covers`)
    } catch (error) {
      // recorded in system_state.last_restore by restoreBackup; the Backups page shows it
      console.error('[restore] failed:', describeError(error))
    } finally {
      this.busy = false
      if (deleteAfter) await rm(zipFile, { force: true }).catch(() => undefined)
    }
  }
}
