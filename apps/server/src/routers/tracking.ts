import { z } from 'zod'
import { addToQueue, removeFromQueue, reorderQueue, restoreToQueue, setRating, setReview, setStatus, setStatusFromMenu } from '@mylib/db'
import { RatingValue, ReadingStatus } from '@mylib/domain'
import { authedProcedure, router } from '../trpc/init'

const WorkId = z.object({ workId: z.uuid() })

export const trackingRouter = router({
  setStatus: authedProcedure
    .input(z.object({ workId: z.uuid(), status: ReadingStatus }))
    .mutation(({ ctx, input }) => setStatus(ctx.db, ctx.scope, input.workId, input.status)),
  /** #152 the book page's status menu: Read also records a finished read with an unknown date when there is none */
  pickStatus: authedProcedure
    .input(z.object({ workId: z.uuid(), status: ReadingStatus }))
    .mutation(({ ctx, input }) => setStatusFromMenu(ctx.db, ctx.scope, input.workId, input.status)),
  setRating: authedProcedure
    .input(z.object({ workId: z.uuid(), rating: RatingValue.nullable() }))
    .mutation(({ ctx, input }) => setRating(ctx.db, ctx.scope, input.workId, input.rating)),
  setReview: authedProcedure
    .input(z.object({ workId: z.uuid(), review: z.string().trim().max(20_000).nullable() }))
    .mutation(({ ctx, input }) =>
      setReview(ctx.db, ctx.scope, input.workId, input.review === '' ? null : input.review),
    ),
  queueAdd: authedProcedure
    .input(z.object({ workId: z.uuid(), where: z.enum(['top', 'bottom']).default('bottom') }))
    .mutation(({ ctx, input }) => addToQueue(ctx.db, ctx.scope, input.workId, input.where)),
  queueRemove: authedProcedure
    .input(WorkId)
    .mutation(({ ctx, input }) => removeFromQueue(ctx.db, ctx.scope, input.workId)),
  /** #85 Undo of a start: back to the Up next position sessions.start reported */
  queueRestore: authedProcedure
    .input(z.object({ workId: z.uuid(), position: z.number().int() }))
    .mutation(({ ctx, input }) => restoreToQueue(ctx.db, ctx.scope, input.workId, input.position)),
  queueReorder: authedProcedure
    .input(z.object({ workIds: z.array(z.uuid()).max(1000) }))
    .mutation(({ ctx, input }) => reorderQueue(ctx.db, ctx.scope, input.workIds)),
})
