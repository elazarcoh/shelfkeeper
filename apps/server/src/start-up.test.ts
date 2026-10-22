import { createDb, hasTable, prepareDatabase, waitForPostgres, type UpgradeMemo } from '@mylib/db'
import { allowConnections, simulateInterruptedSwap } from '@mylib/db/testing'
import { startBoss } from '@mylib/jobs'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app'
import { loadConfig } from './config'
import { lockedSecrets, unavailableJobs } from './maintenance'
import { shutdownServer } from './shutdown'
import { startUp, type ConfigResult, type StartUpFns } from './start-up'
import { useServerHarness } from './testing/harness'
import type { AppDeps } from './trpc/context'

const FIXED_NOW = () => new Date('2026-09-28T03:00:00.000Z')
const neverCalled = (): never => {
  throw new Error('must not be called')
}
/** Ruling P7: a start-up that reaches the database (and maybe pg-boss) runs against the Testcontainers Postgres. */
const DOCKER_TIMEOUT_MS = 90_000

type Boss = Awaited<ReturnType<typeof startBoss>>
const upgrading = () => ({ reason: 'upgrading' as const, message: 'starting', since: FIXED_NOW().toISOString(), backupName: null })
const ready = () => Promise.resolve({ kind: 'ready' as const, applied: [], preUpgradeBackup: null })

/**
 * Ruling P10: one start-up the way a test needs it: a valid config on the harness's database, no
 * start-up problems, a fixed clock, and the real pg-boss. `fns` replaces any of these. Every pg-boss the
 * start-up got (from `fns.startBoss` too, retries included) is stopped once it returns.
 */
async function startUpForTest(deps: AppDeps, fns: Partial<StartUpFns> & Pick<StartUpFns, 'prepareDatabase'>): Promise<{ started: Boss[] }> {
  const started: Boss[] = []
  const configResult: ConfigResult = { ok: true, config: loadConfig({ DATABASE_URL: deps.ops.databaseUrl }) }
  const start = fns.startBoss ?? startBoss
  try {
    await startUp(deps, configResult, {
      checkStartup: () => Promise.resolve([]),
      now: FIXED_NOW,
      ...fns,
      startBoss: async (url, role) => {
        const boss = await start(url, role)
        started.push(boss)
        return boss
      },
    })
  } finally {
    // startUp may have stopped one itself (a shutdown began); stopping it again is harmless
    await Promise.all(started.map((boss) => boss.stop().catch(() => undefined)))
  }
  return { started }
}

