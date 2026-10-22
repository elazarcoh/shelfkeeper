import { describeError, type Db, type OpsEnv } from '@mylib/db'
import { ABS_PUSH_QUEUE, BACKUP_QUEUE, COVERS_QUEUE, HARDCOVER_QUEUE, jobQueueFrom, startBoss, SYNC_QUEUE, WORKER_POLLING_SECONDS, type AbsPushJobData, type BackupJobData, type CoversJobData, type HardcoverJobData, type SyncJobData } from '@mylib/jobs'
import type { CloudCopier } from './cloud-copy'
import { runAbsPushJob, type AbsPushDeps } from './run-abs-push'
import { runBackupJob } from './run-backup'
import { runHardcoverJob, type HardcoverDeps } from './run-hardcover'
import { runCoversJob, type CoversDeps } from './run-covers'
import { runSyncJob, type SyncDeps } from './run-sync'
import { reconcileBackupSchedule, reconcileHardcoverSchedules, reconcileSchedules, type Scheduler } from './schedules'

export interface BackupScheduleConfig {
  defaultSchedule: string
  tz: string
}

export interface WorkerRuntimeDeps {
  databaseUrl: string
  db: Db
  ops: OpsEnv
  syncDeps: SyncDeps
  coversDeps: CoversDeps
  hardcoverDeps: HardcoverDeps
  absPushDeps: AbsPushDeps
  backupSchedule: BackupScheduleConfig
  /** #106: the cloud copy, which runs only while the worker takes jobs */
  cloud?: Pick<CloudCopier, 'start' | 'stop' | 'request'>
  /** how often schedules are re-read from sources/backup_settings (main.ts: 60s) */
  reconcileEveryMs?: number
  /** how long a stop waits for the job(s) in flight */
  stopGraceMs?: number
  pollingIntervalSeconds?: number
  log?: (message: string) => void
}

/** How long a stop waits for the job(s) in flight by default (lifecycle.ts bounds the whole stop around it). */
export const DEFAULT_STOP_GRACE_MS = 45_000

/** The worker's own pg-boss lifecycle, extracted from main.ts so it can be started and stopped
 * (including twice in a row, against a real test database) without spinning up the whole process. */
export interface WorkerRuntime {
  startWork(): Promise<void>
  /** resolves whether the job(s) in flight finished; false when the graceful timeout elapsed first */
  stopWork(): Promise<boolean>
  enqueueCovers(data: CoversJobData): Promise<void>
  /** whether a pg-boss instance is currently taking work */
  readonly running: boolean
}

export function createWorkerRuntime(deps: WorkerRuntimeDeps): WorkerRuntime {
  const log = deps.log ?? ((message: string) => console.log(message))
  const stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
  const reconcileEveryMs = deps.reconcileEveryMs ?? 60_000
  const pollingIntervalSeconds = deps.pollingIntervalSeconds ?? WORKER_POLLING_SECONDS

  type Boss = Awaited<ReturnType<typeof startBoss>>
  let boss: Boss | null = null
  let reconcileTimer: ReturnType<typeof setInterval> | null = null
  let starting: Promise<void> | null = null
  let stopping: Promise<boolean> | null = null

  async function doStart(): Promise<void> {
    const started = await startBoss(deps.databaseUrl, 'worker')
    // Ruling R27: assigned the moment startBoss succeeds, before anything below can fail, so a later
    // failure here still leaves stopWork able to reach (and close) this instance rather than leaking it.
    boss = started
    const poll = { pollingIntervalSeconds }
    try {
      await started.work<SyncJobData>(SYNC_QUEUE, poll, async ([job]) => {
        if (job) await runSyncJob(deps.syncDeps, job.data)
      })
      await started.work<CoversJobData>(COVERS_QUEUE, poll, async ([job]) => {
        if (job) await runCoversJob(deps.coversDeps, job.data)
      })
      await started.work<BackupJobData>(BACKUP_QUEUE, poll, async ([job]) => {
        // the cloud copy runs on its own, after the job: an upload can take far longer than the backup
        if (job && (await runBackupJob({ ops: deps.ops }, job.data)) === 'done') void deps.cloud?.request()
      })
      await started.work<HardcoverJobData>(HARDCOVER_QUEUE, poll, async ([job]) => {
        if (job) await runHardcoverJob(deps.hardcoverDeps, job.data)
      })
      await started.work<AbsPushJobData>(ABS_PUSH_QUEUE, poll, async ([job]) => {
        if (job) await runAbsPushJob(deps.absPushDeps, job.data)
      })
    } catch (error) {
      boss = null
      await started.stop({ graceful: false }).catch(() => undefined)
      throw error
    }
    const scheduler: Scheduler = {
      schedule: async (name, cron, data, options) => {
        await started.schedule(name, cron, data, options)
      },
      unschedule: async (name, key) => {
        await started.unschedule(name, key)
      },
      getSchedules: async (name) => (await started.getSchedules(name)).map((s) => ({ key: s.key })),
    }
    const reconcile = async () => {
      // separate try blocks: a broken sources reconciliation must not stop the backup schedule (or the
      // other way around) from being kept in sync.
      try {
        await reconcileSchedules(deps.db, scheduler)
      } catch (error) {
        log(`[worker] sync schedule reconciliation failed: ${describeError(error)}`)
      }
      try {
        await reconcileBackupSchedule(deps.db, scheduler, deps.backupSchedule)
      } catch (error) {
        log(`[worker] backup schedule reconciliation failed: ${describeError(error)}`)
      }
      try {
        await reconcileHardcoverSchedules(scheduler)
      } catch (error) {
        log(`[worker] hardcover schedule reconciliation failed: ${describeError(error)}`)
      }
    }
    await reconcile()
    reconcileTimer = setInterval(() => void reconcile(), reconcileEveryMs)
    await deps.cloud?.start()
  }

  async function doStop(): Promise<boolean> {
    if (reconcileTimer !== null) clearInterval(reconcileTimer)
    reconcileTimer = null
    await deps.cloud?.stop()
    const current = boss
    boss = null
    if (current !== null) {
      const startedAt = Date.now()
      await current.stop({ graceful: true, timeout: stopGraceMs })
      if (Date.now() - startedAt >= stopGraceMs) {
        log(`[worker] graceful stop hit its ${stopGraceMs}ms timeout; a job in flight may not have finished`)
        return false
      }
    }
    return true
  }

  return {
    get running() {
      return boss !== null
    },
    async startWork() {
      // a concurrent caller (the watcher's own next tick, a signal) awaits the same in-flight attempt
      // rather than racing a second one.
      if (stopping !== null) await stopping.catch(() => undefined)
      starting ??= doStart().finally(() => {
        starting = null
      })
      await starting
    },
    async stopWork() {
      if (starting !== null) await starting.catch(() => undefined)
      stopping ??= doStop().finally(() => {
        stopping = null
      })
      return stopping
    },
    async enqueueCovers(data) {
      if (boss !== null) await jobQueueFrom(boss).enqueueCovers(data)
      else log('[worker] dropped a covers request: the worker is stopping')
    },
  }
}
