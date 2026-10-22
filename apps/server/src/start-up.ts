import {
  cleanupBackupLeftovers,
  createSecretBox,
  databaseUnreachableNow,
  describeError,
  ensureConnectionsAllowed,
  isDatabaseUnreachable,
  newUpgradeMemo,
  sleep,
  unreachableCode,
  waitForPostgres,
  type OpsEnv,
  type PrepareDatabaseOptions,
  type StartupOutcome,
  type UpgradeMemo,
} from '@mylib/db'
import { jobQueueFrom, startBoss } from '@mylib/jobs'
import type { Config } from './config'
import type { AppDeps } from './trpc/context'

/** Either a validated env, or the Zod issue paths from a failed one (never the values — see `main.ts`). */
export type ConfigResult = { ok: true; config: Config } | { ok: false; issuePaths: string[] }

/** The pieces of the sequence a test replaces, so every outcome is exercised through `createApp` + `/health` without a real Postgres/pg-boss round trip for the failure paths. */
export interface StartUpFns {
  checkStartup: (input: {
    backupDir: string
    assetsDir: string
    appSecretKey: string
    hostDataDir: string | null
    hostBackupDir: string | null
    protectedPaths: readonly string[]
    requireVolumeMarkers: boolean
    nodeEnv?: string
  }) => Promise<string[]>
  /** final fix 3: default waitForPostgres, which keeps waiting (logging once a minute) while the database is unreachable */
  waitForDatabase?: (url: string, signal?: AbortSignal) => Promise<void>
  prepareDatabase: (env: OpsEnv, options?: PrepareDatabaseOptions) => Promise<StartupOutcome>
  startBoss: typeof startBoss
  /**
   * 3d final fix (review #1): asked about a start-up failure that carries no error code at all (pg-boss's
   * node-postgres throws a code-less 'Connection terminated unexpectedly'); returns the unreachable code,
   * or null when the database answers. Default databaseUnreachableNow.
   */
  databaseUnreachableNow?: (url: string) => Promise<string | null>
  /** 3d item 7: the pause before starting again after losing the database (default 1000 ms) */
  retryDelayMs?: number
  /** re-review: true once a graceful shutdown began; start-up then never swaps the job queue in or opens the gate */
  isClosing?: () => boolean
  /**
   * 3d item 6: aborted when a graceful shutdown begins; start-up's waits for the database (and its retry
   * pause) stop at once. Real work already running (a pre-upgrade backup, a migration) is not cut off.
   */
  signal?: AbortSignal
  /** test-only: fixes the maintenance state's `since` */
  now?: () => Date
  /**
   * #73: fills in search abbreviations for rows written before they existed; returns how many it refreshed.
   * Runs in the background once the app is open, so a slow pass never delays start-up; a failure is only logged.
   */
  backfillSearch?: () => Promise<number>
}

const GENERIC_CONFIG_MESSAGE = 'My Library cannot start: its configuration is invalid. Check the server logs.'
/** Fix round 1 (review #3): the start-up retry warning, at most this often after the first one. */
const RETRY_LOG_EVERY_MS = 60_000
const UNEXPECTED_ERROR_MESSAGE = 'My Library hit an unexpected error while starting. Check the server logs.'

/**
 * Plan deviation 12 / Ruling R25: nothing here may crash-loop the process — every branch ends by
 * either leaving the gate (ready) or holding it (every kind of failure); it never throws back out to
 * its caller. `deps.db`/`deps.ops`/`deps.assets` must already be built from a *validated* `Config`
 * (or a safe all-defaults fallback) before this runs — `main.ts` never hands this a raw, unchecked env.
 */
