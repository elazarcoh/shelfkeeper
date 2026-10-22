import { serve } from '@hono/node-server'
import { createHardcoverClient, createHttpClient } from '@mylib/connectors'
import { createImageFetcher } from './public-image'
import { backfillSearchAcronyms, checkStartup, crashLogLine, createDb, createFileAssetStore, createPgTools, defaultMigrationsFolder, describeError, devPgToolsOptions, ensureDevBackupDir, prepareDatabase, type DbHandle, type OpsEnv } from '@mylib/db'
import { startBoss } from '@mylib/jobs'
import { ZodError } from 'zod'
import { createApp } from './app'
import { LoginThrottle } from './auth/throttle'
import { loadConfig, type Config } from './config'
import { lockedSecrets, MaintenanceGate, maintenancePage, unavailableJobs } from './maintenance'
import { RestoreRunner } from './ops/restore-runner'
import { CLOSE_DB_MS, closeHttpServer, shutdownOnSignal } from './shutdown'
import { startUp, type ConfigResult } from './start-up'
import type { AppDeps } from './trpc/context'

/** Always valid (every field defaulted): the safe stand-in whenever the real env fails to parse, so the plumbing below never runs on raw, unchecked input. */
const FALLBACK_CONFIG: Config = loadConfig({})
const GENERIC_CONFIG_MESSAGE = 'My Library cannot start: its configuration is invalid. Check the server logs.'
/** 3d item 5: a second under the shutdown's database close step, so the pool's own destroy runs first */
const DB_END_TIMEOUT_SECONDS = CLOSE_DB_MS / 1000 - 1

/**
 * Fix round 1 (Important #1 / Ruling R25): a malformed env must never crash the process — it must
 * still serve the maintenance page. `loadConfig` itself keeps throwing on invalid input (tested in
 * `config.test.ts`); this wraps the one call site instead. Only the *paths* of the failing settings
 * are logged, never their values — a value could be a secret, or arbitrary operator-typed text.
 */
function loadConfigSafely(env: Record<string, string | undefined>): ConfigResult {
  try {
    return { ok: true, config: loadConfig(env) }
  } catch (error) {
    const issuePaths = error instanceof ZodError ? error.issues.map((issue) => (issue.path.length > 0 ? issue.path.join('.') : '(root)')) : ['(unknown)']
    return { ok: false, issuePaths }
  }
}

