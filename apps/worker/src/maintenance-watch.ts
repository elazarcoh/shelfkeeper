import { describeError } from '@mylib/db'
import type { MaintenanceState } from '@mylib/domain'

export interface WatcherDeps {
  readState: () => Promise<MaintenanceState | null>
  /** write the acknowledgement: when work stopped, or null when it started again */
  acknowledge: (at: Date | null) => Promise<void>
  /** stop() resolves whether the job(s) in flight finished (false: its graceful timeout elapsed first) */
  work: { start(): Promise<void>; stop(): Promise<boolean> }
  now: () => Date
  log: (message: string) => void
}

/**
 * Plan deviation 2, the worker's side. Polled every few seconds:
 * - maintenance on: stop pg-boss (graceful) and acknowledge;
 * - maintenance off: start again.
 * An unreachable database (a restore is swapping it) changes nothing.
 *
 * Ruling R27: the worker never crashes on a failed pause/resume, and never acknowledges while any
 * pg-boss it started can still take jobs. `work.stop()`/`work.start()` are never allowed to throw out
 * of `tick()` — a failure is logged and left for the next tick to retry, with `pausedNow` (the real,
 * operational state) unchanged. The acknowledgement itself is tracked by the `since` of the maintenance
 * state it was written for (`ackedSince`), not just a boolean, so:
 * - a failed acknowledgement is retried on the next tick (it stays out of sync with `wanted` until it
 *   succeeds), and
 * - a second restore starting while the worker is still paused from the first (a new `since`, the same
 *   non-null state) is re-acknowledged, not silently treated as already-handled.
 */
export class MaintenanceWatcher {
  private pausedNow = false
  private ackedSince: string | null = null
  private busy = false

  constructor(private readonly deps: WatcherDeps) {}

  get paused(): boolean {
    return this.pausedNow
  }

  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      let state: MaintenanceState | null
      try {
        state = await this.deps.readState()
      } catch {
        // the database swap terminates every session (plan deviation 6); never log the error itself
        // (it can carry a connection string) — just retry on the next tick.
        this.deps.log('[worker] could not reach the database this tick; will retry')
        return
      }

      if (state !== null && !this.pausedNow) {
        this.deps.log(`[worker] maintenance (${state.reason}): pausing`)
        let drained: boolean
        try {
          drained = await this.deps.work.stop()
        } catch (error) {
          this.deps.log(`[worker] could not stop taking work; will retry: ${describeError(error)}`)
          return
        }
        this.pausedNow = true
        if (!drained) {
          // Final fix 6: a job may still be running. Never confirm this pause: the restore goes on after
          // its own timeout and reports workerPauseUnconfirmed, which is the truth.
          this.deps.log('[worker] a job was still running when the graceful stop timed out; not confirming the pause')
          this.ackedSince = state.since
          return
        }
      } else if (state === null && this.pausedNow) {
        this.deps.log('[worker] maintenance is over: resuming')
        try {
          await this.deps.work.start()
        } catch (error) {
          this.deps.log(`[worker] could not resume taking work; will retry: ${describeError(error)}`)
          return
        }
        this.pausedNow = false
      }

      // By this point `pausedNow` already matches `state` (either it did before this tick, or one of
      // the two branches above just made it so — never ack while they haven't).
      const wanted = state === null ? null : state.since
      if (wanted !== this.ackedSince) {
        try {
          await this.deps.acknowledge(state === null ? null : this.deps.now())
          this.ackedSince = wanted
        } catch (error) {
          this.deps.log(`[worker] could not record the acknowledgement; will retry: ${describeError(error)}`)
        }
      }
    } finally {
      this.busy = false
    }
  }
}
