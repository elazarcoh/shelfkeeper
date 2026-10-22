import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  DEFAULT_RETENTION,
  MaintenanceState,
  RestoreOutcome,
  type BackupKind,
  type BackupRetention,
  type BackupSettingsInput,
  type BackupSettingsView,
} from '@mylib/domain'
import type { Db } from '../client'
import { backupRuns, backupSettings, jobRuns, systemState, type BackupRunStatus } from '../schema'
import { requireAdmin, type UserScope } from './scope'

const ROW = 1

export async function getMaintenance(db: Db): Promise<MaintenanceState | null> {
  const [row] = await db.select({ maintenance: systemState.maintenance }).from(systemState).where(eq(systemState.id, ROW))
  return row?.maintenance == null ? null : MaintenanceState.parse(row.maintenance)
}

export async function setMaintenance(db: Db, state: MaintenanceState | null): Promise<void> {
  await db
    .insert(systemState)
    .values({ id: ROW, maintenance: state })
    .onConflictDoUpdate({ target: systemState.id, set: { maintenance: state, updatedAt: new Date() } })
}

/** The worker's acknowledgement: it has stopped taking jobs (null: it is working again). */
export async function markWorkerPaused(db: Db, at: Date | null): Promise<void> {
  await db
    .insert(systemState)
    .values({ id: ROW, workerPausedAt: at })
    .onConflictDoUpdate({ target: systemState.id, set: { workerPausedAt: at, updatedAt: new Date() } })
}

/** True once the worker acknowledged a pause at or after `since`; false after `timeoutMs` (a stopped worker never answers). */
export async function waitForWorkerPause(db: Db, since: Date, timeoutMs: number, pollMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [row] = await db.select({ at: systemState.workerPausedAt }).from(systemState).where(eq(systemState.id, ROW))
    if (row?.at != null && row.at.getTime() >= since.getTime()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export async function setLastRestore(db: Db, outcome: RestoreOutcome): Promise<void> {
  await db
    .insert(systemState)
    .values({ id: ROW, lastRestore: outcome })
    .onConflictDoUpdate({ target: systemState.id, set: { lastRestore: outcome, updatedAt: new Date() } })
}

export async function getLastRestore(db: Db, scope: UserScope): Promise<RestoreOutcome | null> {
  requireAdmin(scope)
  const [row] = await db.select({ lastRestore: systemState.lastRestore }).from(systemState).where(eq(systemState.id, ROW))
  const parsed = RestoreOutcome.safeParse(row?.lastRestore)
  return parsed.success ? parsed.data : null
}

function retentionOf(row: { keepScheduled: number; keepPreUpgrade: number; keepPreRestore: number } | undefined): BackupRetention {
  return row ? { scheduled: row.keepScheduled, preUpgrade: row.keepPreUpgrade, preRestore: row.keepPreRestore } : DEFAULT_RETENTION
}

export async function getBackupRetention(db: Db): Promise<BackupRetention> {
  const [row] = await db.select().from(backupSettings).where(eq(backupSettings.id, ROW))
  return retentionOf(row)
}

export async function getBackupSettings(db: Db, defaultSchedule: string): Promise<BackupSettingsView> {
  const [row] = await db.select().from(backupSettings).where(eq(backupSettings.id, ROW))
  return { schedule: row?.schedule ?? defaultSchedule, scheduleIsDefault: row?.schedule == null, defaultSchedule, retention: retentionOf(row) }
}

export async function updateBackupSettings(db: Db, scope: UserScope, input: BackupSettingsInput): Promise<void> {
  requireAdmin(scope)
  const values = {
    schedule: input.schedule,
    keepScheduled: input.retention.scheduled,
    keepPreUpgrade: input.retention.preUpgrade,
    keepPreRestore: input.retention.preRestore,
    updatedBy: scope.userId,
    updatedAt: new Date(),
  }
  await db.insert(backupSettings).values({ id: ROW, ...values }).onConflictDoUpdate({ target: backupSettings.id, set: values })
}

export interface BackupRunView {
  id: string
  kind: BackupKind
  status: BackupRunStatus
  fileName: string | null
  sizeBytes: number | null
  error: string | null
  startedAt: Date
  finishedAt: Date | null
}

export async function startBackupRun(db: Db, kind: BackupKind): Promise<string> {
  const [row] = await db.insert(backupRuns).values({ kind }).returning({ id: backupRuns.id })
  if (!row) throw new Error('backup run insert failed')
  return row.id
}

/** Only a still-`running` row is finished — a second call for the same run (e.g. a stray retry after a
 * verified-and-renamed success) is a no-op, so a backup already recorded as succeeded is never
 * overwritten (controller ruling R22). */
export async function finishBackupRun(
  db: Db,
  id: string,
  outcome: { status: 'succeeded'; fileName: string; sizeBytes: number } | { status: 'failed'; error: string },
): Promise<void> {
  await db
    .update(backupRuns)
    .set(
      outcome.status === 'succeeded'
        ? { status: 'succeeded', fileName: outcome.fileName, sizeBytes: outcome.sizeBytes, finishedAt: new Date() }
        : { status: 'failed', error: outcome.error.slice(0, 2000), finishedAt: new Date() },
    )
    .where(and(eq(backupRuns.id, id), eq(backupRuns.status, 'running')))
}

export async function failRunningBackupRuns(db: Db, message: string): Promise<number> {
  const failed = await db
    .update(backupRuns)
    .set({ status: 'failed', error: message, finishedAt: new Date() })
    .where(eq(backupRuns.status, 'running'))
    .returning({ id: backupRuns.id })
  return failed.length
}

export async function listBackupRuns(db: Db, scope: UserScope, limit = 20): Promise<BackupRunView[]> {
  requireAdmin(scope)
  return db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(limit)
}

export async function isBackupRunning(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: backupRuns.id }).from(backupRuns).where(eq(backupRuns.status, 'running')).limit(1)
  return row !== undefined
}

export async function lastFailedBackupRun(db: Db): Promise<{ at: Date; kind: BackupKind; error: string } | null> {
  const [row] = await db
    .select({ at: backupRuns.startedAt, kind: backupRuns.kind, error: backupRuns.error })
    .from(backupRuns)
    .where(eq(backupRuns.status, 'failed'))
    .orderBy(desc(backupRuns.startedAt))
    .limit(1)
  return row ? { at: row.at, kind: row.kind, error: row.error ?? 'Unknown error' } : null
}

/** The worker's newest finished job: a sync run, or a scheduled or manual backup (spec §8). */
export async function lastWorkerSuccess(db: Db): Promise<{ job: 'sync' | 'backup'; at: Date } | null> {
  const [sync] = await db
    .select({ at: sql<Date | null>`max(${jobRuns.finishedAt})`.mapWith(jobRuns.finishedAt) })
    .from(jobRuns)
    .where(eq(jobRuns.status, 'succeeded'))
  const [backup] = await db
    .select({ at: sql<Date | null>`max(${backupRuns.finishedAt})`.mapWith(backupRuns.finishedAt) })
    .from(backupRuns)
    .where(and(eq(backupRuns.status, 'succeeded'), inArray(backupRuns.kind, ['scheduled', 'manual'])))
  const syncAt = sync?.at ?? null
  const backupAt = backup?.at ?? null
  if (backupAt !== null && (syncAt === null || backupAt > syncAt)) return { job: 'backup', at: backupAt }
  return syncAt === null ? null : { job: 'sync', at: syncAt }
}

/** For /health: false when the database does not answer within `timeoutMs`. */
export async function pingDatabase(db: Db, timeoutMs = 2000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      db.execute(sql`select 1`).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
