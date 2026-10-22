import { cleanupBackupLeftovers, describeError, ensureConnectionsAllowed, failRunningAbsPushRuns, failRunningHardcoverRuns, failRunningRuns, removeStaleTempFiles, waitForPostgres, type Db, type OpsEnv } from '@mylib/db'

export const WORKER_RESTARTED = 'The worker restarted during this sync'
export const WORKER_STOPPED = 'The worker stopped during this sync'

/**
 * At startup, before taking work: any run still "running" was interrupted by a previous worker
 * process. This assumes exactly one worker (docker-compose.yml runs one); with several, a
 * starting worker would fail its siblings' live runs.
 */
export async function recoverInterruptedRuns(db: Db): Promise<number> {
  const hardcover = await failRunningHardcoverRuns(db, WORKER_RESTARTED)
  const absPush = await failRunningAbsPushRuns(db, WORKER_RESTARTED)
  return (await failRunningRuns(db, WORKER_RESTARTED)) + hardcover + absPush
}

export interface PrepareWorkerDeps {
  db: Db
  ops: OpsEnv
  log: (message: string) => void
  /** final fix 3 — tests only: default waitForPostgres, which keeps waiting (logging once a minute) while the database is unreachable */
  waitForDatabase?: (url: string, log: (message: string) => void) => Promise<void>
}

/**
 * Start-up, before taking work.
 * - Final fix 3: an unreachable database (after a power cut, say) is waited for with a log line,
 *   rather than crashing the worker into a restart loop.
 * - Final fix 1: then undo a restore swap interrupted between refusing new connections and the
 *   rename, before anything else connects to the live database.
 */
export async function prepareWorker(deps: PrepareWorkerDeps): Promise<void> {
  await (deps.waitForDatabase ?? ((url, log) => waitForPostgres(url, { log })))(deps.ops.databaseUrl, deps.log)
  await ensureConnectionsAllowed(deps.ops.databaseUrl, deps.log)
  await cleanupBackupLeftovers(deps.ops).catch((error: unknown) => {
    deps.log(`[worker] leftover cleanup failed: ${describeError(error)}`)
  })
  await recoverInterruptedRuns(deps.db)
  await removeStaleTempFiles(deps.ops.assetsDir) // best effort, never throws
}

export interface ShutdownDeps {
  db: Db
  /** stop taking jobs, waiting (bounded) for the one in flight to finish */
  stopWork: () => Promise<unknown>
  close: () => Promise<void>
  exit: (code: number) => void
  /** `error` is set when a step failed (not when it ran out of time) */
  log: (message: string, error?: unknown) => void
  /** tests only: shorter limits for the steps (defaults WORKER_STOP_WORK_MS, WORKER_RECORD_RUN_MS, WORKER_CLOSE_DB_MS) */
  limitsMs?: { stopWork?: number; record?: number; close?: number }
}

/**
 * 3d final fix: the worker's whole stop fits in compose's `stop_grace_period: 60s` for the worker, with
 * 6 s left to exit. Stopping work gets the 45 s drain for a sync in flight (worker-runtime's
 * DEFAULT_STOP_GRACE_MS) plus 3 s for pg-boss to finish stopping; recording the interrupted sync and
 * closing the database get 3 s each.
 */
export const WORKER_STOP_WORK_MS = 48_000
export const WORKER_RECORD_RUN_MS = 3_000
export const WORKER_CLOSE_DB_MS = 3_000
/** the database pool's own end limit: whatever is still open after it is destroyed, inside WORKER_CLOSE_DB_MS */
export const WORKER_CLOSE_DB_TIMEOUT_SECONDS = 2

/**
 * SIGTERM/SIGINT: every step runs even if an earlier one fails, and the process always exits. 3d final
 * fix: each step is bounded too; one that fails or runs out of time makes the exit code 1.
 */
export async function shutdownWorker(deps: ShutdownDeps): Promise<void> {
  let code = 0
  const step = async (what: string, run: () => Promise<unknown>, limitMs: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        run().then(() => 'done' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), limitMs)
        }),
      ])
      if (outcome === 'timeout') {
        code = 1
        deps.log(`[worker] shutdown: ${what} did not finish within ${Math.round(limitMs / 1000)} s; going on`)
      }
    } catch (error) {
      code = 1
      deps.log(`[worker] shutdown: ${what} failed`, error)
    } finally {
      clearTimeout(timer)
    }
  }
  const limits = deps.limitsMs ?? {}
  await step('stopping work', deps.stopWork, limits.stopWork ?? WORKER_STOP_WORK_MS)
  // one worker (see recoverInterruptedRuns), so a run still "running" is the sync this process didn't finish
  await step('recording the interrupted sync', async () => {
      await failRunningHardcoverRuns(deps.db, WORKER_STOPPED)
      await failRunningAbsPushRuns(deps.db, WORKER_STOPPED)
      await failRunningRuns(deps.db, WORKER_STOPPED)
    },
    limits.record ?? WORKER_RECORD_RUN_MS)
  await step('closing the database', deps.close, limits.close ?? WORKER_CLOSE_DB_MS)
  deps.exit(code)
}