async function main(): Promise<void> {
  const configResult = loadConfigSafely(process.env)
  const config = configResult.ok ? configResult.config : FALLBACK_CONFIG
  const gate = new MaintenanceGate()
  const since = () => new Date().toISOString()
  // listen at once, answering the maintenance page, so Komodo sees a process that is starting, not a dead one
  gate.hold({ reason: 'upgrading', message: 'My Library is starting: checking the database (and backing it up first if this is an upgrade).', since: since(), backupName: null })

  // Ruling R5: outside production, don't get stuck in maintenance over dev defaults a real deployment
  // always sets up ahead of time — create the default ./data/backups folder, and let PG_TOOLS_PREFIX
  // (e.g. "docker exec -i mylib-dev-db-1") run pg_dump/pg_restore against pnpm dev's containerized
  // Postgres, which has no client tools installed on the host. Both are no-ops in production, and
  // skipped entirely when the env failed to parse (config is `FALLBACK_CONFIG`, not the real one).
  if (configResult.ok) {
    await ensureDevBackupDir(process.env.NODE_ENV, config.backupDir).catch((error: unknown) => {
      console.error('[startup] could not create the dev backup folder:', describeError(error))
    })
  }

  let deps: AppDeps
  let closeDb: DbHandle['close']
  try {
    // Fix round 1 (Important #1): these are only ever called with `config` — the real, validated one,
    // or the all-defaults fallback — never the raw environment, so a malformed value can't reach them.
    const ops: OpsEnv = {
      databaseUrl: config.databaseUrl,
      migrationsFolder: config.migrationsDir ?? defaultMigrationsFolder,
      backupDir: config.backupDir,
      assetsDir: config.assetsDir,
      appSecretKey: config.appSecretKey,
      appVersion: config.appVersion,
      pgTools: createPgTools(devPgToolsOptions(process.env.NODE_ENV, process.env.PG_TOOLS_PREFIX)),
    }
    // small and explicit: the whole stack stays well under postgres.conf max_connections = 50
    const { db, close } = createDb(config.databaseUrl, { max: 5 })
    closeDb = close
    // requests read deps' fields at request time (createContext spreads it), so jobs and secrets can be swapped in below
    deps = {
      db,
      config,
      gate,
      ops,
      throttle: new LoginThrottle(),
      now: () => new Date(),
      secrets: lockedSecrets,
      jobs: unavailableJobs,
      http: createHttpClient(),
      fetchImage: createImageFetcher(),
      assets: createFileAssetStore(config.assetsDir),
      restorer: new RestoreRunner({ ops, gate, db }),
      hardcover: (token) => createHardcoverClient({ token, ...(config.hardcoverApiUrl === null ? {} : { apiUrl: config.hardcoverApiUrl }) }),
    }
  } catch (error) {
    // Ruling R25: even this must not crash-loop. This should be unreachable (the plumbing above is
    // proven safe for any validated `Config`), but if it somehow throws, still answer something.
    console.error('[startup] could not build the app; serving a bare maintenance response:', describeError(error))
    const page = maintenancePage({ reason: 'config', message: GENERIC_CONFIG_MESSAGE, since: since(), backupName: null })
    const server = serve({ fetch: () => new Response(page, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }), port: config.port })
    server.on('error', (serverError) => console.error('[startup] HTTP server error:', describeError(serverError)))
    return
  }

  const server = serve({ fetch: createApp(deps).fetch, port: config.port }, (info) => {
    console.log(`my-library ${config.appVersion} listening on :${info.port}`)
  })
  // Ruling R25: an unhandled 'error' event (e.g. the port is already in use) would otherwise crash
  // the process — this keeps it merely logged, the same "never exit" guarantee as the rest of start-up.
  server.on('error', (error) => console.error('[startup] HTTP server error:', describeError(error)))

  // re-review: set by a graceful shutdown, so a start-up still running never swaps the job queue back in
  let closing = false
  // 3d item 6: aborted by a graceful shutdown, so start-up never keeps waiting for a database that is down
  const startUpAbort = new AbortController()
  const starting = startUp(deps, configResult, {
    checkStartup,
    prepareDatabase,
    startBoss,
    isClosing: () => closing,
    signal: startUpAbort.signal,
    backfillSearch: () => backfillSearchAcronyms(deps.db),
  })

  // Final fix 2: compose stops the app with SIGTERM (docker's init forwards it) and allows 120 s before a
  // SIGKILL; shutdownServer finishes within SHUTDOWN_WAIT_MS (110 s), every close step included (3d item 5).
  const appDeps = deps
  // fix round 1 (review #5): one shutdown, however many SIGINT/SIGTERM arrive; later ones are logged and ignored
  const shutDown = shutdownOnSignal({
    stopAccepting: () => {
      closing = true
      startUpAbort.abort(new Error('shutting down'))
      appDeps.restorer.stopAccepting()
      appDeps.jobs = unavailableJobs
    },
    inFlight: () => [appDeps.restorer.idle(), starting],
    closeServer: () => closeHttpServer(server),
    // queries still running after this are destroyed, inside the step's own CLOSE_DB_MS bound
    closeDb: () => closeDb(DB_END_TIMEOUT_SECONDS),
    exit: (code) => process.exit(code),
    log: (message) => console.log(message),
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutDown(signal))
  }

  await starting
}

/**
 * 3d Task 7: an exception nothing caught (postgres.js 3.4.9 threw one from a timer when a connection
 * dropped mid-transaction, before patches/postgres@3.4.9.patch) leaves the process in an unknown state,
 * so it still exits, but loudly, with a code and one short line, never a stack that could carry a URL.
 * Compose's `restart: unless-stopped` brings it back.
 */
process.on('uncaughtException', (error: unknown, origin) => {
  console.error(crashLogLine('server', error, origin))
  process.exit(1)
})

await main()
