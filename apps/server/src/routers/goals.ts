import { z } from 'zod'
import { createGoal, deleteGoal, listGoals } from '@mylib/db'
import { GoalInput } from '@mylib/domain'
import { authedProcedure, router } from '../trpc/init'

export const goalsRouter = router({
  mine: authedProcedure.query(({ ctx }) => listGoals(ctx.db, ctx.scope)),
  create: authedProcedure.input(GoalInput).mutation(({ ctx, input }) => createGoal(ctx.db, ctx.scope, input)),
  delete: authedProcedure
    .input(z.object({ goalId: z.uuid() }))
    .mutation(({ ctx, input }) => deleteGoal(ctx.db, ctx.scope, input.goalId)),
})
