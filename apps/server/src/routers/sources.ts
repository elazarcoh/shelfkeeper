import { z } from 'zod'
import { getConnector } from '@mylib/connectors'
import { createSource, deleteSource, getSourceConfig, listSources, requestSync, sourceRemovalInfo, updateSource } from '@mylib/db'
import { CreateSourceInput, UpdateSourceInput } from '@mylib/domain'
import { adminProcedure, router } from '../trpc/init'
import { enqueueSyncRun } from './enqueue-sync'

const SourceId = z.object({ sourceId: z.uuid() })

export const sourcesRouter = router({
  list: adminProcedure.query(({ ctx }) => listSources(ctx.db, ctx.scope, ctx.secrets)),
  create: adminProcedure.input(CreateSourceInput).mutation(({ ctx, input }) => createSource(ctx.db, ctx.scope, ctx.secrets, input)),
  update: adminProcedure
    .input(z.object({ sourceId: z.uuid(), patch: UpdateSourceInput }))
    .mutation(({ ctx, input }) => updateSource(ctx.db, ctx.scope, ctx.secrets, input.sourceId, input.patch)),
  test: adminProcedure.input(SourceId).mutation(async ({ ctx, input }) => {
    const config = await getSourceConfig(ctx.db, ctx.scope, ctx.secrets, input.sourceId)
    return getConnector(config.kind).test(config, ctx.http)
  }),
  syncNow: adminProcedure.input(SourceId).mutation(async ({ ctx, input }) => {
    const run = await requestSync(ctx.db, ctx.scope, input.sourceId)
    await enqueueSyncRun(ctx, run)
    return run
  }),
  removalInfo: adminProcedure.input(SourceId).query(({ ctx, input }) => sourceRemovalInfo(ctx.db, ctx.scope, input.sourceId)),
  remove: adminProcedure.input(SourceId).mutation(({ ctx, input }) => deleteSource(ctx.db, ctx.scope, input.sourceId)),
})