// Fix round 1 (Important #3): every start-up outcome, exercised through createApp + /health, with
// checkStartup/prepareDatabase/startBoss injected — the failure paths never touch a real database.
describe('startUp', () => {
  const h = useServerHarness()

  it('invalid env → maintenance "config", generic on the wire', async () => {
    const deps = h.deps()
    const configResult: ConfigResult = { ok: false, issuePaths: ['PORT'] }
    await startUp(deps, configResult, { checkStartup: neverCalled, prepareDatabase: neverCalled, startBoss, now: FIXED_NOW })
    expect(deps.gate.state).toMatchObject({ reason: 'config' })
    // never the raw issue path or value leaks onto the wire, even to an admin — it's a generic line.
    expect(deps.gate.state?.message).not.toContain('PORT')
    const res = await createApp(deps).request('/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, maintenance: { reason: 'config' } })
  })

  it('checkStartup problems → maintenance "config"', async () => {
    const deps = h.deps()
    const configResult: ConfigResult = { ok: true, config: loadConfig({}) }
    await startUp(deps, configResult, { checkStartup: () => Promise.resolve(['BACKUP_DIR is not writable.']), prepareDatabase: neverCalled, startBoss, now: FIXED_NOW })
    expect(deps.gate.state).toMatchObject({ reason: 'config', message: expect.stringContaining('BACKUP_DIR is not writable.') as unknown })
    const res = await createApp(deps).request('/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, maintenance: { reason: 'config' } })
  })

  it(
    'prepareDatabase maintenance → that reason',
    async () => {
      const deps = h.deps()
      const state = { reason: 'newer-database' as const, message: 'The database is newer than this app.', since: FIXED_NOW().toISOString(), backupName: null }
      await startUpForTest(deps, { prepareDatabase: () => Promise.resolve({ kind: 'maintenance' as const, state }), startBoss: neverCalled })
      expect(deps.gate.state).toEqual(state)
      const res = await createApp(deps).request('/health')
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ ok: false, maintenance: { reason: 'newer-database' } })
    },
    DOCKER_TIMEOUT_MS,
  )

  it('a thrown error → sanitized maintenance', async () => {
    const deps = h.deps()
    const configResult: ConfigResult = { ok: true, config: loadConfig({}) }
    await startUp(deps, configResult, { checkStartup: () => Promise.reject(new Error('/secret/internal/path failed')), prepareDatabase: neverCalled, startBoss, now: FIXED_NOW })
    expect(deps.gate.state).toMatchObject({ reason: 'config' })
    expect(deps.gate.state?.message).not.toContain('/secret/internal/path')
    const res = await createApp(deps).request('/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, maintenance: { reason: 'config' } })
  })

  it(
    'a real verdict from prepareDatabase (a bug, not a lost database) is not retried: sanitized maintenance at once (3d item 7)',
    async () => {
      const deps = h.deps()
      let calls = 0
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        await startUpForTest(deps, {
          prepareDatabase: () => {
            calls++
            return Promise.reject(new Error('/secret/internal/path failed'))
          },
          startBoss: neverCalled,
          retryDelayMs: 1,
        })
      } finally {
        error.mockRestore()
      }
      expect(calls).toBe(1)
      expect(deps.gate.state).toMatchObject({ reason: 'config' })
      expect(deps.gate.state?.message).not.toContain('/secret/internal/path')
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'ready → gate open, jobs and secrets swapped in',
    async () => {
      const deps = h.deps()
      deps.jobs = unavailableJobs
      deps.secrets = lockedSecrets
      deps.gate.hold(upgrading())
      await startUpForTest(deps, { prepareDatabase: ready })
      expect(deps.gate.state).toBeNull()
      expect(deps.jobs).not.toBe(unavailableJobs)
      expect(deps.secrets).not.toBe(lockedSecrets)
      const res = await createApp(deps).request('/health')
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, maintenance: null })
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'ready → fills in search abbreviations after opening; a failed fill-in is only logged (#73)',
    async () => {
      const deps = h.deps()
      let gateWhenCalled: unknown = 'not called'
      await startUpForTest(deps, {
        prepareDatabase: ready,
        backfillSearch: () => {
          gateWhenCalled = deps.gate.state
          return Promise.resolve(3)
        },
      })
      expect(gateWhenCalled).toBeNull()

      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        await startUpForTest(deps, { prepareDatabase: ready, backfillSearch: () => Promise.reject(new Error('boom')) })
        await vi.waitFor(() => expect(logged).toHaveBeenCalledWith('[startup] search abbreviation backfill failed:', expect.stringContaining('boom')))
      } finally {
        logged.mockRestore()
      }
      expect(deps.gate.state).toBeNull()
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'waits, holding "upgrading", while the database is unreachable after a power cut, then starts (final fix 3)',
    async () => {
      const deps = h.deps()
      deps.gate.hold(upgrading())
      const seenWhileDown: unknown[] = []
      let failures = 0
      const connect = () => {
        if (failures < 4) {
          failures++
          seenWhileDown.push(deps.gate.state)
          return Promise.reject(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }))
        }
        return Promise.resolve()
      }
      await startUpForTest(deps, {
        waitForDatabase: (url) => waitForPostgres(url, { connect, delayMs: 1, log: () => undefined }),
        prepareDatabase: ready,
      })
      expect(failures).toBe(4)
      expect(seenWhileDown).toEqual([upgrading(), upgrading(), upgrading(), upgrading()])
      expect(deps.gate.state).toBeNull()
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'loses the database in the middle of preparing it: waits for it again and starts, keeping the same upgrade memo (3d item 7)',
    async () => {
      const deps = h.deps()
      deps.gate.hold(upgrading())
      const memos: (UpgradeMemo | undefined)[] = []
      const gateDuringRetry: unknown[] = []
      let waits = 0
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await startUpForTest(deps, {
          waitForDatabase: () => {
            waits++
            gateDuringRetry.push(deps.gate.state)
            return Promise.resolve()
          },
          prepareDatabase: (_env, options) => {
            memos.push(options?.upgrade)
            if (memos.length === 1) {
              if (options?.upgrade !== undefined) options.upgrade.preUpgradeBackup = 'my-library-0.4.0-test-20260928T030000Z-pre-upgrade.zip'
              return Promise.reject(Object.assign(new Error('Connection terminated unexpectedly'), { code: 'CONNECTION_CLOSED' }))
            }
            return Promise.resolve({ kind: 'ready' as const, applied: [], preUpgradeBackup: options?.upgrade?.preUpgradeBackup ?? null })
          },
          retryDelayMs: 1,
        })
        // the code only, never the error's message
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('CONNECTION_CLOSED'))
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('terminated unexpectedly'))
      } finally {
        warn.mockRestore()
      }
      expect(waits).toBe(2)
      expect(memos).toHaveLength(2)
      expect(memos[0]).toBe(memos[1])
      expect(memos[1]?.preUpgradeBackup).toMatch(/-pre-upgrade\.zip$/)
      expect(gateDuringRetry).toEqual([upgrading(), upgrading()])
      expect(deps.gate.state).toBeNull()
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'warns about a lost database once, then at most once a minute, with the attempt count (fix round 1, review #3)',
    async () => {
      const deps = h.deps()
      let calls = 0
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await startUpForTest(deps, {
          waitForDatabase: () => Promise.resolve(),
          prepareDatabase: () => {
            calls++
            return calls <= 5 ? Promise.reject(Object.assign(new Error('Connection terminated'), { code: 'CONNECTION_CLOSED' })) : ready()
          },
          retryDelayMs: 1,
        })
        expect(calls).toBe(6)
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('CONNECTION_CLOSED; attempt 1)'))
      } finally {
        warn.mockRestore()
      }
      expect(deps.gate.state).toBeNull()
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'loses the database while starting the job queue: retries without leaking the half-started one (3d item 7)',
    async () => {
      const deps = h.deps()
      deps.gate.hold(upgrading())
      let bossAttempts = 0
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const { started } = await startUpForTest(deps, {
          prepareDatabase: ready,
          startBoss: async (url, role) => {
            bossAttempts++
            if (bossAttempts === 1) throw Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' })
            return startBoss(url, role)
          },
          retryDelayMs: 1,
        })
        expect(started).toHaveLength(1)
      } finally {
        warn.mockRestore()
      }
      expect(bossAttempts).toBe(2)
      expect(deps.gate.state).toBeNull()
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'an error with no code while starting the job queue, with the database down, is retried, not a verdict (3d final fix, review #1)',
    async () => {
      const deps = h.deps()
      deps.gate.hold(upgrading())
      let bossAttempts = 0
      const probed: string[] = []
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const { started } = await startUpForTest(deps, {
          prepareDatabase: ready,
          startBoss: async (url, role) => {
            bossAttempts++
            // what node-postgres (pg-boss) throws when the server dies mid-start: no code at all
            if (bossAttempts === 1) throw new Error('Connection terminated unexpectedly')
            return startBoss(url, role)
          },
          // the database is down when the failure is looked at
          databaseUnreachableNow: (url) => {
            probed.push(url)
            return Promise.resolve('ECONNREFUSED')
          },
          retryDelayMs: 1,
        })
        expect(started).toHaveLength(1)
        // the code the database gave, never the error's message
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED; attempt 1)'))
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('terminated unexpectedly'))
      } finally {
        warn.mockRestore()
      }
      expect(probed).toEqual([deps.ops.databaseUrl])
      expect(bossAttempts).toBe(2)
      expect(deps.gate.state).toBeNull()
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'an error with no code while starting the job queue, with the database up, is a verdict: unexpected-error maintenance (3d final fix, review #1)',
    async () => {
      const deps = h.deps()
      deps.gate.hold(upgrading())
      let bossAttempts = 0
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        // the real check against the harness's database, which is up
        await startUpForTest(deps, {
          prepareDatabase: ready,
          startBoss: () => {
            bossAttempts++
            return Promise.reject(new Error('Connection terminated unexpectedly'))
          },
          retryDelayMs: 1,
        })
        expect(error).toHaveBeenCalledWith(expect.stringContaining('unexpected error'), expect.anything())
      } finally {
        error.mockRestore()
      }
      expect(bossAttempts).toBe(1)
      expect(deps.gate.state).toMatchObject({ reason: 'config', message: expect.stringContaining('unexpected error') as unknown })
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'an error with a code that is not about reaching the database is a verdict without asking the database (3d final fix, review #1)',
    async () => {
      const deps = h.deps()
      deps.gate.hold(upgrading())
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      let probes = 0
      try {
        await startUpForTest(deps, {
          prepareDatabase: ready,
          startBoss: () => Promise.reject(Object.assign(new Error('permission denied for schema pgboss'), { code: '42501' })),
          databaseUnreachableNow: () => {
            probes++
            return Promise.resolve('ECONNREFUSED')
          },
          retryDelayMs: 1,
        })
      } finally {
        error.mockRestore()
      }
      expect(probes).toBe(0)
      expect(deps.gate.state).toMatchObject({ reason: 'config' })
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'a real verdict while connecting (a bad password) is not waited through: sanitized maintenance at once (re-review)',
    async () => {
      const deps = h.deps()
      const badPassword = Object.assign(new Error('password authentication failed'), { code: '28P01' })
      await startUpForTest(deps, {
        waitForDatabase: (url) => waitForPostgres(url, { connect: () => Promise.reject(badPassword), delayMs: 60_000, log: () => undefined }),
        prepareDatabase: neverCalled,
        startBoss: neverCalled,
      })
      expect(deps.gate.state).toMatchObject({ reason: 'config' })
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'a shutdown while start-up waits for a database that is down ends start-up at once, leaving the gate as it was (3d item 6)',
    async () => {
      const deps = h.deps()
      deps.gate.hold(upgrading())
      const controller = new AbortController()
      const refused = () => Promise.reject(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }))
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      try {
        const starting = startUpForTest(deps, {
          waitForDatabase: (url, signal) => waitForPostgres(url, { connect: refused, delayMs: 20, log: () => undefined, ...(signal === undefined ? {} : { signal }) }),
          prepareDatabase: neverCalled,
          startBoss: neverCalled,
          signal: controller.signal,
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        const calls: string[] = []
        const began = Date.now()
        await shutdownServer({
          stopAccepting: () => controller.abort(new Error('shutting down')),
          inFlight: () => [starting],
          closeServer: () => Promise.resolve(),
          closeDb: () => Promise.resolve(),
          exit: (code) => calls.push(`exit ${code}`),
          log: () => undefined,
        })
        // the default 110 s budget was never used up
        expect(Date.now() - began).toBeLessThan(5_000)
        expect(calls).toEqual(['exit 0'])
        expect(error).not.toHaveBeenCalledWith(expect.stringContaining('unexpected error'), expect.anything())
      } finally {
        error.mockRestore()
        log.mockRestore()
      }
      expect(deps.gate.state).toEqual(upgrading())
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'a shutdown during the retry pause ends start-up at once (3d item 6, review focus 1, ruling P3)',
    async () => {
      const deps = h.deps()
      deps.gate.hold(upgrading())
      const controller = new AbortController()
      let prepares = 0
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      const timer: { sigterm: ReturnType<typeof setTimeout> | undefined; began: number } = { sigterm: undefined, began: 0 }
      try {
        await startUpForTest(deps, {
          waitForDatabase: () => Promise.resolve(),
          prepareDatabase: () => {
            prepares++
            // SIGTERM lands ~50 ms after the database is lost: start-up is sitting in its 60 s pause by then
            timer.began = Date.now()
            timer.sigterm = setTimeout(() => controller.abort(new Error('shutting down')), 50)
            return Promise.reject(Object.assign(new Error('Connection terminated'), { code: 'CONNECTION_CLOSED' }))
          },
          startBoss: neverCalled,
          signal: controller.signal,
          retryDelayMs: 60_000,
        })
        // well under the 60 s pause
        expect(Date.now() - timer.began).toBeLessThan(5_000)
        expect(prepares).toBe(1)
        // it really was in the pause: the loss had been reported before the abort landed
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('CONNECTION_CLOSED'))
        expect(error).not.toHaveBeenCalledWith(expect.stringContaining('unexpected error'), expect.anything())
        expect(log).toHaveBeenCalledWith(expect.stringContaining('[startup] shutting down'))
      } finally {
        clearTimeout(timer.sigterm)
        error.mockRestore()
        warn.mockRestore()
        log.mockRestore()
      }
      expect(deps.gate.state).toEqual(upgrading())
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'a shutdown that lands as the database is lost ends start-up without a retry (3d item 6)',
    async () => {
      const deps = h.deps()
      deps.gate.hold(upgrading())
      const controller = new AbortController()
      let prepares = 0
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      const began = Date.now()
      try {
        await startUpForTest(deps, {
          waitForDatabase: () => Promise.resolve(),
          prepareDatabase: () => {
            prepares++
            controller.abort(new Error('shutting down'))
            return Promise.reject(Object.assign(new Error('Connection terminated'), { code: 'CONNECTION_CLOSED' }))
          },
          startBoss: neverCalled,
          signal: controller.signal,
          retryDelayMs: 60_000,
        })
      } finally {
        log.mockRestore()
      }
      expect(Date.now() - began).toBeLessThan(5_000)
      expect(prepares).toBe(1)
      expect(deps.gate.state).toEqual(upgrading())
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'a start-up retry stops when a shutdown began even without a signal (isClosing, 3d item 6)',
    async () => {
      const deps = h.deps()
      deps.gate.hold(upgrading())
      let closing = false
      let prepares = 0
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      try {
        await startUpForTest(deps, {
          waitForDatabase: () => Promise.resolve(),
          prepareDatabase: () => {
            prepares++
            closing = true
            return Promise.reject(Object.assign(new Error('Connection terminated'), { code: 'CONNECTION_CLOSED' }))
          },
          startBoss: neverCalled,
          isClosing: () => closing,
          retryDelayMs: 1,
        })
      } finally {
        log.mockRestore()
      }
      expect(prepares).toBe(1)
      expect(deps.gate.state).toEqual(upgrading())
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'never swaps the job queue in or opens the gate once a shutdown began (re-review)',
    async () => {
      const deps = h.deps()
      deps.jobs = unavailableJobs
      deps.gate.hold(upgrading())
      await startUpForTest(deps, { prepareDatabase: ready, startBoss: neverCalled, isClosing: () => true })
      expect(deps.jobs).toBe(unavailableJobs)
      expect(deps.gate.state).toEqual(upgrading())
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    'stops the job queue it just started when a shutdown began while it was starting (re-review)',
    async () => {
      const deps = h.deps()
      deps.jobs = unavailableJobs
      let closing = false
      const { started } = await startUpForTest(deps, {
        prepareDatabase: ready,
        startBoss: async (url, role) => {
          const boss = await startBoss(url, role)
          closing = true // SIGTERM lands while pg-boss starts
          return boss
        },
        isClosing: () => closing,
      })
      expect(started).toHaveLength(1)
      expect(deps.jobs).toBe(unavailableJobs)
    },
    DOCKER_TIMEOUT_MS,
  )

  it(
    're-allows connections an interrupted restore swap left refused, then starts normally (final fix 1)',
    async () => {
      const deps = h.deps()
      await simulateInterruptedSwap(deps.ops.databaseUrl)
      try {
        await startUpForTest(deps, { prepareDatabase })
        expect(deps.gate.state).toBeNull()
        const fresh = createDb(deps.ops.databaseUrl, { max: 1 })
        try {
          expect(await hasTable(fresh.db, 'work')).toBe(true)
        } finally {
          await fresh.close()
        }
      } finally {
        await allowConnections(deps.ops.databaseUrl)
      }
    },
    DOCKER_TIMEOUT_MS,
  )
})
