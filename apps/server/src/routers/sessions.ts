import { z } from 'zod'
import {
  completeSession,
  deleteReadingSession,
  dismissCheckin,
  getCheckinState,
  listSessionsForWork,
  markCheckedIn,
  markFinished,
  nextVolume,
  snoozeCheckin,
  startReading,
} from '@mylib/db'
import { CompleteSessionInput, MarkFinishedInput, NextVolumeInput, StartSessionInput } from '@mylib/domain'
import { authedProcedure, router } from '../trpc/init'

export const sessionsRouter = router({
  // #85: also takes the book off Up next; queuePosition lets the client's Undo put it back
  start: authedProcedure.input(StartSessionInput).mutation(({ ctx, input }) => startReading(ctx.db, ctx.scope, input)),

  /** "Mark as read / listened": one finished session for a read remembered only roughly, or not at all */
  markFinished: authedProcedure.input(MarkFinishedInput).mutation(({ ctx, input }) => markFinished(ctx.db, ctx.scope, input)),

  complete: authedProcedure
    .input(z.object({ sessionId: z.uuid(), completion: CompleteSessionInput }))
    .mutation(({ ctx, input }) => completeSession(ctx.db, ctx.scope, input.sessionId, input.completion)),

  /** "Finished volume k": ends it with a point at its end and moves on to volume k+1 (or waits for it) */
  nextVolume: authedProcedure.input(NextVolumeInput).mutation(({ ctx, input }) => nextVolume(ctx.db, ctx.scope, input)),

  delete: authedProcedure
    .input(z.object({ sessionId: z.uuid() }))
    .mutation(({ ctx, input }) => deleteReadingSession(ctx.db, ctx.scope, input.sessionId)),

  listForWork: authedProcedure
    .input(z.object({ workId: z.uuid() }))
    .query(({ ctx, input }) => listSessionsForWork(ctx.db, ctx.scope, input.workId)),

  // "today" is the client's local date: the server clock (UTC) may be on a different day
  checkinState: authedProcedure
    .input(z.object({ today: z.iso.date() }))
    .query(({ ctx, input }) => getCheckinState(ctx.db, ctx.scope, input.today)),

  dismissCheckin: authedProcedure
    .input(z.object({ today: z.iso.date() }))
    .mutation(({ ctx, input }) => dismissCheckin(ctx.db, ctx.scope, input.today)),

  snooze: authedProcedure
    .input(z.object({ sessionId: z.uuid(), until: z.iso.date() }))
    .mutation(({ ctx, input }) => snoozeCheckin(ctx.db, ctx.scope, input.sessionId, input.until)),

  /** "Still going" with nothing new: check-in leaves the book alone for 12 hours */
  checkedIn: authedProcedure
    .input(z.object({ sessionId: z.uuid() }))
    .mutation(({ ctx, input }) => markCheckedIn(ctx.db, ctx.scope, input.sessionId)),
})
