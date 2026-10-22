import { z } from 'zod'
import { addProgressPoint, listCurrentProgress, listProgressPoints, removeProgressPoint, updateProgressPoint } from '@mylib/db'
import { AddProgressInput, ProgressPointRef, UpdateProgressInput } from '@mylib/domain'
import { authedProcedure, router } from '../trpc/init'

/**
 * Reading progress points (reading progress spec §5). "today" is the client's local date, like check-in; the server
 * clock (ctx.now) only bounds how far that date may be from the server's own (ruling RP6). Domain errors map to
 * NOT_FOUND / CONFLICT / BAD_REQUEST in the shared middleware; anything unexpected is a generic 500.
 */
export const progressRouter = router({
  add: authedProcedure
    .input(AddProgressInput)
    .mutation(({ ctx, input }) => addProgressPoint(ctx.db, ctx.scope, input, { now: ctx.now() })),
  update: authedProcedure
    .input(UpdateProgressInput)
    .mutation(({ ctx, input }) => updateProgressPoint(ctx.db, ctx.scope, input, { now: ctx.now() })),
  remove: authedProcedure.input(ProgressPointRef).mutation(({ ctx, input }) => removeProgressPoint(ctx.db, ctx.scope, input.pointId)),
  list: authedProcedure
    .input(z.object({ sessionId: z.uuid() }))
    .query(({ ctx, input }) => listProgressPoints(ctx.db, ctx.scope, input.sessionId)),
  current: authedProcedure.query(({ ctx }) => listCurrentProgress(ctx.db, ctx.scope)),
})
