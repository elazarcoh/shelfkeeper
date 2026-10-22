import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { describe, expect, it, vi } from 'vitest'
import { createDb } from '../client'
import { allowConnections, createScratchDatabase, loseOpsLock, opsLockBackend, simulateInterruptedSwap, terminateBackend, waitFor } from '../testing'
import {
  countOtherSessions,
  createEmptyDatabase,
  createOpsLockClient,
  DatabaseUnreachableError,
  databaseUnreachableNow,
  endOpsLockClient,
  ensureConnectionsAllowed,
  isDatabaseUnreachable,
  listDatabases,
  MAINTENANCE_DATABASE,
  OPS_LOCK_CHECK_TIMEOUT_MS,
  OpsBusyError,
  OpsLockLostError,
  swapInDatabase,
  unreachableCode,
  waitForPostgres,
  withDatabase,
  withOpsLock,
} from './database-admin'
import { sleep } from './fs-utils'

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

/** Resolves once some session waits (not granted) on the advisory lock keyed `hashtext(key)` in the maintenance database. */
async function waitForBlockedAdvisoryLock(url: string, key: string, timeoutMs = 10_000): Promise<void> {
  const admin = postgres(withDatabase(url, MAINTENANCE_DATABASE), { max: 1, onnotice: () => undefined })
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const [row] = await admin<{ blocked: boolean }[]>`
        select exists (
          select 1 from pg_locks l
          where l.locktype = 'advisory' and not l.granted
            and l.database = (select oid from pg_database where datname = ${MAINTENANCE_DATABASE})
            and l.objid = (hashtext(${key})::bigint & 4294967295)::oid
        ) as blocked`
      if (row?.blocked === true) return
      if (Date.now() >= deadline) throw new Error('the second lock request never queued on the advisory lock')
      await sleep(20)
    }
  } finally {
    await admin.end()
  }
}

/** A connect failure as postgres.js reports it: a network errno code, or a server SQLSTATE. */
function unreachable(code: string, message = `failed: ${code}`): Error {
  return Object.assign(new Error(message), { code })
}

