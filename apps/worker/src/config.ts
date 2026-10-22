import { z } from 'zod'
import { DEV_SECRET_KEY, devDataPath, type CloudConfig } from '@mylib/db'
import { CronExpression } from '@mylib/domain'

const Env = z.object({
  DATABASE_URL: z.string().min(1).default('postgres://mylib:mylib@localhost:5433/mylib'),
  APP_SECRET_KEY: z.string().min(1).optional(),
  NODE_ENV: z.string().optional(),
  ASSETS_DIR: z.string().min(1).default('./data/assets'),
  BACKUP_DIR: z.string().min(1).default('./data/backups'),
  APP_VERSION: z.string().min(1).max(64).default('0.0.0-dev'),
  BACKUP_SCHEDULE: CronExpression.default('0 3 * * *'),
  TZ: z.string().min(1).default('UTC'),
  MIGRATIONS_DIR: z.string().min(1).optional(),
  // #106: the cloud copy (README → Cloud backup); unset = off
  RESTIC_REPOSITORY: z.string().optional(),
  RESTIC_PASSWORD: z.string().optional(),
  RESTIC_BIN: z.string().min(1).optional(),
  // #72: replaces Hardcover's GraphQL endpoint (tests, a proxy); unset = the real one
  HARDCOVER_API_URL: z.url().optional(),
})

/** What restic needs to reach the repository's backend, passed through as they are. */
const CREDENTIALS = /^(AWS_|B2_)[A-Z0-9_]+$/

export interface WorkerConfig {
  databaseUrl: string
  appSecretKey: string
  assetsDir: string
  backupDir: string
  appVersion: string
  backupSchedule: string
  /** the backup cron's time zone (spec §4: "03:00 local") */
  tz: string
  migrationsDir: string | null
  /** null: no cloud copy */
  cloud: CloudConfig | null
  /** null: Hardcover's own endpoint */
  hardcoverApiUrl: string | null
}

/** `Intl` throws `RangeError` for a name it doesn't recognize — the only affordable way to validate an
 * IANA zone name without shipping our own copy of the tz database. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const e = Env.parse(env)
  if (e.APP_SECRET_KEY === undefined && e.NODE_ENV === 'production') throw new Error('APP_SECRET_KEY is required')
  if (!isValidTimeZone(e.TZ)) throw new Error(`TZ is not a recognized time zone: ${e.TZ}`)
  const repository = e.RESTIC_REPOSITORY?.trim() ?? ''
  if (repository !== '' && (e.RESTIC_PASSWORD ?? '') === '') throw new Error('RESTIC_PASSWORD is required when RESTIC_REPOSITORY is set')
  const credentials = Object.fromEntries(Object.entries(env).flatMap(([k, v]) => (CREDENTIALS.test(k) && v !== undefined && v !== '' ? [[k, v]] : [])))
  return {
    databaseUrl: e.DATABASE_URL,
    appSecretKey: e.APP_SECRET_KEY ?? DEV_SECRET_KEY,
    assetsDir: devDataPath(e.NODE_ENV, e.ASSETS_DIR),
    backupDir: devDataPath(e.NODE_ENV, e.BACKUP_DIR),
    appVersion: e.APP_VERSION,
    backupSchedule: e.BACKUP_SCHEDULE,
    tz: e.TZ,
    migrationsDir: e.MIGRATIONS_DIR ?? null,
    hardcoverApiUrl: e.HARDCOVER_API_URL ?? null,
    cloud: repository === '' ? null : { repository, password: e.RESTIC_PASSWORD ?? '', credentials, ...(e.RESTIC_BIN === undefined ? {} : { bin: e.RESTIC_BIN }) },
  }
}
