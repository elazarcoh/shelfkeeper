import { importCsv } from '@mylib/db'
import { CsvImportInput } from '@mylib/domain'
import { authedProcedure, router } from '../trpc/init'

export const csvRouter = router({
  import: authedProcedure.input(CsvImportInput).mutation(({ ctx, input }) => importCsv(ctx.db, ctx.scope, input)),
})
