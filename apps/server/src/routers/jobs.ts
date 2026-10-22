import { z } from 'zod'
import { listJobRuns, rerunJob } from '@mylib/db'
import { adminProcedure, router } from '../trpc/init'
import { enqueueSyncRun } from './enqueue-sync'

export const jobsRouter = router({
  list: adminProcedure.query(({ ctx }) => listJobRuns(ctx.db, ctx.scope)),
  rerun: adminProcedure.input(z.object({ runId: z.uuid() })).mutation(async ({ ctx, input }) => {
    const run = await rerunJob(ctx.db, ctx.scope, input.runId)
    await enqueueSyncRun(ctx, run)
    return run
  }),
})
