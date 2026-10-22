import { listCoverSourceIds } from '@mylib/db'
import type { Context } from '../trpc/context'

/**
 * Covers are best effort: the resolution already committed, so a queue (or lookup) failure is only logged.
 * Without `sourceIds`, every source that can have covers (synced and shelf) is queued.
 */
export async function queueCovers(ctx: Pick<Context, 'db' | 'jobs'>, sourceIds?: readonly string[]): Promise<void> {
  try {
    for (const sourceId of new Set(sourceIds ?? (await listCoverSourceIds(ctx.db)))) await ctx.jobs.enqueueCovers({ sourceId })
  } catch (error) {
    console.error('[inbox] could not queue covers', error)
  }
}
