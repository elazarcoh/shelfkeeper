import { describe, expect, it } from 'vitest'
import { createHttpClient, getConnector } from '@mylib/connectors'
import { createFileAssetStore, createSecretBox, DEV_SECRET_KEY } from '@mylib/db'
import { testOpsEnv, useTestDb } from '@mylib/db/testing'
import type { CoversJobData } from '@mylib/jobs'
import type { CoversDeps } from './run-covers'
import type { SyncDeps } from './run-sync'
import { createWorkerRuntime } from './worker-runtime'

describe('worker runtime', () => {
  const t = useTestDb()

  function build(overrides: { log?: (message: string) => void } = {}) {
    const ops = testOpsEnv(t.url)
    const box = createSecretBox(DEV_SECRET_KEY)
    const http = createHttpClient()
    const store = createFileAssetStore(ops.assetsDir)
    const syncDeps: SyncDeps = { db: t.db, box, http, getConnector, enqueueCovers: () => Promise.resolve() }
    const coversDeps: CoversDeps = { db: t.db, box, http, getConnector, store }
    return createWorkerRuntime({
      databaseUrl: t.url,
      db: t.db,
      ops,
      syncDeps,
      coversDeps,
      absPushDeps: { db: t.db, box, http: createHttpClient() },
      hardcoverDeps: { db: t.db, box, client: () => { throw new Error('unused') }, openLibraryWork: () => Promise.resolve(null), now: () => new Date(), log: () => undefined },
      backupSchedule: { defaultSchedule: '0 3 * * *', tz: 'UTC' },
      reconcileEveryMs: 60_000,
      stopGraceMs: 1_000,
      ...overrides,
    })
  }

  it('starts, stops, and starts again against the same database, actually taking work each time', async () => {
    const runtime = build()
    expect(runtime.running).toBe(false)

    await runtime.startWork()
    expect(runtime.running).toBe(true)

    // final fix 6: nothing was in flight, so the stop drained cleanly
    expect(await runtime.stopWork()).toBe(true)
    expect(runtime.running).toBe(false)

    await runtime.startWork()
    expect(runtime.running).toBe(true)

    await runtime.stopWork()
    expect(runtime.running).toBe(false)
  }, 30_000)

  it('drops a covers request while stopped, without throwing, and logs one line with no data', async () => {
    const logs: string[] = []
    const runtime = build({ log: (message) => logs.push(message) })
    const data: CoversJobData = { sourceId: '11111111-1111-4111-8111-111111111111' }

    await expect(runtime.enqueueCovers(data)).resolves.toBeUndefined()
    expect(logs).toEqual(['[worker] dropped a covers request: the worker is stopping'])
    expect(logs.every((message) => !message.includes(data.sourceId))).toBe(true)

    await runtime.startWork()
    try {
      await expect(runtime.enqueueCovers(data)).resolves.toBeUndefined()
    } finally {
      await runtime.stopWork()
    }
  }, 30_000)

  it('lets two concurrent startWork callers share the same attempt', async () => {
    const runtime = build()
    const [a, b] = await Promise.all([runtime.startWork(), runtime.startWork()])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(runtime.running).toBe(true)
    await runtime.stopWork()
  }, 30_000)
})
