import { readFileSync } from 'node:fs'
import { Agent, createServer, get } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { CLOSE_DB_MS, CLOSE_SERVER_MS, closeHttpServer, SHUTDOWN_WAIT_MS, shutdownOnSignal, shutdownServer, type ShutdownServerDeps } from './shutdown'
import { useServerHarness } from './testing/harness'

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

function fakeDeps(overrides: Partial<ShutdownServerDeps> = {}) {
  const calls: string[] = []
  const logs: string[] = []
  const deps: ShutdownServerDeps = {
    stopAccepting: () => calls.push('stopAccepting'),
    inFlight: () => [Promise.resolve()],
    closeServer: () => {
      calls.push('closeServer')
      return Promise.resolve()
    },
    closeDb: () => {
      calls.push('closeDb')
      return Promise.resolve()
    },
    exit: (code) => calls.push(`exit ${code}`),
    log: (message) => logs.push(message),
    ...overrides,
  }
  return { deps, calls, logs }
}

describe('shutdownServer (final fix 2)', () => {
  it('refuses new work at once, waits for the restore or start-up in flight, then closes and exits 0', async () => {
    const busy = gate()
    const { deps, calls, logs } = fakeDeps({ inFlight: () => [busy.opened, Promise.resolve()] })
    const done = shutdownServer(deps)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toEqual(['stopAccepting'])
    busy.open()
    await done
    expect(calls).toEqual(['stopAccepting', 'closeServer', 'closeDb', 'exit 0'])
    expect(logs.length).toBeGreaterThanOrEqual(3)
  })

  it('stops waiting after its bound and still closes, then exits 1: the work in flight was cut off (3d final fix)', async () => {
    const { deps, calls, logs } = fakeDeps({ inFlight: () => [new Promise<void>(() => undefined)], waitMs: 30 })
    await shutdownServer(deps)
    expect(calls).toEqual(['stopAccepting', 'closeServer', 'closeDb', 'exit 1'])
    expect(logs.some((line) => line.includes('did not finish') && line.includes('exit code 1'))).toBe(true)
  })

  it('a failing close step is logged, the rest still runs, and the exit code is 1', async () => {
    const { deps, calls } = fakeDeps({ closeServer: () => Promise.reject(new Error('boom')) })
    await shutdownServer(deps)
    expect(calls).toEqual(['stopAccepting', 'closeDb', 'exit 1'])
  })
})

describe('shutdown budget (3d item 5)', () => {
  it('fits the whole shutdown inside compose stop_grace_period, with room to exit', () => {
    const compose = parse(readFileSync(new URL('../../../deploy/compose.yaml', import.meta.url), 'utf8')) as { services: { app: { stop_grace_period: string } } }
    const graceMs = Number.parseInt(compose.services.app.stop_grace_period, 10) * 1000
    expect(SHUTDOWN_WAIT_MS).toBe(110_000)
    expect(SHUTDOWN_WAIT_MS + 5_000).toBeLessThanOrEqual(graceMs)
    expect(CLOSE_SERVER_MS + CLOSE_DB_MS).toBeLessThan(SHUTDOWN_WAIT_MS)
  })

  it('a close step that never finishes is cut off at its bound; the rest still runs and the exit code is 1', async () => {
    const { deps, calls, logs } = fakeDeps({ closeServer: () => new Promise<void>(() => undefined), closeServerMs: 50, closeDbMs: 50, waitMs: 200 })
    const began = Date.now()
    await shutdownServer(deps)
    expect(Date.now() - began).toBeLessThan(2_000)
    expect(calls).toEqual(['stopAccepting', 'closeDb', 'exit 1'])
    expect(logs.some((line) => line.includes('closing the HTTP server did not finish'))).toBe(true)
  })

  it('a database close that never finishes is cut off at its bound too', async () => {
    const { deps, calls, logs } = fakeDeps({ closeDb: () => new Promise<void>(() => undefined), closeServerMs: 50, closeDbMs: 50, waitMs: 200 })
    const began = Date.now()
    await shutdownServer(deps)
    expect(Date.now() - began).toBeLessThan(2_000)
    expect(calls).toEqual(['stopAccepting', 'closeServer', 'exit 1'])
    expect(logs.some((line) => line.includes('closing the database connections did not finish'))).toBe(true)
  })

  it('the in-flight wait gets only what the close steps leave of the budget (ruling P3)', async () => {
    // budget 3 s, close steps 1 s each: the work in flight gets 1 s, not the whole 3 s
    const { deps, calls, logs } = fakeDeps({ inFlight: () => [new Promise<void>(() => undefined)], waitMs: 3_000, closeServerMs: 1_000, closeDbMs: 1_000 })
    const began = Date.now()
    await shutdownServer(deps)
    expect(Date.now() - began).toBeLessThan(2_500)
    expect(logs.some((line) => line.includes('did not finish within 1 s'))).toBe(true)
    expect(calls).toEqual(['stopAccepting', 'closeServer', 'closeDb', 'exit 1'])
  })
})

