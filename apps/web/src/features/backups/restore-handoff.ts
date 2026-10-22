import { maintenanceUrl } from './backup-view'

/** The outcome of one `/maintenance/status` poll; a network error is folded into `'poll-error'` so it is
 * tolerated the same way a "not yet" answer is -- a single dropped request must not stall the hand-off. */
export type PollStatus = 'maintenance' | 'not-yet' | 'poll-error'

/**
 * Ruling R9's state machine, factored out of the component so it can be unit-tested on its own: the
 * restore mutation resolves once the backup is validated, before the background restore calls the
 * maintenance gate's `enter()` (plan deviation 1/3) -- navigating to /maintenance right away would reach
 * it while `maintenance` is still null and get redirected straight back (the server's own `/maintenance`
 * handler 302s to `next` whenever it isn't in maintenance). So the caller polls until the server actually
 * reports maintenance, backing off to a slower, softer-worded phase once the fast poll's deadline passes,
 * and reports a failure it finds recorded meanwhile instead of waiting forever.
 */
export const FAST_POLL_MS = 500
export const FAST_DEADLINE_MS = 20_000
export const SLOW_POLL_MS = 5_000

export interface HandoffInput {
  /** milliseconds since the restore mutation succeeded */
  elapsedMs: number
  status: PollStatus
  /** `lastRestore`'s failure reason, once one is known to belong to this attempt (not a stale one from an earlier attempt) */
  restoreFailure: string | null
  cancelled: boolean
}

export type HandoffState =
  | { phase: 'stopped' }
  | { phase: 'navigate'; url: string }
  | { phase: 'failed'; reason: string }
  | { phase: 'starting'; pollIntervalMs: number }
  | { phase: 'still-starting'; pollIntervalMs: number }

/** `next` is the path the maintenance page returns to once maintenance ends. */
export function decideHandoff(input: HandoffInput, next: string): HandoffState {
  if (input.cancelled) return { phase: 'stopped' }
  if (input.status === 'maintenance') return { phase: 'navigate', url: maintenanceUrl(next) }
  if (input.restoreFailure !== null) return { phase: 'failed', reason: input.restoreFailure }
  return input.elapsedMs < FAST_DEADLINE_MS ? { phase: 'starting', pollIntervalMs: FAST_POLL_MS } : { phase: 'still-starting', pollIntervalMs: SLOW_POLL_MS }
}

/**
 * Fix round 2: a restore mutation's `onSuccess` (and any tick already awaiting a fetch) can run after the
 * dialog -- or the whole page -- has gone away, since a promise's callbacks fire regardless of whether the
 * component that started it is still mounted. `mounted` must therefore only ever go from true to false,
 * never back (a plain ref set once in an unmount cleanup, never "revived" by a later callback) --
 * otherwise a mutation that resolves after the admin has already left would restart polling, and could
 * end up navigating a page they are no longer looking at. `attempt`/`current` are a token pair: each
 * restore attempt captures the counter's value when it starts, and the counter is bumped again whenever
 * that attempt is superseded (a fresh attempt begins, or the dialog is closed/cancelled) -- a stale tick
 * whose captured `attempt` no longer matches `current` stops just as surely as an unmounted one does.
 */
export function shouldContinue(mounted: boolean, attempt: number, current: number): boolean {
  return mounted && attempt === current
}
