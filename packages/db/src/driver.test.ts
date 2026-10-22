import net from 'node:net'
import { Duplex } from 'node:stream'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createDb, type DbHandle } from './client'
import { allowConnections, createScratchDatabase, simulateInterruptedSwap, terminateBackendsRunning, waitFor, type ScratchDatabase } from './testing'

/**
 * 3d Task 7: postgres.js (patches/postgres@3.4.9.patch) when a connection drops under a running query.
 * Each test runs a `pg_sleep` tagged with a unique marker, terminates its backend, and checks what follows.
 */

let scratch: ScratchDatabase

beforeAll(async () => {
  scratch = await createScratchDatabase()
})
afterAll(async () => {
  await allowConnections(scratch.url)
  await scratch.drop()
})

function openHandle(max: number): DbHandle {
  const handle = createDb(scratch.url, { max })
  onTestFinished(() => handle.close(2))
  return handle
}

/** Starts `select pg_sleep(30)` tagged `marker`, and terminates its backend once it is running. */
/**
 * Flake fix: Drizzle's `db.execute()` returns a lazy QueryPromise that runs its query again on every
 * `.then`/`.catch`, so a test that awaits it twice sends it twice. This runs it exactly once.
 */
function once<T>(query: PromiseLike<T>): Promise<T> {
  return Promise.resolve(query)
}

async function dropMidQuery<T>(start: () => PromiseLike<T>, marker: string): Promise<{ running: Promise<T> }> {
  const running = once(start())
  running.catch(() => undefined)
  await waitFor(async () => (await terminateBackendsRunning(scratch.url, marker)) > 0, `the ${marker} query to run`, undefined, 10_000)
  return { running }
}

function sleepQuery(marker: string) {
  return sql.raw(`select pg_sleep(30) as ${marker}`)
}

/** Resolves to 'timed out' if `promise` has not settled within `ms`. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<'settled' | 'timed out'> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      new Promise<'timed out'>((resolve) => {
        timer = setTimeout(resolve, ms, 'timed out')
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error ? ((error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code) : undefined
}

interface CountingProxy {
  /** `url` with its host and port pointed at the proxy */
  readonly url: string
  /** connections opened through the proxy so far */
  connections(): number
  close(): Promise<void>
}

/**
 * Flake fix: a TCP proxy on 127.0.0.1 that pipes every connection to `url`'s Postgres and counts them, so
 * the test counts connect attempts itself. It used to read them from the container log, which, shared by
 * the whole suite, grew too slow to read under `pnpm check` (and depended on clocks before that).
 */