describe('shutdownOnSignal (3d fix round 1, review #5)', () => {
  it('SIGINT then SIGTERM, or the same signal twice, runs one shutdown; the later signals are logged and ignored', async () => {
    const busy = gate()
    const { deps, calls, logs } = fakeDeps({ inFlight: () => [busy.opened] })
    const shutDown = shutdownOnSignal(deps)
    const first = shutDown('SIGINT')
    const second = shutDown('SIGTERM')
    const third = shutDown('SIGINT')
    expect(second).toBe(first)
    expect(third).toBe(first)
    busy.open()
    await first
    expect(calls).toEqual(['stopAccepting', 'closeServer', 'closeDb', 'exit 0'])
    expect(logs.filter((line) => line.includes('already shutting down; ignored'))).toEqual([
      '[shutdown] SIGTERM received while already shutting down; ignored',
      '[shutdown] SIGINT received while already shutting down; ignored',
    ])
  })
})

describe('closeHttpServer (3d item 5)', () => {
  async function listening(handler: Parameters<typeof createServer>[1]) {
    const server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { server, port: (server.address() as AddressInfo).port }
  }

  /** fix round 1 (review #6): whatever an assertion did, nothing is left listening for the rest of the file */
  function cleanUp(server: ReturnType<typeof createServer>, agent: Agent): void {
    agent.destroy()
    server.closeAllConnections()
    if (server.listening) server.close()
  }

  it('destroys a connection whose request hangs, after its force delay', async () => {
    const { server, port } = await listening(() => undefined) // never answers
    const agent = new Agent({ keepAlive: true })
    try {
      const arrived = new Promise((resolve) => server.once('request', resolve))
      get({ host: '127.0.0.1', port, agent, path: '/' }).on('error', () => undefined)
      await arrived
      const began = Date.now()
      await closeHttpServer(server, 100)
      expect(Date.now() - began).toBeLessThan(2_000)
    } finally {
      cleanUp(server, agent)
    }
  })

  it('closes at once when only an idle keep-alive connection is open (review focus 4)', async () => {
    const { server, port } = await listening((_req, res) => res.end('ok'))
    const agent = new Agent({ keepAlive: true })
    try {
      await new Promise<void>((resolve, reject) => {
        get({ host: '127.0.0.1', port, agent, path: '/' }, (res) => {
          res.resume()
          res.on('end', resolve)
        }).on('error', reject)
      })
      const began = Date.now()
      await closeHttpServer(server, 60_000)
      expect(Date.now() - began).toBeLessThan(1_000)
    } finally {
      cleanUp(server, agent)
    }
  })
})

describe('RestoreRunner once shutdown begins (final fix 2)', () => {
  const h = useServerHarness()

  it('refuses a new restore and records why', async () => {
    const restorer = h.restorer()
    restorer.stopAccepting()
    await expect(restorer.start('/nowhere/backup.zip', { deleteAfter: false, knownName: 'my-library-0.4.0-20260928-030000-manual.zip' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const { api } = await h.asNewUser('admin')
    expect(await api.backups.lastRestore()).toMatchObject({ ok: false, error: expect.stringContaining('shutting down') as unknown })
    await restorer.idle()
  })
})
