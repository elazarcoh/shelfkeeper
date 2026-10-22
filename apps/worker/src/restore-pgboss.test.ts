import path from 'node:path'
import { INTERRUPTED_BY_RESTORE, noMaintenanceControl, restoreBackup, runBackup } from '@mylib/db'
import { createScratchDatabase, testOpsEnv } from '@mylib/db/testing'
import { BACKUP_QUEUE, startBoss, SYNC_QUEUE, type BackupJobData } from '@mylib/jobs'
import { describe, expect, it } from 'vitest'

const MANUAL: BackupJobData = { kind: 'manual' }

async function job(boss: Awaited<ReturnType<typeof startBoss>>, queue: string, id: string) {
  return (await boss.findJobs(queue, { id }))[0]
}

/**
 * 3d item 2: the "ghost job" restore test in packages/db uses a stand-in pgboss.job. This one starts the
 * real pg-boss 12 (schema 43: a partitioned pgboss.job, stately unique indexes, the queue table's
 * cached `singletons_active`) on a scratch database, backs it up with a backup job active, restores it,
 * and checks that a fresh boss can fetch the next manual backup.
 */
describe('restore against the real pg-boss schema (3d item 2)', () => {
  it(
    'fails the backup job the backup caught active, keeps queued jobs, and a fresh boss after restore can fetch the manual job at once',
    async () => {
      const s = await createScratchDatabase()
      const env = testOpsEnv(s.url)
      try {
        let activeId = ''
        let queuedId = ''
        let syncId = ''
        const before = await startBoss(s.url, 'worker')
        try {
          activeId = (await before.send(BACKUP_QUEUE, MANUAL, { singletonKey: 'manual' })) ?? ''
          expect(activeId).not.toBe('')
          const [fetched] = await before.fetch<BackupJobData>(BACKUP_QUEUE)
          expect(fetched?.id).toBe(activeId)
          // stately: one queued job may wait beside the active one
          queuedId = (await before.send(BACKUP_QUEUE, MANUAL, { singletonKey: 'manual' })) ?? ''
          expect(queuedId).not.toBe('')
          syncId = (await before.send(SYNC_QUEUE, { sourceId: '11111111-1111-4111-8111-111111111111', runId: null })) ?? ''
          expect(syncId).not.toBe('')
          // what pg-boss's 60 s monitor writes while that job is active
          await before.getDb().executeSql("update pgboss.queue set singletons_active = array['manual'] where name = $1", [BACKUP_QUEUE])
          expect((await job(before, BACKUP_QUEUE, activeId))?.state).toBe('active')
        } finally {
          await before.stop({ graceful: false })
        }

        const backup = await runBackup(env, 'manual')
        await restoreBackup(env, { zipFile: path.join(env.backupDir, backup.name), control: noMaintenanceControl, workerPauseTimeoutMs: 0 })

        const after = await startBoss(s.url, 'worker')
        try {
          const ghost = await job(after, BACKUP_QUEUE, activeId)
          expect(ghost?.state).toBe('failed')
          expect(JSON.stringify(ghost?.output)).toContain(INTERRUPTED_BY_RESTORE)
          expect((await job(after, SYNC_QUEUE, syncId))?.state).toBe('created')
          // a fresh boss reads the (cleared) cache, so the queued manual backup is handed out
          const [next] = await after.fetch<BackupJobData>(BACKUP_QUEUE)
          expect(next?.id).toBe(queuedId)
        } finally {
          await after.stop({ graceful: false })
        }
      } finally {
        await s.drop()
      }
    },
    90_000,
  )
})
