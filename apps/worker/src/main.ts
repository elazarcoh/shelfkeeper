import { writeFile } from 'node:fs/promises'
import { createHardcoverClient, createHttpClient, getConnector, openLibraryWork } from '@mylib/connectors'
import { cachedCapture, crashLogLine, createDb, createResticRunner, createFileAssetStore, createPgTools, createSecretBox, defaultMigrationsFolder, describeError, devPgToolsOptions, getMaintenance, markWorkerPaused, type OpsEnv } from '@mylib/db'
import { CloudCopier } from './cloud-copy'
import { loadWorkerConfig } from './config'
import { prepareWorker, shutdownWorker, WORKER_CLOSE_DB_TIMEOUT_SECONDS } from './lifecycle'
import { MaintenanceWatcher } from './maintenance-watch'
import type { CoversDeps } from './run-covers'
import type { AbsPushDeps } from './run-abs-push'
import type { HardcoverDeps } from './run-hardcover'
import type { SyncDeps } from './run-sync'
import { createWorkerRuntime, type WorkerRuntime } from './worker-runtime'

const WATCH_EVERY_MS = 5_000

const config = loadWorkerConfig(process.env)
// small and explicit: the whole stack stays well under postgres.conf max_connections = 50
const { db, close } = createDb(config.databaseUrl, { max: 3 })
const ops: OpsEnv = {
  databaseUrl: config.databaseUrl,
  migrationsFolder: config.migrationsDir ?? defaultMigrationsFolder,
  backupDir: config.backupDir,
  assetsDir: config.assetsDir,
  appSecretKey: config.appSecretKey,
  appVersion: config.appVersion,
  // the worker runs the backups: outside production it needs the same dev pg tools as the server
  pgTools: createPgTools(devPgToolsOptions(process.env.NODE_ENV, process.env.PG_TOOLS_PREFIX)),
}

// `syncDeps.enqueueCovers` needs the runtime it is itself a dependency of; a box sidesteps the cycle
// without a "used before assigned" `let` — every call happens well after `runtimeBox.current` is set,
// since job handlers only run once `runtime.startWork()` has already returned.
const runtimeBox: { current: WorkerRuntime | null } = { current: null }
const box = createSecretBox(config.appSecretKey)
const http = createHttpClient()
const syncDeps: SyncDeps = {
  db,
  box,
  http,
  getConnector,
  enqueueCovers: async (data) => {
    if (runtimeBox.current !== null) await runtimeBox.current.enqueueCovers(data)
  },
}
const coversDeps: CoversDeps = { db, box, http, getConnector, store: createFileAssetStore(config.assetsDir) }
const hardcoverDeps: HardcoverDeps = {
  db,
  box,
  client: (token) => createHardcoverClient({ token, ...(config.hardcoverApiUrl === null ? {} : { apiUrl: config.hardcoverApiUrl }) }),
  // the shelf flow's cached page first; Open Library's API only when nothing is cached
  openLibraryWork: async (id) => openLibraryWork(http, id, await cachedCapture(db, 'openlibrary', id)),
  now: () => new Date(),
  log: (l) => console.log(l),
}

const absPushDeps: AbsPushDeps = { db, box, http }

const runtime = createWorkerRuntime({
  databaseUrl: config.databaseUrl,
  db,
  ops,
  syncDeps,
  coversDeps,
  hardcoverDeps,
  absPushDeps,
  backupSchedule: { defaultSchedule: config.backupSchedule, tz: config.tz },
  cloud: new CloudCopier({ backupDir: config.backupDir, restic: config.cloud === null ? null : createResticRunner(config.cloud, config.backupDir) }),
  log: (message) => console.log(message),
})
runtimeBox.current = runtime

/**
 * A last-resort net, not a substitute for handling errors where they happen: every promise this
 * process awaits on its own (the watcher's tick, the runtime's reconcile loop, every job handler)
 * already catches and logs its own failure — see `MaintenanceWatcher.tick` and
 * `createWorkerRuntime`'s `reconcile`. This should never fire. It exists so that a genuinely
 * unforeseen rejection (a bug, a future dependency change) is logged and the process stays up —
 * Node terminates on an unhandled rejection by default — rather than the worker silently dying.
 * Ruling R27 ("never crashes on a failed pause/resume") is already satisfied without this handler;
 * this only extends the same guarantee to failures nothing here anticipated.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandled rejection:', describeError(reason))
})

/**
 * 3d Task 7: an exception nothing caught (postgres.js 3.4.9 threw one from a timer when a connection
 * dropped mid-transaction, before patches/postgres@3.4.9.patch) leaves the process in an unknown state,
 * so it still exits, but loudly, with a code and one short line, never a stack that could carry a URL.
 * Compose's `restart: unless-stopped` brings it back.
 */
process.on('uncaughtException', (error: unknown, origin) => {
  console.error(crashLogLine('worker', error, origin))
  process.exit(1)
})

await prepareWorker({ db, ops, log: (message) => console.log(message) })

const watcher = new MaintenanceWatcher({
  readState: () => getMaintenance(db),
  acknowledge: (at) => markWorkerPaused(db, at),
  work: { start: () => runtime.startWork(), stop: () => runtime.stopWork() },
  now: () => new Date(),
  log: (message) => console.log(message),
})
await watcher.tick() // a restore may already be under way
if (!watcher.paused) await runtime.startWork()

/** the worker's health check (deploy/compose.yaml) looks at this file's age */
const HEARTBEAT_FILE = '/tmp/mylib-worker-alive'
const watchTimer = setInterval(() => {
  void watcher.tick()
  void writeFile(HEARTBEAT_FILE, String(Date.now())).catch(() => undefined)
}, WATCH_EVERY_MS)
console.log('my-library worker started')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(watchTimer)
    void shutdownWorker({
      db,
      stopWork: () => runtime.stopWork(),
      // 3d final fix: a pool that will not end gracefully is destroyed, inside the step's own limit
      close: () => close(WORKER_CLOSE_DB_TIMEOUT_SECONDS),
      exit: (code) => process.exit(code),
      // describeError, never a raw error: its message or stack can carry the database URL
      log: (message, error) => console.error(error === undefined ? message : `${message}: ${describeError(error)}`),
    }).catch((error: unknown) => {
      console.error('[worker] shutdown failed:', describeError(error))
      process.exit(1)
    })
  })
}
