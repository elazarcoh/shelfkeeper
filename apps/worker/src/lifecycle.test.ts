import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { claimSyncRun, createDb, createSyncRun, jobRuns, lastHardcoverRun, sources, startHardcoverRun, waitForPostgres } from '@mylib/db'
import { allowConnections, simulateInterruptedSwap, tempDir, testOpsEnv, useTestDb } from '@mylib/db/testing'
import { prepareWorker, recoverInterruptedRuns, shutdownWorker, WORKER_CLOSE_DB_MS, WORKER_RECORD_RUN_MS, WORKER_STOP_WORK_MS } from './lifecycle'
import { DEFAULT_STOP_GRACE_MS } from './worker-runtime'

describe('worker lifecycle', () => {
  const t = useTestDb()

  async function runningRun() {
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    const runId = await createSyncRun(t.db, { sourceId: source?.id ?? '', trigger: 'schedule', requestedBy: null })
    await claimSyncRun(t.db, runId)
    return runId
  }
  const runOf = async (id: string) => (await t.db.select().from(jobRuns)).find((r) => r.id === id)

  it('fails the runs a previous worker left running, at startup', async () => {
    const runId = await runningRun()
    await recoverInterruptedRuns(t.db)
    expect(await runOf(runId)).toMatchObject({ status: 'failed', error: 'The worker restarted during this sync' })
  })

  it('at startup fails a Hardcover run left running, so the next one is not busy (C1)', async () => {
    await startHardcoverRun(t.db, { kind: 'refresh', trigger: 'schedule', requestedBy: null })
    await recoverInterruptedRuns(t.db)
    expect(await lastHardcoverRun(t.db, 'refresh')).toMatchObject({ status: 'failed', error: 'The worker restarted during this sync' })
    expect(await startHardcoverRun(t.db, { kind: 'refresh', trigger: 'schedule', requestedBy: null })).not.toBeNull()
  })

  it('on shutdown fails a Hardcover run left running (C1)', async () => {
    await startHardcoverRun(t.db, { kind: 'send', trigger: 'schedule', requestedBy: null })
    await shutdownWorker({ db: t.db, stopWork: () => Promise.resolve(), close: () => Promise.resolve(), exit: vi.fn(), log: () => undefined })
    expect(await lastHardcoverRun(t.db, 'send')).toMatchObject({ status: 'failed', error: 'The worker stopped during this sync' })
  })

  it('at startup re-allows connections an interrupted restore swap left refused, then recovers runs (final fix 1)', async () => {
    const runId = await runningRun()
    const ops = testOpsEnv(t.url, { assetsDir: tempDir('worker-assets'), backupDir: tempDir('worker-backups') })
    await simulateInterruptedSwap(t.url)
    try {
      await prepareWorker({ db: t.db, ops, log: () => undefined })
      const fresh = createDb(t.url, { max: 1 })
      try {
        expect((await fresh.db.select().from(jobRuns)).find((r) => r.id === runId)).toMatchObject({ status: 'failed', error: 'The worker restarted during this sync' })
      } finally {
        await fresh.close()
      }
    } finally {
      await allowConnections(t.url)
    }
  })

  it('at startup waits for an unreachable database instead of crashing, logging while it waits (final fix 3)', async () => {
    const runId = await runningRun()
    const ops = testOpsEnv(t.url, { assetsDir: tempDir('worker-assets'), backupDir: tempDir('worker-backups') })
    let failures = 0
    const connect = () => (++failures <= 3 ? Promise.reject(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })) : Promise.resolve())
    const logs: string[] = []
    await prepareWorker({ db: t.db, ops, log: (message) => logs.push(message), waitForDatabase: (url, log) => waitForPostgres(url, { connect, delayMs: 1, logEveryMs: 0, log }) })
    expect(failures).toBe(4)
    expect(logs.filter((line) => line.includes('waiting for the database'))).toHaveLength(3)
    expect(await runOf(runId)).toMatchObject({ status: 'failed' })
  })

  it('on shutdown stops taking work, fails the sync still in flight, closes and exits', async () => {
    const runId = await runningRun()
    const calls: string[] = []
    const exit = vi.fn()
    await shutdownWorker({
      db: t.db,
      stopWork: () => {
        calls.push('stopWork')
        return Promise.resolve()
      },
      close: () => {
        calls.push('close')
        return Promise.resolve()
      },
      exit,
      log: () => undefined,
    })
    expect(calls).toEqual(['stopWork', 'close'])
    expect(await runOf(runId)).toMatchObject({ status: 'failed', error: 'The worker stopped during this sync' })
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('still records the run, closes and exits when stopping fails', async () => {
    const runId = await runningRun()
    const close = vi.fn(() => Promise.resolve())
    const exit = vi.fn()
    const log = vi.fn()
    await shutdownWorker({ db: t.db, stopWork: () => Promise.reject(new Error('boom')), close, exit, log })
    expect((await runOf(runId))?.status).toBe('failed')
    expect(close).toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('a database close that never finishes is cut off at its bound: the worker still exits, with code 1 (3d final fix)', async () => {
    const runId = await runningRun()
    const exit = vi.fn()
    const logs: string[] = []
    const began = Date.now()
    await shutdownWorker({
      db: t.db,
      stopWork: () => Promise.resolve(),
      close: () => new Promise<void>(() => undefined),
      exit,
      log: (message) => logs.push(message),
      limitsMs: { close: 50 },
    })
    expect(Date.now() - began).toBeLessThan(2_000)
    expect((await runOf(runId))?.status).toBe('failed')
    expect(logs.some((line) => line.includes('closing the database did not finish'))).toBe(true)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('a stop that never finishes is cut off at its bound; the sync is still recorded and the database closed (3d final fix)', async () => {
    const runId = await runningRun()
    const close = vi.fn(() => Promise.resolve())
    const exit = vi.fn()
    const logs: string[] = []
    await shutdownWorker({
      db: t.db,
      stopWork: () => new Promise<void>(() => undefined),
      close,
      exit,
      log: (message) => logs.push(message),
      limitsMs: { stopWork: 50 },
    })
    expect((await runOf(runId))?.status).toBe('failed')
    expect(close).toHaveBeenCalled()
    expect(logs.some((line) => line.includes('stopping work did not finish'))).toBe(true)
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('worker shutdown budget (3d final fix)', () => {
  it('fits the whole worker stop inside compose stop_grace_period, with room to exit, and keeps the in-flight drain', () => {
    const compose = parse(readFileSync(new URL('../../../deploy/compose.yaml', import.meta.url), 'utf8')) as { services: { worker: { stop_grace_period: string } } }
    const graceMs = Number.parseInt(compose.services.worker.stop_grace_period, 10) * 1000
    expect(WORKER_STOP_WORK_MS + WORKER_RECORD_RUN_MS + WORKER_CLOSE_DB_MS + 5_000).toBeLessThanOrEqual(graceMs)
    // the 45 s drain for a sync in flight still fits inside its step
    expect(DEFAULT_STOP_GRACE_MS).toBe(45_000)
    expect(WORKER_STOP_WORK_MS).toBeGreaterThan(DEFAULT_STOP_GRACE_MS)
  })
})