describe('database admin', () => {
  it('lets one backup or restore hold the lock per live database, and only one', async () => {
    const a = await createScratchDatabase()
    const b = await createScratchDatabase()
    try {
      await withOpsLock(a.url, 'backup', async () => {
        await expect(withOpsLock(a.url, 'backup', () => Promise.resolve('second'))).rejects.toBeInstanceOf(OpsBusyError)
        expect(await withOpsLock(b.url, 'backup', () => Promise.resolve('another database'))).toBe('another database')
        expect(await withOpsLock(a.url, 'migrate', () => Promise.resolve('another lock'))).toBe('another lock')
      })
      expect(await withOpsLock(a.url, 'backup', () => Promise.resolve('free again'))).toBe('free again')
    } finally {
      await a.drop()
      await b.drop()
    }
  })

  it('waits for the lock when asked to', async () => {
    const a = await createScratchDatabase()
    try {
      const order: string[] = []
      const holding = gate()
      const release = gate()
      const first = withOpsLock(a.url, 'migrate', async () => {
        order.push('first in')
        holding.open()
        await release.opened
        order.push('first out')
      })
      await holding.opened
      const second = withOpsLock(a.url, 'migrate', () => Promise.resolve(order.push('second')), { wait: true })
      // the second caller is queued on the advisory lock itself (a not-granted lock in pg_locks), not merely scheduled
      await waitForBlockedAdvisoryLock(a.url, `mylib:migrate:${a.name}`)
      expect(order).toEqual(['first in'])
      release.open()
      await first
      await second
      expect(order).toEqual(['first in', 'first out', 'second'])
    } finally {
      await a.drop()
    }
  })

  it('swaps a replacement database in under the live name, and an open pool reconnects to it', async () => {
    const live = await createScratchDatabase('empty')
    try {
      await live.db.execute(sql`create table marker (v text)`)
      await live.db.execute(sql`insert into marker values ('old')`)
      const replacement = `${live.name}_restore`
      await createEmptyDatabase(live.url, replacement)
      const staged = createDb(withDatabase(live.url, replacement), { max: 1 })
      await staged.db.execute(sql`create table marker (v text)`)
      await staged.db.execute(sql`insert into marker values ('new')`)
      await staged.close()

      const pool = createDb(live.url, { max: 2 })
      await pool.db.execute(sql`select 1`)
      await swapInDatabase(live.url, replacement, `${live.name}_prev_x`)

      expect(await pool.db.execute(sql`select v from marker`)).toEqual([{ v: 'new' }])
      const prev = createDb(withDatabase(live.url, `${live.name}_prev_x`), { max: 1 })
      expect(await prev.db.execute(sql`select v from marker`)).toEqual([{ v: 'old' }])
      await prev.close()
      await pool.close()
      expect(await listDatabases(live.url, `${live.name}_prev_`)).toEqual([`${live.name}_prev_x`])
    } finally {
      await live.drop()
    }
  })

  it('leaves the live database usable and unrenamed when the swap fails', async () => {
    const live = await createScratchDatabase()
    try {
      await expect(swapInDatabase(live.url, `${live.name}_missing`, `${live.name}_prev_y`)).rejects.toThrow()
      const pool = createDb(live.url, { max: 1 })
      expect(await pool.db.execute(sql`select 1 as one`)).toEqual([{ one: 1 }])
      await pool.close()
      expect(await listDatabases(live.url, `${live.name}_prev_`)).toEqual([])
    } finally {
      await live.drop()
    }
  })

  it('re-allows connections on a live database an interrupted swap left refusing them, and leaves a healthy one alone', async () => {
    const live = await createScratchDatabase()
    try {
      const logs: string[] = []
      const log = (message: string) => logs.push(message)
      expect(await ensureConnectionsAllowed(live.url, log)).toBe(false)
      expect(logs).toEqual([])

      await simulateInterruptedSwap(live.url)
      const refused = createDb(live.url, { max: 1 })
      await expect(refused.db.execute(sql`select 1`)).rejects.toThrow()
      await refused.close()

      expect(await ensureConnectionsAllowed(live.url, log)).toBe(true)
      expect(logs).toHaveLength(1)
      expect(logs[0]).not.toContain(new URL(live.url).password)
      const pool = createDb(live.url, { max: 1 })
      expect(await pool.db.execute(sql`select 1 as one`)).toEqual([{ one: 1 }])
      await pool.close()
    } finally {
      await allowConnections(live.url)
      await live.drop()
    }
  })

  it('leaves the live database alone while another process holds the backup lock (a restore mid-swap reopens it itself)', async () => {
    const live = await createScratchDatabase()
    try {
      await simulateInterruptedSwap(live.url)
      await withOpsLock(live.url, 'backup', async () => {
        expect(await ensureConnectionsAllowed(live.url, () => undefined)).toBe(false)
      })
      const refused = createDb(live.url, { max: 1 })
      await expect(refused.db.execute(sql`select 1`)).rejects.toThrow()
      await refused.close()
    } finally {
      await allowConnections(live.url)
      await live.drop()
    }
  })

  it('waits for the backup lock when asked to (the app), then re-allows connections (final fix: re-review)', async () => {
    const live = await createScratchDatabase()
    try {
      await simulateInterruptedSwap(live.url)
      const holding = gate()
      const release = gate()
      const held = withOpsLock(live.url, 'backup', async () => {
        holding.open()
        await release.opened
      })
      await holding.opened
      let settled = false
      const ensured = ensureConnectionsAllowed(live.url, () => undefined, { waitForLock: true }).finally(() => {
        settled = true
      })
      await waitForBlockedAdvisoryLock(live.url, `mylib:backup:${live.name}`)
      expect(settled).toBe(false)
      release.open()
      await held
      expect(await ensured).toBe(true)
      const pool = createDb(live.url, { max: 1 })
      expect(await pool.db.execute(sql`select 1 as one`)).toEqual([{ one: 1 }])
      await pool.close()
    } finally {
      await allowConnections(live.url)
      await live.drop()
    }
  })

  it('keeps waiting for an unreachable database by default, logging the error code (never its message) while it waits (final fix 3)', async () => {
    let calls = 0
    const connect = () => {
      calls++
      return calls <= 5 ? Promise.reject(unreachable('ECONNREFUSED', 'connect ECONNREFUSED u:secret@db:5432')) : Promise.resolve()
    }
    const logs: string[] = []
    await waitForPostgres('postgres://u:secret@db:5432/mylib', { connect, delayMs: 1, logEveryMs: 0, log: (message) => logs.push(message) })
    expect(calls).toBe(6)
    expect(logs).toHaveLength(5)
    expect(logs[0]).toContain('ECONNREFUSED')
    expect(logs.join('\n')).not.toContain('secret')
  })

  it('waits through every "unreachable or still starting" error: network codes and SQLSTATE 57P01/57P02/57P03', async () => {
    const codes = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', '57P03', '57P01', '57P02']
    let calls = 0
    const connect = () => {
      const code = codes[calls++]
      return code === undefined ? Promise.resolve() : Promise.reject(unreachable(code))
    }
    await waitForPostgres('postgres://u:p@db:5432/mylib', { connect, delayMs: 1, log: () => undefined })
    expect(calls).toBe(codes.length + 1)
  })

  it('rethrows a real verdict at once, without waiting: bad password, no such role or database (final fix: re-review)', async () => {
    for (const code of ['28P01', '28000', '3D000']) {
      let calls = 0
      const logs: string[] = []
      const connect = () => {
        calls++
        return Promise.reject(unreachable(code))
      }
      await expect(waitForPostgres('postgres://u:p@db:5432/mylib', { connect, delayMs: 60_000, log: (message) => logs.push(message) })).rejects.toMatchObject({ code })
      expect(calls).toBe(1)
      expect(logs).toEqual([])
    }
  })

  it('rethrows an error with no code at once', async () => {
    await expect(waitForPostgres('postgres://u:p@db:5432/mylib', { connect: () => Promise.reject(new Error('bug')), delayMs: 60_000, log: () => undefined })).rejects.toThrow('bug')
  })

  it('logs a still-waiting line at most once per interval, and never when the database answers at once', async () => {
    const logs: string[] = []
    const log = (message: string) => logs.push(message)
    await waitForPostgres('postgres://u:p@db:5432/mylib', { connect: () => Promise.resolve(), log })
    expect(logs).toEqual([])
    let calls = 0
    const connect = () => (++calls <= 2 ? Promise.reject(unreachable('ECONNREFUSED')) : Promise.resolve())
    await waitForPostgres('postgres://u:p@db:5432/mylib', { connect, delayMs: 1, log })
    expect(calls).toBe(3)
    expect(logs).toHaveLength(1)
  })

  it('stops waiting for an unreachable database as soon as its signal aborts, rejecting with the reason (3d item 6)', async () => {
    const controller = new AbortController()
    const waiting = waitForPostgres('postgres://u:p@db:5432/mylib', { connect: () => Promise.reject(unreachable('ECONNREFUSED')), delayMs: 60_000, log: () => undefined, signal: controller.signal })
    await sleep(50)
    const reason = new Error('shutting down')
    const began = Date.now()
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(Date.now() - began).toBeLessThan(1_000)
  })

  it('an abort does not wait out a connect attempt still in flight (3d item 6, ruling P6)', async () => {
    const controller = new AbortController()
    let calls = 0
    const hanging = () => {
      calls++
      return new Promise<void>(() => undefined) // a connect that would sit out its whole 30 s timeout
    }
    const waiting = waitForPostgres('postgres://u:p@db:5432/mylib', { connect: hanging, log: () => undefined, signal: controller.signal })
    await sleep(50)
    const reason = new Error('shutting down')
    const began = Date.now()
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(Date.now() - began).toBeLessThan(1_000)
    expect(calls).toBe(1)
  })

  it('never tries to connect once its signal has already aborted (3d item 6)', async () => {
    const reason = new Error('shutting down')
    let calls = 0
    const connect = () => {
      calls++
      return Promise.resolve()
    }
    await expect(waitForPostgres('postgres://u:p@db:5432/mylib', { connect, log: () => undefined, signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    expect(calls).toBe(0)
  })

  it('sleep rejects with the signal reason as soon as it aborts (3d item 6)', async () => {
    const controller = new AbortController()
    const reason = new Error('shutting down')
    const began = Date.now()
    const sleeping = sleep(60_000, controller.signal)
    setTimeout(() => controller.abort(reason), 20)
    await expect(sleeping).rejects.toBe(reason)
    expect(Date.now() - began).toBeLessThan(1_000)
    await expect(sleep(60_000, AbortSignal.abort(reason))).rejects.toBe(reason)
    await expect(sleep(1, controller.signal)).rejects.toBe(reason)
    await sleep(1, new AbortController().signal)
  })

  it('still gives up after an explicit number of attempts', async () => {
    await expect(
      waitForPostgres('postgres://u:p@db:5432/mylib', { connect: () => Promise.reject(unreachable('ECONNREFUSED', 'down')), attempts: 3, delayMs: 1, log: () => undefined }),
    ).rejects.toThrow('down')
  })

  it('classifies an unreachable database through wrapped causes and a lost lock, never a verdict (3d item 7)', () => {
    expect(unreachableCode(unreachable('ECONNREFUSED'))).toBe('ECONNREFUSED')
    expect(unreachableCode(new Error('Migration 9999 failed', { cause: unreachable('57P01') }))).toBe('57P01')
    expect(unreachableCode(new DatabaseUnreachableError('CONNECTION_CLOSED'))).toBe('CONNECTION_CLOSED')
    expect(unreachableCode(new OpsLockLostError('migrate'))).toBe('OPS_LOCK_LOST')
    expect(unreachableCode(unreachable('28P01'))).toBeNull()
    expect(unreachableCode(new Error('bug'))).toBeNull()
    expect(isDatabaseUnreachable(new Error('outer', { cause: new Error('middle', { cause: unreachable('ETIMEDOUT') }) }))).toBe(true)
  })

  it('a DatabaseUnreachableError says the code only, never the wrapped message (3d item 7)', () => {
    const error = new DatabaseUnreachableError('ECONNREFUSED', { cause: unreachable('ECONNREFUSED', 'connect ECONNREFUSED u:secret@db:5432') })
    expect(error).toMatchObject({ name: 'DatabaseUnreachableError', code: 'ECONNREFUSED' })
    expect(error.message).not.toContain('secret')
  })

  it('a lost lock names the lock it was (3d item 7, Task 2 review)', () => {
    expect(new OpsLockLostError('backup').message).toContain('backup and restore lock')
    expect(new OpsLockLostError('migrate').message).toContain('migration lock')
    expect(new OpsLockLostError('migrate').message).not.toContain('backup')
  })

  it('databaseUnreachableNow asks the database itself: null when it answers, the code when it does not (3d item 7)', async () => {
    const a = await createScratchDatabase()
    try {
      expect(await databaseUnreachableNow(a.url)).toBeNull()
    } finally {
      await a.drop()
    }
    expect(await databaseUnreachableNow('postgres://u:p@127.0.0.1:1/nowhere')).toBe('ECONNREFUSED')
  })

  it('never rejects a finished operation because its lock session failed to close; it logs instead (final fix 6)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(endOpsLockClient({ end: () => Promise.reject(new Error('socket already gone')) })).resolves.toBeUndefined()
      expect(error).toHaveBeenCalledWith(expect.stringContaining('socket already gone'))
    } finally {
      error.mockRestore()
    }
  })

  it('counts sessions other than its own connection to the live database (the restore CLI\'s pre-flight check)', async () => {
    const live = await createScratchDatabase()
    try {
      expect(await countOtherSessions(live.url)).toBe(0)
      const pool = createDb(live.url, { max: 1 })
      await pool.db.execute(sql`select 1`)
      expect(await countOtherSessions(live.url)).toBe(1)
      await pool.close()
      expect(await countOtherSessions(live.url)).toBe(0)
    } finally {
      await live.drop()
    }
  })

  it('never lets the pool force-close the lock-holding client while a lock is held (R1)', async () => {
    // no real connection is made here: postgres() connects lazily, so this only inspects the
    // resolved options that withOpsLock's client is created with
    const client = createOpsLockClient('postgres://u:p@localhost:5432/dummy')
    try {
      expect(client.options.max_lifetime).toBeNull()
      expect(client.options.idle_timeout).toBeUndefined()
    } finally {
      await client.end({ timeout: 0 })
    }
  })

  it('aborts the guard once the lock session is gone, and the lock is then free for another caller (3d item 4)', async () => {
    const a = await createScratchDatabase()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await withOpsLock(
        a.url,
        'backup',
        async (guard) => {
          await guard.assertHeld()
          await terminateBackend(a.url, guard.holder.pid)
          await waitFor(() => Promise.resolve(guard.signal.aborted), 'the heartbeat to notice', undefined, 5_000)
          expect(guard.signal.reason).toBeInstanceOf(OpsLockLostError)
          await expect(guard.assertHeld()).rejects.toBeInstanceOf(OpsLockLostError)
          // which is exactly the danger: another backup or restore could start now
          expect(await withOpsLock(a.url, 'backup', () => Promise.resolve('another caller'))).toBe('another caller')
        },
        { heartbeatMs: 50 },
      )
    } finally {
      error.mockRestore()
      await a.drop()
    }
  })

  it('assertHeld notices a lost session at once, before any heartbeat, and aborts the signal (3d item 4)', async () => {
    const a = await createScratchDatabase()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await withOpsLock(
        a.url,
        'migrate',
        async (guard) => {
          await terminateBackend(a.url, guard.holder.pid)
          await expect(guard.assertHeld()).rejects.toBeInstanceOf(OpsLockLostError)
          expect(guard.signal.aborted).toBe(true)
        },
        { heartbeatMs: 60_000 },
      )
    } finally {
      error.mockRestore()
      await a.drop()
    }
  })

  it('a healthy lock is never reported lost by its heartbeat (3d item 4)', async () => {
    const a = await createScratchDatabase()
    try {
      await withOpsLock(
        a.url,
        'backup',
        async (guard) => {
          expect(guard.holder.key).toBe(`mylib:backup:${a.name}`)
          await sleep(400)
          expect(guard.signal.aborted).toBe(false)
          await guard.assertHeld()
        },
        { heartbeatMs: 50 },
      )
    } finally {
      await a.drop()
    }
  })

  it('a heartbeat that errors on a session still alive ends that session before aborting, so the lock is free to re-take; the log carries the code only (3d item 4, ruling P8)', async () => {
    const a = await createScratchDatabase()
    const logged: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
    try {
      const failing = { value: false }
      await withOpsLock(
        a.url,
        'backup',
        async (guard) => {
          failing.value = true
          await waitFor(() => Promise.resolve(guard.signal.aborted), 'the heartbeat to fail', undefined, 5_000)
          // our own session was ended first: the lock is not left held by a session nobody checks any more
          expect(await opsLockBackend(a.url, 'backup')).toBeNull()
          expect(await withOpsLock(a.url, 'backup', () => Promise.resolve('re-taken'))).toBe('re-taken')
        },
        {
          heartbeatMs: 50,
          testOnly: {
            check: () => (failing.value ? Promise.reject(Object.assign(new Error('failed for postgres://user:secret@db/x'), { code: 'XX000' })) : Promise.resolve(true)),
          },
        },
      )
      expect(logged.some((line) => line.includes('XX000'))).toBe(true)
      expect(logged.some((line) => line.includes('secret'))).toBe(false)
    } finally {
      error.mockRestore()
      await a.drop()
    }
  })

  it('a lock check that never answers counts as a lost lock once its time is up, at a commit point and in the heartbeat (fix round 1)', async () => {
    expect(OPS_LOCK_CHECK_TIMEOUT_MS).toBe(10_000)
    const a = await createScratchDatabase()
    const logged: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
    try {
      const never = () => new Promise<boolean>(() => undefined)
      // a commit point: assertHeld does not hang, it gives up and reports the lock lost
      await withOpsLock(
        a.url,
        'backup',
        async (guard) => {
          const startedAt = Date.now()
          await expect(guard.assertHeld()).rejects.toBeInstanceOf(OpsLockLostError)
          expect(Date.now() - startedAt).toBeLessThan(5_000)
          expect(guard.signal.aborted).toBe(true)
          // its session was ended: the lock is free
          expect(await withOpsLock(a.url, 'backup', () => Promise.resolve('re-taken'))).toBe('re-taken')
        },
        { heartbeatMs: 60_000, testOnly: { check: never, checkTimeoutMs: 200 } },
      )
      // the heartbeat: a hung check aborts the guard instead of silently stopping the heartbeat
      await withOpsLock(
        a.url,
        'backup',
        async (guard) => {
          await waitFor(() => Promise.resolve(guard.signal.aborted), 'the heartbeat to give up', undefined, 5_000)
          expect(guard.signal.reason).toBeInstanceOf(OpsLockLostError)
        },
        { heartbeatMs: 50, testOnly: { check: never, checkTimeoutMs: 200 } },
      )
      expect(logged.filter((line) => line.includes('OPS_LOCK_CHECK_TIMEOUT'))).toHaveLength(2)
    } finally {
      error.mockRestore()
      await a.drop()
    }
  })

  it('swapInDatabase re-checks the lock inside its rename transaction: a loss after the first check still renames nothing (fix round 1)', async () => {
    const live = await createScratchDatabase('empty')
    const replacement = `${live.name}_restore`
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await createEmptyDatabase(live.url, replacement)
      await live.close()
      await withOpsLock(
        live.url,
        'backup',
        async (guard) => {
          const swap = swapInDatabase(live.url, replacement, `${live.name}_prev_x`, {
            lockHolder: guard.holder,
            // the first check has passed and the sessions are gone; the lock goes now
            testOnly: { beforeRenameTransaction: () => loseOpsLock(live.url, 'backup') },
          })
          await expect(swap).rejects.toBeInstanceOf(OpsLockLostError)
        },
        { heartbeatMs: 60_000 },
      )
      expect(await listDatabases(live.url, live.name)).toEqual([live.name, replacement].sort())
      // reopened as it was
      const client = postgres(live.url, { max: 1, onnotice: () => undefined })
      try {
        expect(await client`select 1 as one`).toEqual([{ one: 1 }])
      } finally {
        await client.end()
      }
    } finally {
      error.mockRestore()
      await live.drop()
    }
  })

  it('swapInDatabase refuses to rename anything when the given lock holder no longer holds the lock (3d item 4)', async () => {
    const live = await createScratchDatabase('empty')
    const replacement = `${live.name}_restore`
    try {
      await createEmptyDatabase(live.url, replacement)
      await expect(swapInDatabase(live.url, replacement, `${live.name}_prev_x`, { lockHolder: { pid: 2_147_483_647, key: `mylib:backup:${live.name}` } })).rejects.toBeInstanceOf(OpsLockLostError)
      expect(await listDatabases(live.url, live.name)).toEqual([live.name, replacement].sort())
      // still accepting connections
      await live.db.execute(sql`select 1`)
    } finally {
      await live.drop()
    }
  })

  it('swapInDatabase swaps when the given lock holder does hold the lock (3d item 4)', async () => {
    const live = await createScratchDatabase('empty')
    const replacement = `${live.name}_restore`
    try {
      await createEmptyDatabase(live.url, replacement)
      await live.close()
      await withOpsLock(live.url, 'backup', (guard) => swapInDatabase(live.url, replacement, `${live.name}_prev_x`, { lockHolder: guard.holder }))
      expect(await listDatabases(live.url, live.name)).toEqual([live.name, `${live.name}_prev_x`].sort())
    } finally {
      await live.drop()
    }
  })
})
