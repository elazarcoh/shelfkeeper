import { describeError } from '@mylib/db'

/**
 * 3d item 5 (decision 6): the whole graceful shutdown (the wait for work in flight plus every close
 * step) fits in this, under compose's `stop_grace_period: 120s` for the app with 10 s left to exit.
 */
export const SHUTDOWN_WAIT_MS = 110_000
/** at most this for closing the HTTP server; FORCE_CLOSE_CONNECTIONS_MS into it, open connections are destroyed */
export const CLOSE_SERVER_MS = 5_000
export const CLOSE_DB_MS = 3_000
export const FORCE_CLOSE_CONNECTIONS_MS = 3_000

export interface ShutdownServerDeps {
  /** refuse new restores and "Back up now" from here on; also aborts start-up's waits for the database (3d item 6) */
  stopAccepting: () => void
  /** what must finish before the process may exit: a running restore, and the start-up's backup and migrations */
  inFlight: () => Promise<unknown>[]
  closeServer: () => Promise<void>
  closeDb: () => Promise<void>
  exit: (code: number) => void
  log: (message: string) => void
  /** the whole budget (default SHUTDOWN_WAIT_MS) */
  waitMs?: number
  /** default CLOSE_SERVER_MS */
  closeServerMs?: number
  /** default CLOSE_DB_MS */
  closeDbMs?: number
}

export interface ClosableServer {
  close(callback: (error?: Error) => void): unknown
  closeIdleConnections?(): void
  closeAllConnections?(): void
}

/**
 * 3d item 5: close() alone waits for every open connection. Idle keep-alive connections are closed at
 * once; whatever is still open after `forceAfterMs` (a hung request, a client that never lets go) is destroyed.
 */
export function closeHttpServer(server: ClosableServer, forceAfterMs = FORCE_CLOSE_CONNECTIONS_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => server.closeAllConnections?.(), forceAfterMs)
    server.close((error) => {
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    })
    server.closeIdleConnections?.()
  })
}

const seconds = (ms: number): number => Math.round(ms / 1000)

/**
 * 3d fix round 1 (review #5): SIGINT then SIGTERM, or the same signal twice, runs ONE shutdown. A second
 * shutdown would close the already-closed HTTP server (ERR_SERVER_NOT_RUNNING) and could exit 1 after a
 * clean shutdown. Every later signal is logged and ignored; the returned promise is the one shutdown.
 */
export function shutdownOnSignal(deps: ShutdownServerDeps): (signal: string) => Promise<void> {
  const state: { running: Promise<void> | null } = { running: null }
  return (signal) => {
    if (state.running !== null) {
      deps.log(`[shutdown] ${signal} received while already shutting down; ignored`)
      return state.running
    }
    deps.log(`[shutdown] ${signal} received`)
    state.running = shutdownServer(deps)
    return state.running
  }
}

/**
 * Final fix 2, SIGTERM/SIGINT in the app: stop taking new work, wait (bounded) for a restore or the
 * start-up upgrade in flight, then close, each close step bounded too (3d item 5). Every step runs even
 * if an earlier one fails or hangs, and the process always exits within `waitMs`.
 */
export async function shutdownServer(deps: ShutdownServerDeps): Promise<void> {
  let code = 0
  const closeServerMs = deps.closeServerMs ?? CLOSE_SERVER_MS
  const closeDbMs = deps.closeDbMs ?? CLOSE_DB_MS
  // the work in flight gets only what the close steps leave of the whole budget
  const waitMs = Math.max(0, (deps.waitMs ?? SHUTDOWN_WAIT_MS) - closeServerMs - closeDbMs)
  deps.log('[shutdown] refusing new restores and backups')
  deps.stopAccepting()

  deps.log('[shutdown] waiting for a restore or start-up upgrade in flight')
  let timer: ReturnType<typeof setTimeout> | undefined
  const finished = await Promise.race([
    Promise.allSettled(deps.inFlight()).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs)
    }),
  ])
  clearTimeout(timer)
  // 3d final fix: work cut off (a restore or an upgrade) is not a clean stop, so the exit code says so
  if (!finished) {
    code = 1
    deps.log(`[shutdown] the work in flight did not finish within ${seconds(waitMs)} s; stopping anyway (exit code 1)`)
  }

  const step = async (what: string, run: () => Promise<void>, limitMs: number) => {
    deps.log(`[shutdown] ${what}`)
    let stepTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        run().then(() => 'done' as const),
        new Promise<'timeout'>((resolve) => {
          stepTimer = setTimeout(() => resolve('timeout'), limitMs)
        }),
      ])
      if (outcome === 'timeout') {
        code = 1
        deps.log(`[shutdown] ${what} did not finish within ${seconds(limitMs)} s; going on`)
      }
    } catch (error) {
      code = 1
      deps.log(`[shutdown] ${what} failed: ${describeError(error)}`)
    } finally {
      clearTimeout(stepTimer)
    }
  }
  await step('closing the HTTP server', deps.closeServer, closeServerMs)
  await step('closing the database connections', deps.closeDb, closeDbMs)
  deps.exit(code)
}
