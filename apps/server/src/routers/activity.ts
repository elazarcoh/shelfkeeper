import { listActivity } from '@mylib/db'
import { authedProcedure, router } from '../trpc/init'

export const activityRouter = router({
  feed: authedProcedure.query(({ ctx }) => listActivity(ctx.db, ctx.scope)),
})
