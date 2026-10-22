import { PgBoss } from 'pg-boss'
import { describe, expect, inject, it, vi } from 'vitest'
import { ABS_PUSH_QUEUE, BACKUP_QUEUE, COVERS_QUEUE, HARDCOVER_QUEUE, jobQueueFrom, scheduleCron, startBoss, SYNC_JOB_EXPIRE_SECONDS, SYNC_QUEUE, type SyncJobData } from './index'

describe('jobs', () => {
  it('has a five-field UTC cron per schedule preset', () => {
    for (const cron of Object.values(scheduleCron)) expect(cron.split(' ')).toHaveLength(5)
  })

  it('creates the sync queue without retries and with a deliberate expiry, and updates an older queue', async () => {
    const url = inject('databaseUrl')
    const boss = await startBoss(url, 'worker')
    try {
      expect(SYNC_JOB_EXPIRE_SECONDS).toBe(7200)
      expect(await boss.getQueue(SYNC_QUEUE)).toMatchObject({ retryLimit: 0, expireInSeconds: 7200 })
      await boss.updateQueue(SYNC_QUEUE, { expireInSeconds: 900 })
      const again = await startBoss(url, 'sender')
      await again.stop()
      expect(await boss.getQueue(SYNC_QUEUE)).toMatchObject({ expireInSeconds: 7200 })
    } finally {
      await boss.stop()
    }
  })

  it('delivers a sync job from a sender to a worker', async () => {
    const url = inject('databaseUrl')
    const worker = await startBoss(url, 'worker')
    const sender = await startBoss(url, 'sender')
    try {
      const received = new Promise<SyncJobData>((resolve) => {
        void worker.work<SyncJobData>(SYNC_QUEUE, (jobs) => {
          const job = jobs[0]
          if (job) resolve(job.data)
          return Promise.resolve()
        })
      })
      await jobQueueFrom(sender).enqueueSync({ sourceId: '11111111-1111-4111-8111-111111111111', runId: null })
      expect(await received).toEqual({ sourceId: '11111111-1111-4111-8111-111111111111', runId: null })
    } finally {
      await sender.stop()
      await worker.stop()
    }
  })

  it('keeps at most one queued covers job per source', async () => {
    const url = inject('databaseUrl')
    const boss = await startBoss(url, 'worker')
    try {
      expect(await boss.getQueue(COVERS_QUEUE)).toMatchObject({ policy: 'stately', retryLimit: 0 })
      const queue = jobQueueFrom(boss)
      await queue.enqueueCovers({ sourceId: 'a1111111-1111-4111-8111-111111111111' })
      await queue.enqueueCovers({ sourceId: 'a1111111-1111-4111-8111-111111111111' })
      await queue.enqueueCovers({ sourceId: 'b2222222-2222-4222-8222-222222222222' })
      expect(await boss.fetch(COVERS_QUEUE, { batchSize: 10 })).toHaveLength(2)
    } finally {
      await boss.stop()
    }
  })

  it('starts over an older covers queue: updates its options, and only warns about a policy it cannot change', async () => {
    const url = inject('databaseUrl')
    const admin = await startBoss(url, 'sender')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await admin.deleteQueue(COVERS_QUEUE)
      await admin.createQueue(COVERS_QUEUE, { retryLimit: 0, expireInSeconds: 900, policy: 'stately' })
      const first = await startBoss(url, 'sender')
      await first.stop()
      expect(await admin.getQueue(COVERS_QUEUE)).toMatchObject({ policy: 'stately', expireInSeconds: 3600 })
      expect(warn).not.toHaveBeenCalled()

      await admin.deleteQueue(COVERS_QUEUE)
      await admin.createQueue(COVERS_QUEUE, { retryLimit: 2, expireInSeconds: 900, policy: 'standard' })
      const second = await startBoss(url, 'sender')
      await second.stop()
      expect(await admin.getQueue(COVERS_QUEUE)).toMatchObject({ policy: 'standard', retryLimit: 0, expireInSeconds: 3600 })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('source-covers'))
    } finally {
      warn.mockRestore()
      // leave the queue as startBoss would create it
      await admin.deleteQueue(COVERS_QUEUE)
      await (await startBoss(url, 'sender')).stop()
      await admin.stop()
    }
  })

  it('stops the pg-boss it started when setting up a queue then fails, so a start-up retry leaks no pool (3d item 7)', async () => {
    const getQueue = vi.spyOn(PgBoss.prototype, 'getQueue').mockRejectedValueOnce(Object.assign(new Error('Connection terminated'), { code: 'CONNECTION_CLOSED' }))
    const stop = vi.spyOn(PgBoss.prototype, 'stop')
    try {
      await expect(startBoss(inject('databaseUrl'), 'sender')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
      expect(stop).toHaveBeenCalledWith({ graceful: false })
    } finally {
      getQueue.mockRestore()
      stop.mockRestore()
    }
  })

  it('stops a pg-boss whose start itself fails, so a start-up retry leaks no pool (3d item 7, ruling P7)', async () => {
    const start = vi.spyOn(PgBoss.prototype, 'start').mockRejectedValueOnce(Object.assign(new Error('Connection terminated'), { code: 'CONNECTION_CLOSED' }))
    const stop = vi.spyOn(PgBoss.prototype, 'stop')
    try {
      await expect(startBoss(inject('databaseUrl'), 'sender')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
      expect(stop).toHaveBeenCalledWith({ graceful: false })
    } finally {
      start.mockRestore()
      stop.mockRestore()
    }
  })

  it('keeps at most one queued backup per kind: a double "Back up now" queues one', async () => {
    const boss = await startBoss(inject('databaseUrl'), 'worker')
    try {
      expect(await boss.getQueue(BACKUP_QUEUE)).toMatchObject({ policy: 'stately', retryLimit: 0 })
      const queue = jobQueueFrom(boss)
      await queue.enqueueBackup({ kind: 'manual' })
      await queue.enqueueBackup({ kind: 'manual' })
      await queue.enqueueBackup({ kind: 'scheduled' })
      expect(await boss.fetch(BACKUP_QUEUE, { batchSize: 10 })).toHaveLength(2)
    } finally {
      await boss.stop()
    }
  })

  it('keeps at most one queued Hardcover job per kind', async () => {
    const boss = await startBoss(inject('databaseUrl'), 'worker')
    try {
      expect(await boss.getQueue(HARDCOVER_QUEUE)).toMatchObject({ policy: 'stately', retryLimit: 0 })
      const queue = jobQueueFrom(boss)
      await queue.enqueueHardcover({ kind: 'refresh', trigger: 'manual', requestedBy: null })
      await queue.enqueueHardcover({ kind: 'refresh', trigger: 'manual', requestedBy: null })
      await queue.enqueueHardcover({ kind: 'send', trigger: 'manual', requestedBy: null })
      expect(await boss.fetch(HARDCOVER_QUEUE, { batchSize: 10 })).toHaveLength(2)
    } finally {
      await boss.stop()
    }
  })

  it('queues one Audiobookshelf send job per run', async () => {
    const boss = await startBoss(inject('databaseUrl'), 'worker')
    try {
      expect(await boss.getQueue(ABS_PUSH_QUEUE)).toMatchObject({ policy: 'stately', retryLimit: 0 })
      const queue = jobQueueFrom(boss)
      await queue.enqueueAbsPush({ runId: 'a' })
      await queue.enqueueAbsPush({ runId: 'a' })
      expect(await boss.fetch(ABS_PUSH_QUEUE, { batchSize: 10 })).toHaveLength(1)
    } finally {
      await boss.stop()
    }
  })
})
