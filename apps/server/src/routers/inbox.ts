import { z } from 'zod'
import { acceptExactMatches, acceptMineExact, countInbox, createForUnmatched, createMineUnmatched, listInbox, listMyProposals, resolveMyProposal, resolveSourceMatch } from '@mylib/db'
import { CsvResolution, InboxResolution } from '@mylib/domain'
import { adminProcedure, authedProcedure, router } from '../trpc/init'
import { queueCovers } from './queue-covers'

const InboxLimit = z.number().int().min(1).max(5000).default(100)

export const inboxRouter = router({
  count: authedProcedure.query(({ ctx }) => countInbox(ctx.db, ctx.scope)),
  // the page grows its `limit` as it is scrolled (resolved cards drop out, so offsets would skip some)
  list: adminProcedure
    .input(z.object({ limit: InboxLimit }).default({ limit: 100 }))
    .query(({ ctx, input }) => listInbox(ctx.db, ctx.scope, input.limit)),
  resolve: adminProcedure
    .input(z.object({ proposalId: z.uuid(), resolution: InboxResolution }))
    .mutation(async ({ ctx, input }) => {
      const result = await resolveSourceMatch(ctx.db, ctx.scope, input.proposalId, input.resolution)
      if (result.workId !== null) await queueCovers(ctx, [result.sourceId])
      return result
    }),
  acceptExact: adminProcedure.mutation(async ({ ctx }) => {
    const result = await acceptExactMatches(ctx.db, ctx.scope)
    await queueCovers(ctx)
    return result
  }),
  createUnmatched: adminProcedure.mutation(async ({ ctx }) => {
    const result = await createForUnmatched(ctx.db, ctx.scope)
    await queueCovers(ctx)
    return result
  }),
  mine: authedProcedure
    .input(z.object({ sourceId: z.uuid().nullable().default(null), limit: InboxLimit }).default({ sourceId: null, limit: 100 }))
    .query(({ ctx, input }) => listMyProposals(ctx.db, ctx.scope, { sourceId: input.sourceId, limit: input.limit })),
  resolveMine: authedProcedure
    .input(z.object({ proposalId: z.uuid(), resolution: CsvResolution, today: z.iso.date() }))
    .mutation(async ({ ctx, input }) => {
      const result = await resolveMyProposal(ctx.db, ctx.scope, input.proposalId, input.resolution, input.today)
      // a shelf proposal's cover is downloaded after it is accepted (a CSV source has none, so its job exits at once)
      if (result.workId !== null) await queueCovers(ctx, [result.sourceId])
      return result
    }),
  // my imports, in bulk: one chunk per call, the client repeats while `remaining > 0`
  acceptMineExact: authedProcedure.input(z.object({ today: z.iso.date() })).mutation(async ({ ctx, input }) => {
    const { sourceIds, ...result } = await acceptMineExact(ctx.db, ctx.scope, input.today)
    await queueCovers(ctx, sourceIds)
    return result
  }),
  createMineUnmatched: authedProcedure.input(z.object({ today: z.iso.date() })).mutation(async ({ ctx, input }) => {
    const { sourceIds, ...result } = await createMineUnmatched(ctx.db, ctx.scope, input.today)
    await queueCovers(ctx, sourceIds)
    return result
  }),
})
