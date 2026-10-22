import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { isSyncedKind, notFound, type SyncStats } from '@mylib/domain'
import type { Db } from '../client'
import { jobRuns, sources, users, type JobStatus, type JobTrigger } from '../schema'
import { requireAdmin, type UserScope } from './scope'

/** keep in step with SYNC_JOB_EXPIRE_SECONDS in @mylib/jobs */
export const STALE_RUN_MINUTES = 120

export interface JobRunView {
  id: string
  sourceId: string
  sourceName: string
  trigger: JobTrigger
  status: JobStatus
  requestedByName: string | null
  stats: SyncStats | null
  error: string | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) => {
    if (typeof e === 'object' && e !== null && 'code' in e) {
      return (e as Record<string, unknown>).code
    }
    return undefined
  }
  return code(error) === '23505' || (typeof error === 'object' && error !== null && 'cause' in error && code((error as Record<string, unknown>).cause) === '23505')
}

export async function createSyncRun(db: Db, input: { sourceId: string; trigger: JobTrigger; requestedBy: string | null }): Promise<string> {
  const [row] = await db.insert(jobRuns).values(input).returning({ id: jobRuns.id })
  if (!row) throw new Error('job run insert failed')
  return row.id
}

export async function requestSync(db: Db, scope: UserScope, sourceId: string): Promise<{ runId: string; sourceId: string }> {
  requireAdmin(scope)
  const [source] = await db.select({ id: sources.id, kind: sources.kind }).from(sources).where(eq(sources.id, sourceId))
  if (!source || !isSyncedKind(source.kind)) throw notFound('Source')
  return { runId: await createSyncRun(db, { sourceId, trigger: 'manual', requestedBy: scope.userId }), sourceId }
}

export async function rerunJob(db: Db, scope: UserScope, runId: string): Promise<{ runId: string; sourceId: string }> {
  requireAdmin(scope)
  const [run] = await db.select({ sourceId: jobRuns.sourceId }).from(jobRuns).where(eq(jobRuns.id, runId))
  if (!run) throw notFound('Job')
  return { runId: await createSyncRun(db, { sourceId: run.sourceId, trigger: 'rerun', requestedBy: scope.userId }), sourceId: run.sourceId }
}

export async function claimSyncRun(db: Db, runId: string): Promise<'claimed' | 'busy' | 'gone'> {
  const [run] = await db.select({ sourceId: jobRuns.sourceId }).from(jobRuns).where(eq(jobRuns.id, runId))
  if (!run) return 'gone'
  // a worker that died mid-sync leaves its run "running" forever; free the source after a while
  await db
    .update(jobRuns)
    .set({ status: 'failed', finishedAt: new Date(), error: 'The worker stopped before this sync finished' })
    .where(
      and(
        eq(jobRuns.sourceId, run.sourceId),
        eq(jobRuns.status, 'running'),
        lt(jobRuns.startedAt, sql`now() - make_interval(mins => ${STALE_RUN_MINUTES})`),
      ),
    )
  try {
    const claimed = await db
      .update(jobRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(jobRuns.id, runId), eq(jobRuns.status, 'queued')))
      .returning({ id: jobRuns.id })
    return claimed.length === 1 ? 'claimed' : 'gone'
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    await db
      .update(jobRuns)
      .set({ status: 'skipped', finishedAt: new Date(), error: 'Another sync of this source was already running' })
      .where(eq(jobRuns.id, runId))
    return 'busy'
  }
}

export async function finishSyncRun(
  db: Db,
  runId: string,
  outcome: { status: 'succeeded' | 'failed'; stats: SyncStats | null; error: string | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date()
    const [run] = await tx
      .update(jobRuns)
      .set({ status: outcome.status, stats: outcome.stats, error: outcome.error, finishedAt: now })
      .where(eq(jobRuns.id, runId))
      .returning({ sourceId: jobRuns.sourceId })
    if (run) await tx.update(sources).set({ lastSyncAt: now, lastSyncStatus: outcome.status }).where(eq(sources.id, run.sourceId))
  })
}

/**
 * Fails every run still marked "running" (a worker restart or shutdown interrupted it) and stamps
 * their sources. Only safe while exactly one worker runs — see apps/worker/src/lifecycle.ts.
 */
export async function failRunningRuns(db: Db, message: string): Promise<number> {
  return db.transaction(async (tx) => {
    const now = new Date()
    const failed = await tx
      .update(jobRuns)
      .set({ status: 'failed', error: message, finishedAt: now })
      .where(eq(jobRuns.status, 'running'))
      .returning({ sourceId: jobRuns.sourceId })
    const sourceIds = [...new Set(failed.map((r) => r.sourceId))]
    if (sourceIds.length > 0) await tx.update(sources).set({ lastSyncAt: now, lastSyncStatus: 'failed' }).where(inArray(sources.id, sourceIds))
    return failed.length
  })
}

export async function listJobRuns(db: Db, scope: UserScope, limit = 50): Promise<JobRunView[]> {
  requireAdmin(scope)
  return db
    .select({
      id: jobRuns.id,
      sourceId: jobRuns.sourceId,
      sourceName: sources.name,
      trigger: jobRuns.trigger,
      status: jobRuns.status,
      requestedByName: users.displayName,
      stats: jobRuns.stats,
      error: jobRuns.error,
      createdAt: jobRuns.createdAt,
      startedAt: jobRuns.startedAt,
      finishedAt: jobRuns.finishedAt,
    })
    .from(jobRuns)
    .innerJoin(sources, eq(sources.id, jobRuns.sourceId))
    .leftJoin(users, eq(users.id, jobRuns.requestedBy))
    .orderBy(desc(jobRuns.createdAt))
    .limit(limit)
}
