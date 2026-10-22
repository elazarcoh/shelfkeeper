import { z } from 'zod'
import { createLoan, listLoansForEdition, listOpenLoans, returnLoan } from '@mylib/db'
import { LoanInput } from '@mylib/domain'
import { authedProcedure, router } from '../trpc/init'

export const loansRouter = router({
  forEdition: authedProcedure
    .input(z.object({ editionId: z.uuid() }))
    .query(({ ctx, input }) => listLoansForEdition(ctx.db, ctx.scope, input.editionId)),
  create: authedProcedure.input(LoanInput).mutation(({ ctx, input }) => createLoan(ctx.db, ctx.scope, input)),
  return: authedProcedure
    .input(z.object({ loanId: z.uuid(), on: z.iso.date() }))
    .mutation(({ ctx, input }) => returnLoan(ctx.db, ctx.scope, input.loanId, input.on)),
  open: authedProcedure.query(({ ctx }) => listOpenLoans(ctx.db, ctx.scope)),
})
