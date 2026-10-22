import type { PgTools } from './pg-tools'

/** Everything backups, restores and start-up need (the app, the worker and the CLI each build one). */
export interface OpsEnv {
  /** the live database */
  databaseUrl: string
  /** the drizzle folder with meta/_journal.json (MIGRATIONS_DIR in the image) */
  migrationsFolder: string
  backupDir: string
  assetsDir: string
  /** APP_SECRET_KEY: written into every backup as secret.key, used to re-seal on restore */
  appSecretKey: string
  appVersion: string
  pgTools: PgTools
  now?: () => Date
}
