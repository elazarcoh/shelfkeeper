import { z } from 'zod'
import { getContinuationForWork, listContinuationsForUser, listHiddenContinuations, listSeriesEntries, setContinuationHidden } from '@mylib/db'
import { authedProcedure, router } from '../trpc/init'

export const seriesRouter = router({
  entries: authedProcedure
    .input(z.object({ seriesId: z.uuid() }))
    .query(({ ctx, input }) => listSeriesEntries(ctx.db, ctx.scope, input.seriesId)),
  continuationForWork: authedProcedure
    .input(z.object({ workId: z.uuid() }))
    .query(({ ctx, input }) => getContinuationForWork(ctx.db, ctx.scope, input.workId)),
  continuations: authedProcedure.query(({ ctx }) => listContinuationsForUser(ctx.db, ctx.scope)),
  /** ids of the series hidden from this user's Series continuation */
  hiddenContinuations: authedProcedure.query(({ ctx }) => listHiddenContinuations(ctx.db, ctx.scope)),
  setContinuationHidden: authedProcedure
    .input(z.object({ seriesId: z.uuid(), hidden: z.boolean() }))
    .mutation(({ ctx, input }) => setContinuationHidden(ctx.db, ctx.scope, input.seriesId, input.hidden)),
})
