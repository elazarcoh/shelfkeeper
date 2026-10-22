import { PgBoss } from 'pg-boss'
import type { SourceSchedule } from '@mylib/domain'

export const SYNC_QUEUE = 'source-sync'

/**
 * How long pg-boss lets a sync job stay active before expiring it: the same 2 hours after which
 * claimSyncRun treats a "running" run as abandoned (STALE_RUN_MINUTES in @mylib/db), so the two
 * agree on when a sync is considered dead.
 */
export const SYNC_JOB_EXPIRE_SECONDS = 120 * 60

export interface SyncJobData {
  sourceId: string
  /** a run created by the API ("Sync now"/"Re-run"); null for scheduled syncs — the worker creates the run */
  runId: string | null
}

/** Presets are evaluated in UTC (plan deviation 1). */
export const scheduleCron: Record<SourceSchedule, string> = {
  hourly: '0 * * * *',
  daily: '0 3 * * *',
  weekly: '0 3 * * 0',
}

export const COVERS_QUEUE = 'source-covers'
export interface CoversJobData {
  sourceId: string
}

export const BACKUP_QUEUE = 'backup'
export interface BackupJobData {
  kind: 'scheduled' | 'manual'
}

export const HARDCOVER_QUEUE = 'hardcover'
export interface HardcoverJobData {
  kind: 'refresh' | 'send'
  trigger: 'schedule' | 'manual'
  requestedBy: string | null
}
export const ABS_PUSH_QUEUE = 'abs-push'
export interface AbsPushJobData {
  runId: string
}
export const hardcoverCron = { refresh: '30 2 * * *', send: '15 * * * *' } as const

/** Workers poll this often, not pg-boss's default 2 s: fewer wake-ups on the Pi (spec §3, plan deviation 19). */
export const WORKER_POLLING_SECONDS = 10

export interface JobQueue {
  enqueueSync(data: SyncJobData): Promise<void>
  /** best effort; a source that already has a queued covers job gets no second one */
  enqueueCovers(data: CoversJobData): Promise<void>
  /** at most one queued backup per kind: a double "Back up now" queues one */
  enqueueBackup(data: BackupJobData): Promise<void>
  /** at most one queued job per kind: a double "Refresh now" queues one */
  enqueueHardcover(data: HardcoverJobData): Promise<void>
  /** #115: one send run at a time (the run table enforces it too) */
  enqueueAbsPush(data: AbsPushJobData): Promise<void>
}

interface QueueOptions {
  retryLimit: number
  expireInSeconds: number
  policy?: 'stately'
}

async function ensureQueue(boss: PgBoss, name: string, options: QueueOptions): Promise<void> {
  const existing = await boss.getQueue(name)
  if (existing === null) {
    try {
      await boss.createQueue(name, options)
    } catch (error) {
      // the API and the worker start together; whichever loses the race finds the queue there
      if ((await boss.getQueue(name)) === null) throw error
    }
    return
  }
  // pg-boss refuses to change a policy after creation; starting anyway beats a crash loop
  const { policy, ...updatable } = options
  if (policy !== undefined && existing.policy !== policy) {
    console.warn(`[jobs] queue "${name}" has policy "${existing.policy ?? 'unknown'}" but "${policy}" is expected; pg-boss cannot change it in place, so delete the queue to have it recreated`)
  }
  if (existing.expireInSeconds !== updatable.expireInSeconds || existing.retryLimit !== updatable.retryLimit) {
    await boss.updateQueue(name, updatable) // a queue created by an older version
  }
}

/** Explicit, small pg-boss pools (its default is 10): the whole stack stays well under postgres.conf max_connections = 50. */
export const BOSS_POOL_MAX = { sender: 2, worker: 4 } as const

/** "sender": the API only enqueues (no maintenance or cron). "worker": the full pg-boss. */
export async function startBoss(connectionString: string, role: 'sender' | 'worker'): Promise<PgBoss> {
  const max = BOSS_POOL_MAX[role]
  const boss = new PgBoss(role === 'worker' ? { connectionString, max } : { connectionString, max, supervise: false, schedule: false })
  boss.on('error', (error) => {
    console.error('[jobs]', error)
  })
  try {
    await boss.start()
    // no automatic retries: a failed run is recorded and re-runnable from the Jobs page (plan deviation 4)
    await ensureQueue(boss, SYNC_QUEUE, { retryLimit: 0, expireInSeconds: SYNC_JOB_EXPIRE_SECONDS })
    // an hour bounds one covers job (at most MAX_ROUNDS x BATCH downloads in the worker); the rest waits for the next job
    await ensureQueue(boss, COVERS_QUEUE, { retryLimit: 0, expireInSeconds: 3600, policy: 'stately' })
    // a backup of a large library on the Pi's HDD takes minutes, never hours
    await ensureQueue(boss, BACKUP_QUEUE, { retryLimit: 0, expireInSeconds: 3 * 3600, policy: 'stately' })
    await ensureQueue(boss, HARDCOVER_QUEUE, { retryLimit: 0, expireInSeconds: 3600, policy: 'stately' })
    await ensureQueue(boss, ABS_PUSH_QUEUE, { retryLimit: 0, expireInSeconds: 3600, policy: 'stately' })
  } catch (error) {
    // 3d item 7: start-up retries after losing the database; never leave this instance's pool behind,
    // whether it failed in start() itself (ruling P7) or while setting up a queue
    await boss.stop({ graceful: false }).catch(() => undefined)
    throw error
  }
  return boss
}

export function jobQueueFrom(boss: PgBoss): JobQueue {
  return {
    async enqueueSync(data) {
      await boss.send(SYNC_QUEUE, data)
    },
    async enqueueCovers(data) {
      // "stately" + singletonKey: at most one queued (and one active) covers job per source
      await boss.send(COVERS_QUEUE, data, { singletonKey: data.sourceId })
    },
    async enqueueBackup(data) {
      await boss.send(BACKUP_QUEUE, data, { singletonKey: data.kind })
    },
    async enqueueHardcover(data) {
      // one queued job per kind: a double "Refresh now" queues one
      await boss.send(HARDCOVER_QUEUE, data, { singletonKey: data.kind })
    },
    async enqueueAbsPush(data) {
      await boss.send(ABS_PUSH_QUEUE, data, { singletonKey: data.runId })
    },
  }
}