export async function startUp(deps: AppDeps, configResult: ConfigResult, fns: StartUpFns): Promise<void> {
  const since = () => (fns.now ?? (() => new Date()))().toISOString()

  if (!configResult.ok) {
    // Never the raw values (they may be secrets or arbitrary operator input) — only which settings failed.
    console.error(`[startup] invalid configuration at: ${configResult.issuePaths.join(', ') || '(unknown)'}`)
    deps.gate.hold({ reason: 'config', message: GENERIC_CONFIG_MESSAGE, since: since(), backupName: null })
    return
  }
  const config = configResult.config

  try {
    const problems = await fns.checkStartup({
      backupDir: config.backupDir,
      assetsDir: config.assetsDir,
      appSecretKey: config.appSecretKey,
      hostDataDir: config.hostDataDir,
      hostBackupDir: config.hostBackupDir,
      protectedPaths: config.protectedPaths,
      requireVolumeMarkers: config.requireVolumeMarkers,
      // `exactOptionalPropertyTypes`: only set `nodeEnv` when it actually has a value.
      ...(process.env.NODE_ENV !== undefined ? { nodeEnv: process.env.NODE_ENV } : {}),
    })
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[startup] refusing to start: ${problem}`)
      deps.gate.hold({ reason: 'config', message: `My Library cannot start: ${problems.join(' ')}`, since: since(), backupName: null })
      return
    }

    deps.secrets = createSecretBox(config.appSecretKey)
    // 3d item 7: losing the database part-way is not a verdict either: wait for it again and start over.
    // The memo keeps the pre-upgrade backup an earlier attempt took (decision 4). A lost migrate lock
    // counts as losing the database (the lock dies with its session), so it is retried too.
    // prepareDatabase bounds an upgrade that keeps failing at the same migration (MAX_STALLED_ATTEMPTS)
    const upgrade = newUpgradeMemo()
    // fix round 1 (review #3): like waitForPostgres, one line at first and then at most once a minute
    const retries: { count: number; loggedAt: number | null } = { count: 0, loggedAt: null }
    // 3d item 6 (review focus 1): once a shutdown began, start-up ends quietly, the gate left as it is
    const shuttingDown = (): boolean => fns.signal?.aborted === true || fns.isClosing?.() === true
    const stopForShutdown = (): void => console.log('[startup] shutting down: start-up stopped while it waited for the database')
    for (;;) {
      try {
        await startOnce(deps, config, fns, upgrade)
        return
      } catch (error) {
        if (shuttingDown()) {
          // a wait the abort stopped is expected; anything else is logged, though the process is exiting either way
          const stoppedWait = fns.signal?.aborted === true && error === fns.signal.reason
          if (!stoppedWait && !isDatabaseUnreachable(error)) console.log(`[startup] start-up failed as the shutdown began: ${describeError(error)}`)
          stopForShutdown()
          return
        }
        // 3d final fix (review #1): a failure with no code at all is not a verdict until the database has
        // been asked, as prepareDatabase does; one with a code is judged by that code alone
        const code = unreachableCode(error) ?? (hasErrorCode(error) ? null : await (fns.databaseUnreachableNow ?? databaseUnreachableNow)(deps.ops.databaseUrl))
        if (code === null) throw error
        retries.count++
        const now = Date.now()
        if (retries.loggedAt === null || now - retries.loggedAt >= RETRY_LOG_EVERY_MS) {
          retries.loggedAt = now
          // the code only: the message can carry the host, user or URL
          console.warn(`[startup] lost the database during start-up (${code}; attempt ${retries.count}); waiting for it, then starting again`)
        }
        try {
          await sleep(fns.retryDelayMs ?? 1000, fns.signal)
        } catch {
          stopForShutdown()
          return
        }
      }
    }
  } catch (error) {
    console.error('[startup] unexpected error, staying in maintenance:', describeError(error))
    deps.gate.hold({ reason: 'config', message: UNEXPECTED_ERROR_MESSAGE, since: since(), backupName: null })
  }
}

/** True when `error` (or an error it wraps through `cause`) carries a string or numeric `code`. */
function hasErrorCode(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && (typeof current.code === 'string' || typeof current.code === 'number')) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

/** 3d item 7: one attempt of the database half of start-up: wait, re-allow connections, clean up, migrate, start the job queue. */
async function startOnce(deps: AppDeps, config: Config, fns: StartUpFns, upgrade: UpgradeMemo): Promise<void> {
  // Final fix 3: after a power cut the database may take a while to come back. Unreachable is not a
  // verdict — keep waiting, still holding 'upgrading'; only real verdicts below end in maintenance.
  // 3d item 6: a shutdown stops this wait at once
  await (fns.waitForDatabase ?? ((url: string, signal?: AbortSignal) => waitForPostgres(url, signal === undefined ? {} : { signal })))(deps.ops.databaseUrl, fns.signal)
  // final fix 1: before anything connects to the live database, undo a restore swap interrupted
  // between refusing new connections and the rename (it would otherwise refuse them for good). The
  // app waits for the backup lock rather than skipping the check (re-review): a worker backup holding
  // it only delays start-up, while skipping could leave the database refusing connections.
  await ensureConnectionsAllowed(deps.ops.databaseUrl, (message) => console.log(message), { waitForLock: true })
  await cleanupBackupLeftovers(deps.ops).catch((error: unknown) => {
    console.error('[startup] leftover cleanup failed:', describeError(error))
  })

  const outcome = await fns.prepareDatabase(deps.ops, { upgrade, ...(fns.signal === undefined ? {} : { signal: fns.signal }) })
  if (outcome.kind === 'maintenance') {
    console.error(`[startup] ${outcome.state.message}`)
    deps.gate.hold(outcome.state)
    return
  }

  if (outcome.preUpgradeBackup !== null) console.log(`[startup] pre-upgrade backup: ${outcome.preUpgradeBackup}`)
  if (outcome.applied.length > 0) console.log(`[startup] applied migrations: ${outcome.applied.join(', ')}`)
  // Re-review: a SIGTERM that arrived meanwhile has already refused new work (shutdownServer's
  // stopAccepting); swapping the real job queue back in, or opening the gate, would undo that.
  if (fns.isClosing?.() === true) {
    console.log('[startup] shutting down: not starting the job queue')
    return
  }
  const boss = await fns.startBoss(config.databaseUrl, 'sender')
  if (fns.isClosing?.() === true) {
    console.log('[startup] shutting down: not starting the job queue')
    await boss.stop({ graceful: false }).catch(() => undefined)
    return
  }
  deps.jobs = jobQueueFrom(boss)
  deps.gate.leave()
  if (fns.backfillSearch !== undefined) {
    fns.backfillSearch().then(
      (count) => {
        if (count > 0) console.log(`[startup] search abbreviations filled in for ${count} books`)
      },
      (error: unknown) => console.error('[startup] search abbreviation backfill failed:', describeError(error)),
    )
  }
}
