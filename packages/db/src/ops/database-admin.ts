import postgres from 'postgres'
import { DomainError } from '@mylib/domain'
import { abortReason, describeError, sleep, untilAborted } from './fs-utils'

/** Locks, create/drop and the swap all run from here: never from the database being swapped. */
export const MAINTENANCE_DATABASE = 'postgres'

export function withDatabase(url: string, name: string): string {
  const u = new URL(url)
  u.pathname = `/${encodeURIComponent(name)}`
  return u.toString()
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1))
}

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`

function adminClient(url: string): postgres.Sql {
  return postgres(withDatabase(url, MAINTENANCE_DATABASE), { max: 1, onnotice: () => undefined })
}

/**
 * Controller ruling R1: the client holding the ops advisory lock must never be force-closed by the
 * pool while a long backup/restore/migration runs under it, so it can't silently drop the lock —
 * no lifetime cap, no idle timeout. Exported (beyond the brief's interface list) only so a test can
 * pin these options; it is not part of the public ops API.
 */
export function createOpsLockClient(url: string): postgres.Sql {
  return postgres(withDatabase(url, MAINTENANCE_DATABASE), {
    max: 1,
    onnotice: () => undefined,
    max_lifetime: null,
    idle_timeout: undefined,
  })
}

export class OpsBusyError extends DomainError {
  constructor(message = 'A backup or restore is already running — try again when it finishes') {
    super('CONFLICT', message)
  }
}

export type OpsLock = 'backup' | 'migrate'

/**
 * 3d item 4: the session holding the ops lock is gone, so the lock is too; the operation stops before its
 * next commit point. 3d item 7 (Task 2 review): the message names the lock that was lost.
 */
export class OpsLockLostError extends Error {
  override readonly name = 'OpsLockLostError'
  constructor(readonly lock: OpsLock) {
    super(
      lock === 'migrate'
        ? 'The migration lock was lost (its database connection dropped), so no further migration was started'
        : 'The backup and restore lock was lost (its database connection dropped), so the operation stopped before changing anything else',
    )
  }
}

export interface OpsLockHolder {
  /** the backend that took the lock */
  pid: number
  /** the text hashed into the lock key: `mylib:<lock>:<database>` */
  key: string
}

/** 3d item 4: handed to the code running under withOpsLock. */
export interface OpsLockGuard {
  /** aborted, with an OpsLockLostError as its reason, once the lock's session is found gone (and has been ended) */
  readonly signal: AbortSignal
  /** a live check against pg_locks; throws OpsLockLostError (and aborts `signal`) when the lock is gone */
  assertHeld(): Promise<void>
  readonly holder: OpsLockHolder
}

/** How often withOpsLock checks its own lock while an operation runs. */
export const OPS_LOCK_HEARTBEAT_MS = 5_000

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

/**
 * True while backend `holder.pid` holds the session advisory lock `hashtext(holder.key)` in the
 * maintenance database. Run on the lock client itself: if its connection dropped, postgres.js has
 * reconnected as a new backend, which holds nothing, so the answer is false.
 */
async function opsLockHeld(sql: postgres.Sql | postgres.TransactionSql, holder: OpsLockHolder): Promise<boolean> {
  const [row] = await sql<{ held: boolean }[]>`
    select exists (
      select 1 from pg_locks
      where locktype = 'advisory' and granted and pid = ${holder.pid} and objsubid = 1
        and database = (select oid from pg_database where datname = ${MAINTENANCE_DATABASE})
        and classid = ((hashtext(${holder.key})::bigint >> 32) & 4294967295)::oid
        and objid = (hashtext(${holder.key})::bigint & 4294967295)::oid
    ) as held`
  return row?.held === true
}

/**
 * 3d fix round 1: how long one lock check may take before the lock counts as lost (decision 3). The
 * query reads pg_locks, which is in shared memory, on a connection already open: it answers in
 * milliseconds even on the Pi with pg_restore saturating its disk. 10 s is two heartbeats, far above
 * any healthy answer, yet a half-open connection (where the query would otherwise wait for the
 * kernel's TCP give-up, about 15 minutes) stops the operation within seconds instead.
 */
export const OPS_LOCK_CHECK_TIMEOUT_MS = 10_000

/** Test seams for withOpsLock. Production code never sets them: they can switch off the safety check. */
export interface OpsLockTestOnly {
  /** replaces the live pg_locks check */
  check?: (sql: postgres.Sql, holder: OpsLockHolder) => Promise<boolean>
  /** default OPS_LOCK_CHECK_TIMEOUT_MS */
  checkTimeoutMs?: number
}

export interface OpsLockOptions {
  wait?: boolean
  /** default OPS_LOCK_HEARTBEAT_MS */
  heartbeatMs?: number
  /** tests only, never production code */
  testOnly?: OpsLockTestOnly
}

/** Rejects with code OPS_LOCK_CHECK_TIMEOUT once `ms` pass without an answer. */
async function answerWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('the lock check did not answer in time'), { code: 'OPS_LOCK_CHECK_TIMEOUT' })), ms)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Runs `fn` holding a session advisory lock taken on the maintenance database, keyed by the live
 * database's name (plan deviation 5). It survives the live database being renamed, and dies with
 * this process. Without `wait`, a held lock is an OpsBusyError.
 *
 * 3d item 4: the lock lives only as long as its session. A heartbeat checks it every `heartbeatMs`.
 * Once the check fails (any error counts, decision 3), the session is ended first (ruling P8: a check
 * that merely errored may leave it still holding the lock, which would block the clean-up that needs to
 * re-take it), and only then does `guard.signal` abort, which kills a pg tool still running. Code under
 * the lock calls `guard.assertHeld()` before each commit point. A check with no answer within
 * OPS_LOCK_CHECK_TIMEOUT_MS counts as a lost lock.
 */
export async function withOpsLock<T>(url: string, lock: OpsLock, fn: (guard: OpsLockGuard) => Promise<T>, options: OpsLockOptions = {}): Promise<T> {
  const admin = createOpsLockClient(url)
  const key = `mylib:${lock}:${databaseName(url)}`
  // set once the lock is found gone: ending the session, then aborting the signal
  const lost: { ending: Promise<void> | null } = { ending: null }
  let heartbeat: ReturnType<typeof setInterval> | undefined
  try {
    let pid: number
    if (options.wait === true) {
      const [row] = await admin<{ pid: number }[]>`select pg_advisory_lock(hashtext(${key})), pg_backend_pid() as pid`
      if (row === undefined) throw new Error('pg_advisory_lock returned no row')
      pid = row.pid
    } else {
      const [row] = await admin<{ locked: boolean; pid: number }[]>`select pg_try_advisory_lock(hashtext(${key})) as locked, pg_backend_pid() as pid`
      if (row?.locked !== true) throw new OpsBusyError()
      pid = row.pid
    }
    const holder: OpsLockHolder = { pid, key }
    const controller = new AbortController()
    const check = options.testOnly?.check ?? opsLockHeld
    const checkTimeoutMs = options.testOnly?.checkTimeoutMs ?? OPS_LOCK_CHECK_TIMEOUT_MS
    const lose = (code: string): Promise<void> => {
      if (lost.ending === null) {
        // the code only: never the error's message
        console.error(`[ops] the ${lock} lock is no longer held (${code}); ending its session and stopping the operation`)
        // postgres.js's own CONNECTION_* codes: the socket is already closed, so there is nothing to wait for.
        // A 5 s end that gives up only destroys the socket: the backend may hold the lock a moment longer,
        // which is why a restore's clean-up keeps trying to re-take it (restore.ts, underRetakenLock)
        const closed = code.startsWith('CONNECTION_')
        lost.ending = endOpsLockClient(admin, closed ? 0 : 5).then(() => controller.abort(new OpsLockLostError(lock)))
      }
      return lost.ending
    }
    const assertHeld = async (): Promise<void> => {
      if (lost.ending === null) {
        let held = false
        let code = 'OPS_LOCK_LOST'
        try {
          // fix round 1: a check that never answers is a lost lock too, not a stalled operation
          held = await answerWithin(check(admin, holder), checkTimeoutMs)
        } catch (error) {
          code = errorCode(error) ?? 'unknown'
        }
        if (!held) await lose(code)
      }
      if (lost.ending !== null) {
        await lost.ending
        throw new OpsLockLostError(lock)
      }
    }
    const state = { checking: false }
    heartbeat = setInterval(() => {
      if (state.checking || lost.ending !== null) return
      state.checking = true
      void assertHeld()
        .catch(() => undefined)
        .finally(() => {
          state.checking = false
        })
    }, options.heartbeatMs ?? OPS_LOCK_HEARTBEAT_MS)
    heartbeat.unref()
    return await fn({ signal: controller.signal, assertHeld, holder })
  } finally {
    clearInterval(heartbeat)
    // closing the session releases the lock (a lost lock's session is already being ended)
    await (lost.ending ?? endOpsLockClient(admin))
  }
}

/**
 * Final fix 6: the operation under the lock has already finished (or failed on its own) by the time this
 * runs; a failure to close its session must never turn that into a rejection. The session dies with the
 * connection anyway, which releases the lock. Exported only for its test.
 *
 * A graceful end waits until the server has ended the session, so the lock is free once this resolves.
 * `timeoutSeconds` 0 skips that wait: only for a connection postgres.js already reports closed, whose
 * graceful end would otherwise sit out the whole timeout.
 */
export async function endOpsLockClient(client: Pick<postgres.Sql, 'end'>, timeoutSeconds = 5): Promise<void> {
  try {
    await client.end({ timeout: timeoutSeconds })
  } catch (error) {
    console.error(`[ops] could not close the lock session cleanly: ${describeError(error)}`)
  }
}

export interface WaitForPostgresOptions {
  /** default: no limit — an unreachable database (after a power cut, say) is waited for, never a verdict */
  attempts?: number
  delayMs?: number
  /** a still-waiting line at most this often (default a minute); never the error itself, which can carry the URL */
  logEveryMs?: number
  log?: (message: string) => void
  /** tests: replaces the real `select 1` on the maintenance database */
  connect?: (url: string) => Promise<void>
  /** 3d item 6: a shutdown; rejects with its reason at once, even mid-connect (ruling P6) */
  signal?: AbortSignal
}

async function selectOne(url: string): Promise<void> {
  const admin = adminClient(url)
  try {
    await admin`select 1`
  } finally {
    await admin.end({ timeout: 1 })
  }
}

/**
 * Re-review: the only failures worth waiting through — the server is unreachable (network errno codes,
 * and postgres.js's own CONNECT_TIMEOUT / CONNECTION_CLOSED) or still starting / shutting down (SQLSTATE 57P01 admin
 * shutdown, 57P02 crash shutdown, 57P03 cannot connect now). Anything else — a bad password (28P01), an
 * unknown role (28000) or database (3D000), a bug — is a verdict, rethrown at once.
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECT_TIMEOUT',
  // postgres.js: the server closed the socket mid-handshake (e.g. its container restarting)
  'CONNECTION_CLOSED',
  '57P01',
  '57P02',
  '57P03',
])

/** 3d item 7: a step of start-up failed because the database became unreachable; start-up waits for it and starts again. */
export class DatabaseUnreachableError extends Error {
  override readonly name = 'DatabaseUnreachableError'
  constructor(
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    // the code only: a wrapped message can carry the host, user or URL
    super(`The database became unreachable (${code})`, options)
  }
}

/**
 * 3d item 7: why `error` (or an error it wraps through `cause`, e.g. MigrationFailedError's) means the
 * database is unreachable rather than wrong: an UNREACHABLE_CODES code, a DatabaseUnreachableError, or a
 * lost ops lock (its session dropped). Null for a real verdict.
 */
export function unreachableCode(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth++) {
    if (current instanceof DatabaseUnreachableError) return current.code
    if (current instanceof OpsLockLostError) return 'OPS_LOCK_LOST'
    const code = errorCode(current)
    if (code !== null && UNREACHABLE_CODES.has(code)) return code
    current = current instanceof Error ? current.cause : undefined
  }
  return null
}

export function isDatabaseUnreachable(error: unknown): boolean {
  return unreachableCode(error) !== null
}

/** 3d item 7: for a failure that carries no code (pg_dump's exit status, say), ask the database itself. */
export async function databaseUnreachableNow(url: string): Promise<string | null> {
  try {
    await selectOne(url)
    return null
  } catch (error) {
    return unreachableCode(error)
  }
}

export async function waitForPostgres(url: string, options: WaitForPostgresOptions = {}): Promise<void> {
  const attempts = options.attempts ?? Number.POSITIVE_INFINITY
  const connect = options.connect ?? selectOne
  const log = options.log ?? ((message: string) => console.log(message))
  const logEveryMs = options.logEveryMs ?? 60_000
  const startedAt = Date.now()
  let loggedAt: number | null = null
  const signal = options.signal
  // read through a call: TS would otherwise narrow `signal.aborted` after the first check
  const throwIfStopped = (): void => {
    if (signal?.aborted === true) throw abortReason(signal)
  }
  for (let attempt = 1; ; attempt++) {
    // 3d item 6: a shutdown stops the wait, never starting another attempt
    throwIfStopped()
    let code: string | null
    try {
      // ruling P6: an abort does not wait out a connect in flight (up to postgres.js's 30 s connect timeout)
      await untilAborted(connect(url), signal)
      return
    } catch (error) {
      throwIfStopped()
      code = errorCode(error)
      if (code === null || !UNREACHABLE_CODES.has(code) || attempt >= attempts) throw error
    }
    const now = Date.now()
    if (loggedAt === null || now - loggedAt >= logEveryMs) {
      loggedAt = now
      // the code only: the message can carry the host, user or URL
      log(`[startup] waiting for the database to accept connections (${code}; ${Math.round((now - startedAt) / 1000)} s so far)`)
    }
    await sleep(options.delayMs ?? 1000, signal)
  }
}

/**
 * Final fix 1: swapInDatabase commits `allow_connections false` on the live database on its own, before
 * the rename. A crash in that window would leave it refusing every connection for good, so the app, the
 * worker and the restore CLI call this at start-up, before anything connects to it. It runs under the
 * backup lock, so never under a restore that is mid-swap (which re-allows connections itself on failure).
 * With `waitForLock` (the app, re-review) it waits for that lock; without it (the worker, the CLI) a held
 * lock skips the check. Returns whether it had to re-allow connections.
 */
export async function ensureConnectionsAllowed(
  url: string,
  log: (message: string) => void = (message) => console.log(message),
  options: { waitForLock?: boolean } = {},
): Promise<boolean> {
  const live = databaseName(url)
  try {
    return await withOpsLock(
      url,
      'backup',
      async () => {
        const admin = adminClient(url)
        try {
          const [row] = await admin<{ allowed: boolean }[]>`select datallowconn as allowed from pg_database where datname = ${live}`
          if (row === undefined || row.allowed) return false
          await admin.unsafe(`alter database ${ident(live)} with allow_connections true`)
          log('[startup] the live database was left refusing connections by an interrupted restore; connections are allowed again')
          return true
        } finally {
          await admin.end({ timeout: 5 })
        }
      },
      { wait: options.waitForLock === true },
    )
  } catch (error) {
    if (error instanceof OpsBusyError) return false
    throw error
  }
}

export async function createEmptyDatabase(url: string, name: string): Promise<void> {
  const admin = adminClient(url)
  try {
    await admin.unsafe(`drop database if exists ${ident(name)} with (force)`)
    await admin.unsafe(`create database ${ident(name)} template template0`)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

export async function dropDatabase(url: string, name: string): Promise<void> {
  const admin = adminClient(url)
  try {
    await admin.unsafe(`drop database if exists ${ident(name)} with (force)`)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

export async function listDatabases(url: string, prefix: string): Promise<string[]> {
  const admin = adminClient(url)
  try {
    const rows = await admin<{ datname: string }[]>`select datname from pg_database where starts_with(datname, ${prefix}) order by datname`
    return rows.map((r) => r.datname)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

/**
 * How many sessions other than this call's own are connected to the live database right now. The
 * restore CLI uses this as a pre-flight safety check: unlike a restore triggered from the running
 * app (which is naturally connected to itself), the CLI expects the app and the worker to already
 * be stopped, since it has no in-process maintenance coordination with them.
 */
export async function countOtherSessions(url: string): Promise<number> {
  const admin = adminClient(url)
  try {
    const live = databaseName(url)
    const rows = await admin<{ pid: number }[]>`select pid from pg_stat_activity where datname = ${live} and pid <> pg_backend_pid()`
    return rows.length
  } finally {
    await admin.end({ timeout: 5 })
  }
}

async function terminateSessions(admin: postgres.Sql, database: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const remaining = await admin<{ pid: number }[]>`select pid from pg_stat_activity where datname = ${database} and pid <> pg_backend_pid()`
    if (remaining.length === 0) return
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${database} and pid <> pg_backend_pid()`
    await sleep(50)
  }
  throw new Error(`Sessions on ${database} did not close`)
}