async function countingProxy(url: string): Promise<CountingProxy> {
  const target = new URL(url)
  const sockets = new Set<net.Socket>()
  const counter = { connections: 0 }
  const server = net.createServer((client) => {
    counter.connections++
    const upstream = net.connect(Number(target.port), target.hostname)
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => {
        client.destroy()
        upstream.destroy()
      })
    }
    client.pipe(upstream).pipe(client)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  const proxied = new URL(url)
  proxied.hostname = '127.0.0.1'
  proxied.port = String(address.port)
  return {
    url: proxied.toString(),
    connections: () => counter.connections,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe('postgres.js after a connection drops mid-query', () => {
  it('a transaction rejects, and its rollback on the dead connection throws nothing later', async () => {
    const uncaught = vi.fn()
    process.on('uncaughtException', uncaught)
    onTestFinished(() => {
      process.off('uncaughtException', uncaught)
    })
    const handle = openHandle(2)

    const { running: transaction } = await dropMidQuery(
      () =>
        handle.db.transaction(async (tx) => {
          await tx.execute(sleepQuery('mylib_t7_crash'))
        }),
      'mylib_t7_crash',
    )

    const error: unknown = await transaction.then(
      () => 'resolved',
      (e: unknown) => e,
    )
    expect(errorCode(error)).toBe('CONNECTION_CLOSED')
    // upstream 3.4.9 writes begin's ROLLBACK to the null socket in a setImmediate: give it time to throw
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(uncaught).not.toHaveBeenCalled()
    // and the pool still works
    await expect(handle.db.execute(sql`select 1 as ok`)).resolves.toBeDefined()
  })

  it('a reconnect the server refuses rejects at once, without a reconnect loop, and the pool recovers', async () => {
    const proxy = await countingProxy(scratch.url)
    try {
      const handle = createDb(proxy.url, { max: 1 })
      try {
        await handle.db.execute(sql`select 1`)
        const { running: dropped } = await dropMidQuery(() => handle.db.execute(sleepQuery('mylib_t7_loop')), 'mylib_t7_loop')
        await expect(dropped).rejects.toBeDefined()

        const connectsBefore = proxy.connections()
        await simulateInterruptedSwap(scratch.url)
        try {
          const next = once(handle.db.execute(sql`select 1`))
          next.catch(() => undefined)
          // upstream 3.4.9 retries this connect every 0 ms until the database accepts connections again
          expect(await settledWithin(next, 5_000)).toBe('settled')
          const error: unknown = await next.then(
            () => 'resolved',
            (e: unknown) => e,
          )
          expect(errorCode(error)).toBe('55000')
          // one refused connect, and no more after it: not a loop
          expect(proxy.connections() - connectsBefore).toBe(1)
          await new Promise((resolve) => setTimeout(resolve, 300))
          expect(proxy.connections() - connectsBefore).toBe(1)
        } finally {
          await allowConnections(scratch.url)
        }
        await expect(handle.db.execute(sql`select 1 as ok`)).resolves.toBeDefined()
      } finally {
        await handle.close(2)
      }
    } finally {
      await proxy.close()
    }
  })

  it('a graceful end settles at once after such a close', async () => {
    const handle = createDb(scratch.url, { max: 1 })
    await handle.db.execute(sql`select 1`)
    const { running: dropped } = await dropMidQuery(() => handle.db.execute(sleepQuery('mylib_t7_end')), 'mylib_t7_end')
    await expect(dropped).rejects.toBeDefined()
    const ending = handle.close(30)
    try {
      // upstream 3.4.9 waits out the whole timeout (here 30 s), then destroys the connection
      expect(await settledWithin(ending, 3_000)).toBe('settled')
    } finally {
      await ending
    }
  }, 40_000)

  it('a graceful end already waiting on a running query settles once its connection drops', async () => {
    const handle = createDb(scratch.url, { max: 1 })
    await handle.db.execute(sql`select 1`)
    const running = handle.db.execute(sleepQuery('mylib_t7_end_wait'))
    running.catch(() => undefined)
    const watcher = openHandle(1)
    await waitFor(
      async () => {
        const rows = await watcher.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where state = 'active' and query like ${'%mylib_t7_end_wait%'} and pid <> pg_backend_pid()`,
        )
        return (rows[0]?.n ?? 0) > 0
      },
      'the query to run',
      undefined,
      10_000,
    )
    const ending = handle.close(30)
    await waitFor(async () => (await terminateBackendsRunning(scratch.url, 'mylib_t7_end_wait')) > 0, 'the query to run', undefined, 10_000)
    try {
      expect(await settledWithin(ending, 3_000)).toBe('settled')
    } finally {
      await ending
    }
  }, 40_000)
})

/**
 * Fix round 1: the patch's hunks for a socket that closes while connecting. No server can close at exactly
 * the right moment, so these hand postgres.js fake sockets (its `socket` option) that close themselves
 * from `setKeepAlive`. That is the call `connected()` makes just before it queues the StartupMessage, so
 * the close lands after the write is queued but before it is flushed.
 */
class FakeSocket extends Duplex {
  readonly writes: Buffer[] = []
  constructor(private readonly closeOnConnect: boolean) {
    super()
  }
  override _read(): void {
    // the fake server never answers
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.writes.push(chunk)
    callback()
  }
  setKeepAlive(): void {
    if (this.closeOnConnect) process.nextTick(() => this.emit('close', false))
  }
}

function fakeServerClient(closeOnConnect: (attempt: number) => boolean): { sql: postgres.Sql; sockets: FakeSocket[]; stop: () => Promise<void> } {
  const sockets: FakeSocket[] = []
  const state = { stopped: false }
  const options = {
    host: 'fake-host',
    max: 1,
    connect_timeout: 1,
    onnotice: () => undefined,
    socket: () => {
      const socket = new FakeSocket(!state.stopped && closeOnConnect(sockets.length + 1))
      sockets.push(socket)
      return socket
    },
  }
  const sql = postgres(options as postgres.Options<Record<string, never>>)
  const stop = async () => {
    state.stopped = true
    await sql.end({ timeout: 0 })
    // a connect already scheduled still runs; its connect_timeout (1 s) ends it inside this test
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  return { sql, sockets, stop }
}

describe('postgres.js when a socket closes while connecting (fake sockets)', () => {
  it('the next connect sends a clean StartupMessage, not one stuck behind the dead socket’s bytes (stale write)', async () => {
    const { sql: client, sockets, stop } = fakeServerClient((attempt) => attempt === 1)
    client`select 1`.catch(() => undefined)
    try {
      // upstream 3.4.9 kept the cleared timer id, so this second socket was never written to at all
      await waitFor(() => Promise.resolve((sockets[1]?.writes.length ?? 0) > 0), 'the second connect to write', undefined, 3_000)
      const sent = Buffer.concat(sockets[1]?.writes ?? [])
      // exactly one StartupMessage: its own length field covers every byte written
      expect(sent.readInt32BE(0)).toBe(sent.length)
    } finally {
      await stop()
    }
  }, 10_000)

  it('a connect that keeps closing retries on a growing backoff, not every 0 ms (hot loop)', async () => {
    const { sql: client, sockets, stop } = fakeServerClient(() => true)
    client`select 1`.catch(() => undefined)
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      // backoff: about 15–30 ms, 45–90, 135–270, 405–810 … so at most a handful of attempts in a second
      expect(sockets.length).toBeGreaterThanOrEqual(2)
      expect(sockets.length).toBeLessThanOrEqual(8)
    } finally {
      await stop()
    }
  }, 10_000)
})
