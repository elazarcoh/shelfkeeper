// Crash-test child: a backup that stalls right after writing its temp zip, until the parent SIGKILLs it.
import { runBackup } from '../../ops/backups'
import { sleep } from '../../ops/fs-utils'
import { defaultMigrationsFolder } from '../../ops/migrations'
import { DEV_SECRET_KEY } from '../../secrets'
import { containerPgTools } from '../container-pg-tools'

const env = process.env
if (env.CRASH_DB_URL === undefined || env.CRASH_BACKUP_DIR === undefined || env.CRASH_ASSETS_DIR === undefined || env.CRASH_PG_CONTAINER === undefined) {
  throw new Error('CRASH_DB_URL, CRASH_BACKUP_DIR, CRASH_ASSETS_DIR and CRASH_PG_CONTAINER are required')
}
await runBackup(
  {
    databaseUrl: env.CRASH_DB_URL,
    migrationsFolder: defaultMigrationsFolder,
    backupDir: env.CRASH_BACKUP_DIR,
    assetsDir: env.CRASH_ASSETS_DIR,
    appSecretKey: DEV_SECRET_KEY,
    appVersion: '0.4.0-crash',
    pgTools: containerPgTools(env.CRASH_PG_CONTAINER),
  },
  'manual',
  { hooks: { afterZipWritten: () => sleep(120_000) } },
)
console.log('backup finished')
