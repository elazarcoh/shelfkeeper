/**
 * Plan deviation 15: restore without the UI (e.g. rolling back when this version refuses to start).
 *
 * Stop the app and the worker first: `docker compose stop app worker`.
 *
 * Do not run this while another instance of the app is starting up. `restoreBackup` takes the
 * 'backup' advisory lock, not the 'migrate' lock a starting app holds while it runs its own checks
 * and migrations (packages/db/src/ops/database-admin.ts) — the two locks cannot see each other, so a
 * restore that races a start-up is not refused; it can restore into a database mid-migration.
 */
import path from 'node:path'
import { countOtherSessions, createPgTools, defaultMigrationsFolder, describeError, devPgToolsOptions, ensureConnectionsAllowed, noMaintenanceControl, restoreBackup } from '@mylib/db'
import { isWellFormedSecretKey } from '@mylib/domain'
import { parseRestoreArgs } from './cli-args'
import { loadConfig } from './config'

const args = parseRestoreArgs(process.argv.slice(2))
if ('error' in args) {
  console.error(args.error)
  process.exit(2)
}
const config = loadConfig(process.env)
if (!isWellFormedSecretKey(config.appSecretKey)) {
  console.error('APP_SECRET_KEY is missing or malformed: the restore needs it to re-seal source logins.')
  process.exit(2)
}

// Final fix 1: a restore swap interrupted between refusing new connections and the rename leaves the
// live database refusing them — which is exactly when this CLI tends to be needed. It does not wait for
// the backup lock (re-review): with the app and the worker stopped, as required, nobody holds it; if
// someone does, the check is skipped and restoreBackup below refuses at once (OpsBusyError) rather than
// this CLI hanging or reopening a database under someone else's restore.
await ensureConnectionsAllowed(config.databaseUrl).catch((error: unknown) => {
  console.error(`Could not check that the live database accepts connections: ${describeError(error)}`)
  process.exit(1)
})

// Fix round 1 minor: unlike a restore triggered from the running app (which is naturally connected
// to its own database), this CLI has no in-process maintenance coordination with the app or the
// worker — its only signal that they're really stopped is whether anything else is still connected.
if (!args.force) {
  const others = await countOtherSessions(config.databaseUrl).catch((error: unknown) => {
    console.error(`Could not check for other sessions on the live database: ${describeError(error)}`)
    process.exit(1)
  })
  if (others > 0) {
    console.error(
      `Refusing: ${others} other session(s) are still connected to the live database. Stop the app and the worker first (docker compose stop app worker), or pass --force to proceed anyway.`,
    )
    process.exit(2)
  }
}

try {
  const summary = await restoreBackup(
    {
      databaseUrl: config.databaseUrl,
      migrationsFolder: config.migrationsDir ?? defaultMigrationsFolder,
      backupDir: config.backupDir,
      assetsDir: config.assetsDir,
      appSecretKey: config.appSecretKey,
      appVersion: config.appVersion,
      // Fix round 1 minor (Ruling R5): outside production, honour PG_TOOLS_PREFIX the same way the app does.
      pgTools: createPgTools(devPgToolsOptions(process.env.NODE_ENV, process.env.PG_TOOLS_PREFIX)),
    },
    { zipFile: path.resolve(args.zipFile), control: noMaintenanceControl, preRestoreBackup: args.preRestoreBackup, workerPauseTimeoutMs: 5000 },
  )
  const c = summary.counts
  console.log(`Restored ${summary.backupName}: ${c.works} books, ${c.editions} editions, ${c.sessions} sessions, ${c.proposals} proposals, ${c.sources} sources, ${c.covers} covers.`)
  if (summary.unreadableSecrets > 0) console.log(`${summary.unreadableSecrets} source login(s) could not be read; re-enter them in Admin → Sources.`)
  if (summary.preRestoreBackup !== null) console.log(`The state before this restore was saved as ${summary.preRestoreBackup}.`)
  process.exit(0)
} catch (error) {
  console.error(`Restore failed: ${describeError(error)}`)
  process.exit(1)
}
