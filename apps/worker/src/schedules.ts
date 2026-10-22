import { getBackupSettings, listScheduledSources, type Db } from '@mylib/db'
import { BACKUP_QUEUE, HARDCOVER_QUEUE, hardcoverCron, scheduleCron, SYNC_QUEUE, type BackupJobData, type HardcoverJobData } from '@mylib/jobs'

/** The slice of pg-boss the worker uses for cron; main.ts adapts PgBoss to it. */
export interface Scheduler {
  schedule(name: string, cron: string, data: object, options: { key: string; tz: string; singletonKey?: string; missed?: 'skip' | 'once' }): Promise<void>
  unschedule(name: string, key: string): Promise<void>
  getSchedules(name: string): Promise<{ key: string }[]>
}

export const BACKUP_SCHEDULE_KEY = 'nightly'

/** Makes pg-boss's schedules match the sources table (one schedule per source, keyed by source id). */
export async function reconcileSchedules(db: Db, scheduler: Scheduler): Promise<void> {
  const wanted = await listScheduledSources(db)
  for (const source of wanted) {
    await scheduler.schedule(SYNC_QUEUE, scheduleCron[source.schedule], { sourceId: source.id, runId: null }, { key: source.id, tz: 'UTC' })
  }
  const wantedIds = new Set(wanted.map((s) => s.id))
  for (const existing of await scheduler.getSchedules(SYNC_QUEUE)) {
    if (!wantedIds.has(existing.key)) await scheduler.unschedule(SYNC_QUEUE, existing.key)
  }
}

/**
 * Spec §4: the scheduled backup, nightly at 03:00 local by default, in TZ.
 * - Admin → Backups may change the time.
 * - A night missed while the Pi was off runs once when the worker is back.
 */
export async function reconcileBackupSchedule(db: Db, scheduler: Scheduler, options: { defaultSchedule: string; tz: string }): Promise<void> {
  const settings = await getBackupSettings(db, options.defaultSchedule)
  const data: BackupJobData = { kind: 'scheduled' }
  await scheduler.schedule(BACKUP_QUEUE, settings.schedule, data, { key: BACKUP_SCHEDULE_KEY, tz: options.tz, singletonKey: 'scheduled', missed: 'once' })
}

/** The Hardcover refresh (nightly) and send (hourly) jobs; they do nothing without tokens. */
export async function reconcileHardcoverSchedules(scheduler: Scheduler): Promise<void> {
  for (const kind of ['refresh', 'send'] as const) {
    const data: HardcoverJobData = { kind, trigger: 'schedule', requestedBy: null }
    await scheduler.schedule(HARDCOVER_QUEUE, hardcoverCron[kind], data, { key: kind, tz: 'UTC', singletonKey: kind })
  }
}
