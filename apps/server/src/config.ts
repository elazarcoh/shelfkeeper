import { z } from 'zod'
import { DEV_SECRET_KEY, devDataPath } from '@mylib/db'
import { CronExpression } from '@mylib/domain'
import { normalizeBasePath } from './base-path'

const Env = z.object({
  DATABASE_URL: z.string().min(1).default('postgres://mylib:mylib@localhost:5433/mylib'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  WEB_DIST: z.string().min(1).optional(),
  MIGRATIONS_DIR: z.string().min(1).optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  APP_SECRET_KEY: z.string().optional(),
  NODE_ENV: z.string().optional(),
  ASSETS_DIR: z.string().min(1).default('./data/assets'),
  APP_VERSION: z.string().min(1).max(64).default('0.0.0-dev'),
  BACKUP_DIR: z.string().min(1).default('./data/backups'),
  BACKUP_SCHEDULE: CronExpression.default('0 3 * * *'),
  PROTECTED_PATHS: z.string().default(''),
  HOST_DATA_DIR: z.string().min(1).optional(),
  HOST_BACKUP_DIR: z.string().min(1).optional(),
  REQUIRE_VOLUME_MARKERS: z.enum(['true', 'false']).default('false'),
  HARDCOVER_API_URL: z.url().optional(),
  NLI_API_KEY: z.string().max(200).optional(),
  NLI_API_URL: z.url().optional(),
  BASE_PATH: z.string().default('').transform((value, ctx) => {
    try {
      return normalizeBasePath(value)
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message })
      return z.NEVER
    }
  }),
})

export interface Config {
  databaseUrl: string
  port: number
  cookieSecure: boolean
  webDist: string | null
  migrationsDir: string | null
  sessionTtlDays: number
  /** '' when missing in production: the start-up checks refuse it with a clear message */
  appSecretKey: string
  assetsDir: string
  appVersion: string
  backupDir: string
  backupScheduleDefault: string
  protectedPaths: string[]
  hostDataDir: string | null
  hostBackupDir: string | null
  requireVolumeMarkers: boolean
  /** '' (served at the root) or '/prefix': the URL prefix the app is served under (README → Serving under a sub-path) */
  basePath: string
  /** replaces the Hardcover GraphQL endpoint (tests, a proxy); null = the real one */
  hardcoverApiUrl: string | null
  /** the National Library of Israel's search API key (#157); null = ISBNs are looked up on Open Library only */
  nliApiKey: string | null
  /** replaces the National Library's search endpoint (tests); null = the real one */
  nliApiUrl: string | null
}

/**
 * PROTECTED_PATHS is a POSIX ':'-separated list (host paths are Linux paths on the Pi, even though
 * this app may run on a Windows dev box) — but a plain `.split(':')` mangles a Windows drive letter a
 * developer might type locally (e.g. `C:\Users\x` becomes `['C', '\\Users\\x']`). A lone single-letter
 * segment immediately followed by a piece that starts with `\` or `/` is a split drive letter: merge it
 * back before trimming and dropping empty entries.
 */
export function splitProtectedPaths(value: string): string[] {
  const merged: string[] = []
  for (const part of value.split(':')) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : undefined
    const partTrimmed = part.trim()
    if (prev !== undefined && /^[A-Za-z]$/.test(prev.trim()) && (partTrimmed.startsWith('\\') || partTrimmed.startsWith('/'))) {
      merged[merged.length - 1] = `${prev}:${part}`
    } else {
      merged.push(part)
    }
  }
  return merged.map((p) => p.trim()).filter((p) => p !== '')
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const e = Env.parse(env)
  const production = e.NODE_ENV === 'production'
  const key = e.APP_SECRET_KEY === undefined || e.APP_SECRET_KEY === '' ? (production ? '' : DEV_SECRET_KEY) : e.APP_SECRET_KEY
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    cookieSecure: e.COOKIE_SECURE === 'true',
    webDist: e.WEB_DIST ?? null,
    migrationsDir: e.MIGRATIONS_DIR ?? null,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    appSecretKey: key,
    assetsDir: devDataPath(e.NODE_ENV, e.ASSETS_DIR),
    appVersion: e.APP_VERSION,
    backupDir: devDataPath(e.NODE_ENV, e.BACKUP_DIR),
    backupScheduleDefault: e.BACKUP_SCHEDULE,
    protectedPaths: splitProtectedPaths(e.PROTECTED_PATHS),
    hostDataDir: e.HOST_DATA_DIR ?? null,
    hostBackupDir: e.HOST_BACKUP_DIR ?? null,
    requireVolumeMarkers: e.REQUIRE_VOLUME_MARKERS === 'true',
    basePath: e.BASE_PATH,
    hardcoverApiUrl: e.HARDCOVER_API_URL ?? null,
    nliApiKey: e.NLI_API_KEY === undefined || e.NLI_API_KEY.trim() === '' ? null : e.NLI_API_KEY.trim(),
    nliApiUrl: e.NLI_API_URL ?? null,
  }
}
