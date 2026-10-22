import { freeBytes, isBackupRunning, lastFailedBackupRun, lastWorkerSuccess, listBackups, readCloudStatus } from '@mylib/db'
import { backupIsStale, LOW_DISK_BYTES } from '@mylib/domain'
import { adminProcedure, router } from '../trpc/init'

/** Spec §8: what Admin shows about the install itself. */
export const systemRouter = router({
  status: adminProcedure.query(async ({ ctx }) => {
    const [backups, failure, backupRunning, worker, dataFree, backupsFree, cloud] = await Promise.all([
      listBackups(ctx.ops.backupDir),
      lastFailedBackupRun(ctx.db),
      isBackupRunning(ctx.db),
      lastWorkerSuccess(ctx.db),
      freeBytes(ctx.ops.assetsDir),
      freeBytes(ctx.ops.backupDir),
      readCloudStatus(ctx.ops.backupDir),
    ])
    const last = backups[0] ?? null
    return {
      version: ctx.config.appVersion,
      lastBackup: last === null ? null : { name: last.name, kind: last.kind, createdAt: last.createdAt, sizeBytes: last.sizeBytes, verified: last.verified },
      backupStale: backupIsStale(last?.createdAt ?? null, ctx.now()),
      lastFailure: failure !== null && (last === null || failure.at > last.createdAt) ? failure : null,
      backupRunning,
      freeBytes: { data: dataFree, backups: backupsFree },
      lowDisk: dataFree !== null && dataFree < LOW_DISK_BYTES,
      worker,
      // #106: null when the worker has not said yet whether a cloud copy is set up
      cloud:
        cloud === null
          ? null
          : {
              configured: cloud.configured,
              lastSuccess: cloud.lastSuccess === null ? null : { at: new Date(cloud.lastSuccess.at), file: cloud.lastSuccess.file, warning: cloud.lastSuccess.warning },
              lastFailure: cloud.lastFailure !== null && (cloud.lastSuccess === null || cloud.lastFailure.at > cloud.lastSuccess.at) ? { at: new Date(cloud.lastFailure.at), error: cloud.lastFailure.error } : null,
              stale: cloud.configured && backupIsStale(cloud.lastSuccess === null ? null : new Date(cloud.lastSuccess.at), ctx.now()),
            },
    }
  }),
})
