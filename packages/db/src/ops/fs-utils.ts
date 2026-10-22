import { access, open } from 'node:fs/promises'
import { DrizzleQueryError } from 'drizzle-orm'

export async function exists(full: string): Promise<boolean> {
  try {
    await access(full)
    return true
  } catch {
    return false
  }
}

/** Makes a rename durable where the platform allows syncing a directory (not on Windows). */
export async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // best effort
  }
}

export async function syncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * An error as one short line for a log or a stored failure: never a stack, never file contents, never query
 * parameters (#5: they hold user data). A failed drizzle query keeps its SQL and the database's reason.
 */
export function describeError(error: unknown): string {
  const message =
    error instanceof DrizzleQueryError
      ? `Failed query: ${error.query}${error.cause === undefined ? '' : ` (${describeError(error.cause)})`}`
      : error instanceof Error
        ? error.message
        : String(error)
  return message.replace(/\bparams:[\s\S]*$/, 'params: [redacted]').replace(/\s+/g, ' ').trim().slice(0, 500)
}

/**
 * 3d Task 7: the line the server's and the worker's `uncaughtException` handlers log before exit(1):
 * the error's name and code, and describeError, never a stack. `origin` is Node's second argument, so an
 * unhandled rejection routed there is labelled as one. Never throws, whatever was thrown (`throw null`).
 */
export function crashLogLine(processName: string, error: unknown, origin: string): string {
  const kind = error instanceof Error ? error.name : typeof error
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  const what = origin === 'unhandledRejection' ? 'unhandled rejection' : 'uncaught exception'
  return `[${processName}] ${what} (${kind}${typeof code === 'string' ? ` ${code}` : ''}), exiting: ${describeError(error)}`
}

/**
 * True for a real Node.js system error (a failed syscall: fs, net, …) — never a `DomainError` (whose
 * `.code` is one of its own four values, e.g. `'INVALID'`, `'CONFLICT'`) and never a Postgres error
 * (whose `.code` is a SQLSTATE like `'53100'`), both of which carry an unrelated `code` string of their
 * own but never `errno` or `syscall`. Fix round 2 regression: describeFsError used to treat any `.code`
 * string as a filesystem error code, silently replacing a DomainError's or a Postgres error's readable
 * message with that unrelated code.
 */
function isNodeSystemError(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  if (!(error instanceof Error)) return false
  const e = error as NodeJS.ErrnoException
  if (typeof e.code !== 'string') return false
  if (typeof e.errno === 'number' || typeof e.syscall === 'string') return true
  return /^E[A-Z0-9]+$/.test(e.code) && typeof e.syscall === 'string'
}

/** A file-system error is logged by its code only: its message would name a path. Anything else (a
 * DomainError, a Postgres error, a plain Error) keeps its own readable message via describeError. */
export function describeFsError(error: unknown): string {
  return isNodeSystemError(error) ? error.code : describeError(error)
}

/** 3d item 6: why `signal` aborted, as an Error (its reason when that is one). */
export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted')
}

/** 3d item 6: rejects with the signal's reason (an Error) as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      if (signal !== undefined) reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 3d item 6 (ruling P6): `promise`, or a rejection with the signal's reason as soon as it aborts. The
 * promise itself keeps running; a rejection it settles with later is swallowed.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  promise.catch(() => undefined)
  if (signal.aborted) return Promise.reject(abortReason(signal))
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  })
}

/**
 * 3d item 6: `promise`, or a rejection (code TIME_LIMIT, naming only `what`) once `ms` pass without it
 * settling. The promise itself keeps running; a rejection it settles with later is swallowed.
 */
export async function withTimeLimit<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  promise.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} did not finish within ${Math.round(ms / 1000)} s`), { code: 'TIME_LIMIT' })), ms)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}