/**
 * Plan deviation 6:
 * - no new connections to the live database, then every session on it is terminated;
 * - both renames run in one transaction, so the live name always names a whole database;
 * - on failure the live database is reopened as it was.
 *
 * 3d item 4: with `lockHolder`, it renames nothing unless that backend still holds the ops lock: checked
 * before connections are refused, and again inside the rename transaction itself.
 */
export async function swapInDatabase(
  url: string,
  replacement: string,
  previousName: string,
  options: { lockHolder?: OpsLockHolder; /** tests only, never production code */ testOnly?: { beforeRenameTransaction?: () => Promise<void> } } = {},
): Promise<void> {
  const live = databaseName(url)
  const admin = adminClient(url)
  const holder = options.lockHolder
  try {
    // never start refusing connections for a swap whose lock is already gone…
    if (holder !== undefined && !(await opsLockHeld(admin, holder))) throw new OpsLockLostError('backup')
    await admin.unsafe(`alter database ${ident(live)} with allow_connections false`)
    try {
      await terminateSessions(admin, live)
      await options.testOnly?.beforeRenameTransaction?.()
      await admin.begin(async (tx) => {
        // …and re-check inside the rename transaction itself, right before the point of no return
        if (holder !== undefined && !(await opsLockHeld(tx, holder))) throw new OpsLockLostError('backup')
        await tx.unsafe(`alter database ${ident(live)} rename to ${ident(previousName)}`)
        await tx.unsafe(`alter database ${ident(replacement)} rename to ${ident(live)}`)
      })
    } catch (error) {
      await admin.unsafe(`alter database ${ident(live)} with allow_connections true`).catch(() => undefined)
      throw error
    }
    // kept for a manual look until the next successful backup drops it (spec §4 step 9)
    try {
      await admin.unsafe(`alter database ${ident(previousName)} with allow_connections true`)
    } catch (error) {
      // the swap itself already committed; only re-opening the old database for a manual look failed —
      // that's not worth failing the whole operation over
      console.error(`swapInDatabase: swap of ${live} succeeded, but could not re-allow connections on ${previousName}: ${describeError(error)}`)
    }
  } finally {
    await admin.end({ timeout: 5 })
  }
}
