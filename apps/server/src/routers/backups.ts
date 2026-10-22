import { backupFilePath, deleteBackup, exists, getBackupSettings, getLastRestore, listBackupRuns, listBackups, NotEnoughSpaceError, updateBackupSettings, uploadFilePath } from '@mylib/db'
import { BackupSettingsInput, notFound } from '@mylib/domain'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { adminProcedure, router } from '../trpc/init'

const BackupName = z.string().min(1).max(200)
const RestoreSource = z.discriminatedUnion('kind', [z.object({ kind: z.literal('file'), name: BackupName }), z.object({ kind: z.literal('upload'), uploadId: z.uuid() })])

export const backupsRouter = router({
  list: adminProcedure.query(({ ctx }) => listBackups(ctx.ops.backupDir)),
  runs: adminProcedure.query(({ ctx }) => listBackupRuns(ctx.db, ctx.scope)),
  settings: adminProcedure.query(({ ctx }) => getBackupSettings(ctx.db, ctx.config.backupScheduleDefault)),
  updateSettings: adminProcedure.input(BackupSettingsInput).mutation(({ ctx, input }) => updateBackupSettings(ctx.db, ctx.scope, input)),
  runNow: adminProcedure.mutation(async ({ ctx }) => {
    await ctx.jobs.enqueueBackup({ kind: 'manual' })
  }),
  delete: adminProcedure.input(z.object({ name: BackupName })).mutation(({ ctx, input }) => deleteBackup(ctx.ops.backupDir, input.name)),
  /** spec §4 step 1: the admin typed "restore" (server-side, not only in the UI) */
  restore: adminProcedure.input(z.object({ source: RestoreSource, confirm: z.literal('restore') })).mutation(async ({ ctx, input }) => {
    const zipFile = input.source.kind === 'file' ? backupFilePath(ctx.ops.backupDir, input.source.name) : uploadFilePath(ctx.ops.backupDir, input.source.uploadId)
    if (zipFile === null || !(await exists(zipFile))) throw notFound('Backup')
    try {
      return await ctx.restorer.start(zipFile, {
        deleteAfter: input.source.kind === 'upload',
        // exactOptionalPropertyTypes: `knownName` is left out entirely for an upload, never set to `undefined`
        ...(input.source.kind === 'file' ? { knownName: input.source.name } : {}),
      })
    } catch (error) {
      // OpsBusyError (CONFLICT) and BackupInvalidError (BAD_REQUEST) are DomainErrors and map automatically
      // (trpc/init's domainErrors middleware); only NotEnoughSpaceError needs mapping here.
      if (error instanceof NotEnoughSpaceError) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Not enough free disk space to restore this backup' })
      throw error
    }
  }),
  lastRestore: adminProcedure.query(({ ctx }) => getLastRestore(ctx.db, ctx.scope)),
})
