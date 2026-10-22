import { z } from 'zod'
import { getDailyStats, getFinishedBooks, getSessionsOnDate, getStatsSummary } from '@mylib/db'
import { authedProcedure, router } from '../trpc/init'

const Range = z.object({ from: z.iso.date(), to: z.iso.date() })

export const statsRouter = router({
  summary: authedProcedure.input(Range).query(({ ctx, input }) => getStatsSummary(ctx.db, ctx.scope, input)),
  daily: authedProcedure.input(Range).query(({ ctx, input }) => getDailyStats(ctx.db, ctx.scope, input)),
  books: authedProcedure.input(Range).query(({ ctx, input }) => getFinishedBooks(ctx.db, ctx.scope, input)),
  onDate: authedProcedure
    .input(z.object({ date: z.iso.date() }))
    .query(({ ctx, input }) => getSessionsOnDate(ctx.db, ctx.scope, input.date)),
})
