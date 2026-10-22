import { z } from 'zod'
import {
  addWorkToSet,
  createSet,
  deleteSet,
  getSetForUser,
  listMySets,
  listSetMembership,
  removeWorkFromSet,
  setSetActive,
  updateSet,
} from '@mylib/db'
import { CreateSetInput, UpdateSetInput } from '@mylib/domain'
import { authedProcedure, router } from '../trpc/init'

const SetId = z.object({ setId: z.uuid() })
const SetWork = z.object({ setId: z.uuid(), workId: z.uuid() })

export const setsRouter = router({
  mine: authedProcedure.query(({ ctx }) => listMySets(ctx.db, ctx.scope)),
  membership: authedProcedure
    .input(z.object({ workIds: z.array(z.uuid()).max(500) }))
    .query(({ ctx, input }) => listSetMembership(ctx.db, ctx.scope, input.workIds)),
  get: authedProcedure.input(SetId).query(({ ctx, input }) => getSetForUser(ctx.db, ctx.scope, input.setId)),
  create: authedProcedure.input(CreateSetInput).mutation(({ ctx, input }) => createSet(ctx.db, ctx.scope, input)),
  update: authedProcedure
    .input(z.object({ setId: z.uuid(), patch: UpdateSetInput }))
    .mutation(({ ctx, input }) => updateSet(ctx.db, ctx.scope, input.setId, input.patch)),
  delete: authedProcedure.input(SetId).mutation(({ ctx, input }) => deleteSet(ctx.db, ctx.scope, input.setId)),
  addWork: authedProcedure
    .input(SetWork)
    .mutation(({ ctx, input }) => addWorkToSet(ctx.db, ctx.scope, input.setId, input.workId)),
  removeWork: authedProcedure
    .input(SetWork)
    .mutation(({ ctx, input }) => removeWorkFromSet(ctx.db, ctx.scope, input.setId, input.workId)),
  setActive: authedProcedure
    .input(z.object({ setId: z.uuid(), active: z.boolean() }))
    .mutation(({ ctx, input }) => setSetActive(ctx.db, ctx.scope, input.setId, input.active)),
})
