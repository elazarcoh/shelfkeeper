import { finishSyncRun } from '@mylib/db'
import type { SyncJobData } from '@mylib/jobs'
import type { AppDeps } from '../trpc/context'

/** Queues a run the API just created; if queueing fails the run is recorded failed (it would sit "queued" forever) and the error rethrown. */
export async function enqueueSyncRun(ctx: Pick<AppDeps, 'db' | 'jobs'>, run: { runId: string; sourceId: string }): Promise<void> {
  const data: SyncJobData = { sourceId: run.sourceId, runId: run.runId }
  try {
    await ctx.jobs.enqueueSync(data)
  } catch (error) {
    await finishSyncRun(ctx.db, run.runId, { status: 'failed', stats: null, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
