import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, realpath, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isWellFormedSecretKey, type MaintenanceState } from '@mylib/domain'
import { runBackup } from './backups'
import { databaseUnreachableNow, DatabaseUnreachableError, unreachableCode, waitForPostgres, withOpsLock, type OpsLockTestOnly } from './database-admin'
import type { OpsEnv } from './env'
import { describeError, exists } from './fs-utils'
import { applyMigrations, MigrationFailedError, migrationStatus } from './migrations'
import type { PgToolsOptions } from './pg-tools'

/** Created by hand at install time (docs/install.md → Running on a server); its absence means the disk isn't mounted (plan deviation 14). */
export const VOLUME_MARKER = '.my-library-volume'

export interface StartupCheckInput {
  /** container paths */
  backupDir: string
  assetsDir: string
  appSecretKey: string
  /** host paths as written in .env (compose passes them through); null outside a container */
  hostDataDir: string | null
  hostBackupDir: string | null
  protectedPaths: readonly string[]
  requireVolumeMarkers: boolean
  /** fix round 1: a non-absolute host path is only refused in production (dev has none) */
  nodeEnv?: string
}

function nested(a: string, b: string, sep: string): boolean {
  const withSep = (p: string) => (p.endsWith(sep) ? p : p + sep)
  return a === b || a.startsWith(withSep(b)) || b.startsWith(withSep(a))
}

function normalizeHost(p: string): string {
  const normalized = path.posix.normalize(p.replace(/\\/g, '/'))
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/** Host paths can't be resolved from inside the container, so they are compared lexically (plan deviation 13). */
export function hostPathsOverlap(a: string, b: string): boolean {
  if (!path.posix.isAbsolute(a) || !path.posix.isAbsolute(b)) return false
  return nested(normalizeHost(a), normalizeHost(b), '/')
}

async function realOrResolved(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return path.resolve(p)
  }
}

/** Fix round 1: injectable so a test can force the write or the unlink to fail on every platform, not only where chmod works. */
export interface WriteProbe {
  write(path: string): Promise<void>
  unlink(path: string): Promise<void>
}

const realWriteProbe: WriteProbe = {
  write: (probePath) => writeFile(probePath, '', { flag: 'wx' }),
  unlink,
}

/**
 * Exported (beyond the brief's interface list), like `createOpsLockClient` in database-admin.ts, only
 * so a test can inject a failing probe; it is not part of the public ops API.
 */
export async function writableDirProblem(dir: string, probe: WriteProbe = realWriteProbe): Promise<string | null> {
  try {
    if (!(await stat(dir)).isDirectory()) return 'is not a folder'
  } catch {
    return 'does not exist'
  }
  // `.write-test-*` so a leftover (the unlink below failing) is never mistaken for a real backup file:
  // it doesn't match the backup file name pattern, so listBackups/listBackupFiles ignore it.
  const probePath = path.join(dir, `.write-test-${randomUUID()}`)
  try {
    await probe.write(probePath)
  } catch {
    return 'is not writable by the app'
  }
  try {
    await probe.unlink(probePath)
  } catch (error) {
    return `created a write-test file but could not remove it afterwards (${describeError(error)}) — check BACKUP_DIR permissions`
  }
  return null
}

/** Spec §3: every reason the app must refuse to start. An empty list means it may start. */
export async function checkStartup(input: StartupCheckInput): Promise<string[]> {
  const problems: string[] = []
  if (!isWellFormedSecretKey(input.appSecretKey)) {
    problems.push('APP_SECRET_KEY is missing or is not 32 random bytes in base64 (see deploy/.env.example for how to generate one).')
  }
  const backupProblem = await writableDirProblem(input.backupDir)
  if (backupProblem !== null) {
    problems.push(`BACKUP_DIR ${backupProblem}`)
  } else {
    const [backupReal, assetsReal] = await Promise.all([realOrResolved(input.backupDir), realOrResolved(input.assetsDir)])
    if (nested(backupReal, assetsReal, path.sep)) problems.push('BACKUP_DIR and the data folder overlap: a backup must never live inside the data it protects, or the other way round.')
  }
  // Fix round 1: a container can't resolve a host symlink (plan deviation 13), but a relative host path
  // is never valid at all — in production (the only place these are real host paths) it is refused
  // outright rather than silently skipped by hostPathsOverlap.
  const mustBeAbsolute = (label: string, value: string | null): void => {
    if (input.nodeEnv === 'production' && value !== null && !path.posix.isAbsolute(value)) problems.push(`${label} must be an absolute path.`)
  }
  mustBeAbsolute('BACKUP_DIR', input.hostBackupDir)
  mustBeAbsolute('DATA_DIR', input.hostDataDir)
  for (const guarded of input.protectedPaths) mustBeAbsolute(`PROTECTED_PATHS entry "${guarded}"`, guarded)
  if (input.hostBackupDir !== null && input.hostDataDir !== null && hostPathsOverlap(input.hostBackupDir, input.hostDataDir)) {
    problems.push('BACKUP_DIR and DATA_DIR overlap on the host.')
  }
  for (const guarded of input.protectedPaths) {
    if (input.hostBackupDir !== null && hostPathsOverlap(input.hostBackupDir, guarded)) problems.push(`BACKUP_DIR overlaps the protected path ${guarded}.`)
    if (input.hostDataDir !== null && hostPathsOverlap(input.hostDataDir, guarded)) problems.push(`DATA_DIR overlaps the protected path ${guarded}.`)
  }
  if (input.requireVolumeMarkers) {
    const volumes: readonly (readonly [string, string])[] = [
      ['The assets folder (DATA_DIR/assets)', input.assetsDir],
      ['BACKUP_DIR', input.backupDir],
    ]
    for (const [label, dir] of volumes) {
      if (!(await exists(path.join(dir, VOLUME_MARKER)))) problems.push(`${label} has no ${VOLUME_MARKER} file: is the disk mounted? (docs/install.md → Running on a server)`)
    }
  }
  return problems
}

/** Free bytes for an unprivileged writer on the volume holding `dir`; null when it can't be read. */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

/**
 * Ruling R5 (T9/T10, F6): production checks are unchanged (a missing BACKUP_DIR still fails
 * `checkStartup`). Outside production, `pnpm dev` must not get stuck in maintenance over defaults a
 * real deployment always sets up ahead of time, so the default `./data/backups` is created for it.
 */
export async function ensureDevBackupDir(nodeEnv: string | undefined, backupDir: string): Promise<void> {
  if (nodeEnv === 'production') return
  await mkdir(backupDir, { recursive: true })
}

/**
 * Outside production, `pnpm dev` runs the server and the worker from their own package folders, so a
 * relative `./data/...` default would give each its own folder: the worker's backups and covers would
 * never reach the server. Resolve relative paths against the workspace root (the folder holding
 * `pnpm-workspace.yaml`) so both share one `data/`. Production paths are always absolute and untouched.
 */
export function devDataPath(nodeEnv: string | undefined, dir: string, cwd: string = process.cwd()): string {
  if (nodeEnv === 'production' || path.isAbsolute(dir)) return dir
  for (let at = path.resolve(cwd); ; at = path.dirname(at)) {
    if (existsSync(path.join(at, 'pnpm-workspace.yaml'))) return path.resolve(at, dir)
    if (path.dirname(at) === at) return dir
  }
}

/**
 * Ruling R5: outside production, an optional `PG_TOOLS_PREFIX` (e.g. `docker exec -i
 * mylib-dev-db-1`, split on whitespace) lets `pnpm dev` run `pg_dump`/`pg_restore` against a dev
 * Postgres container that has no client tools installed on the host. Production never honours it.
 * Splitting is plain whitespace-separation with no shell-style quoting: an argument that itself needs
 * a space (e.g. a container name with one) is not supported — that's a dev-only convenience, not a
 * shell.
 */
export function devPgToolsOptions(nodeEnv: string | undefined, pgToolsPrefix: string | undefined): PgToolsOptions {
  if (nodeEnv === 'production') return {}
  // unset: `pnpm db:up`'s container, whose pg_dump always matches the dev server's version (the host
  // usually has none); set to an empty string to use pg_dump/pg_restore from the PATH instead
  const prefix = (pgToolsPrefix ?? DEV_PG_TOOLS_PREFIX).trim()
  if (prefix === '') return {}
  // the tools then run INSIDE the Postgres container: it listens on its own localhost:5432, not on the
  // host's published port, and gets the password through `-e PGPASSWORD` (as containerPgTools does)
  return { prefix: prefix.split(/\s+/), rewriteUrl: insideDevContainer }
}

/** The dev compose Postgres (docker-compose.dev.yml, project `mylib-dev`). */
export const DEV_PG_TOOLS_PREFIX = 'docker exec -i -e PGPASSWORD mylib-dev-db-1'

function insideDevContainer(url: string): string {
  const u = new URL(url)
  u.hostname = 'localhost'
  u.port = '5432'
  return u.toString()
}

export type StartupOutcome = { kind: 'ready'; applied: string[]; preUpgradeBackup: string | null } | { kind: 'maintenance'; state: MaintenanceState }

/** 3d item 7 (decision 4): what one start-up remembers across its attempts. Build it with newUpgradeMemo(). */
export interface UpgradeMemo {
  /** the pre-upgrade backup taken earlier in this same start-up, reused by a retry */
  preUpgradeBackup: string | null
  /** fix round 1 (review #4): every migration this start-up applied, across attempts */
  applied: string[]
  /**
   * the migration an attempt was at when it lost the database. If the next attempt finds it applied, its
   * COMMIT landed and only the acknowledgement was lost, so it is credited to `applied` then.
   */
  inFlight: string | null
  /**
   * fix round 1 (review #2): consecutive attempts that lost the database at this same migration, applying
   * nothing; or (3d final fix) during the pre-upgrade backup, tagged `<pre-upgrade backup>`
   */
  stalled: { tag: string; attempts: number } | null
}

export function newUpgradeMemo(): UpgradeMemo {
  return { preUpgradeBackup: null, applied: [], inFlight: null, stalled: null }
}

/**
 * Fix round 1 (review #2): this many attempts in a row that lose the database (or the migrate lock) at the
 * same pending migration, applying nothing, end in an upgrade-failed verdict instead of another retry.
 * Only attempts that got as far as migrating count: the database had answered and the lock was taken.
 * Time spent waiting for an unreachable database is not an attempt. 3d final fix (review #2): the same
 * bound applies to attempts in a row that lose the database or the backup lock during the pre-upgrade
 * backup; past it, start-up ends in a backup-failed verdict.
 */
export const MAX_STALLED_ATTEMPTS = 10

/** The `UpgradeMemo.stalled` tag for losses during the pre-upgrade backup (never a migration tag: those start with digits). */
const PRE_UPGRADE_BACKUP_STAGE = '<pre-upgrade backup>'

export interface PrepareDatabaseOptions {
  waitAttempts?: number
  /** kept by the caller across retries of one start-up */
  upgrade?: UpgradeMemo
  /** 3d item 6: stops the initial wait for the database (a shutdown) */
  signal?: AbortSignal
  /** tests only, never production code: replaces the migrate lock's live check */
  testOnly?: { lockCheck?: OpsLockTestOnly['check'] }
}

const rollBackHint = (backup: string | null): string => `${backup === null ? 'Restore your latest backup' : `Restore ${backup}`} with the previous version (docs/install.md → Roll back).`
const earlierApplied = (applied: readonly string[]): string => (applied.length === 0 ? '' : ` Earlier migrations of this upgrade were applied: ${applied.join(', ')}.`)

/**
 * 3d item 7 (Task 2 review): what an `upgrade-failed` maintenance says. A MigrationFailedError names the
 * migration that rolled back; anything else (a missing file, say) stopped before the next pending one
 * started. Either way the migrations of this upgrade that did commit are named, so the message never
 * claims the whole upgrade rolled back.
 */
function upgradeFailedMessage(error: unknown, next: string | undefined, applied: readonly string[], backup: string | null): string {
  const what =
    error instanceof MigrationFailedError
      ? `Migration ${error.tag} failed and was rolled back.`
      : next === undefined
        ? `Migrating stopped (${describeError(error)}).`
        : `Migrating stopped before ${next} started (${describeError(error)}).`
  return `${what}${earlierApplied(applied)} ${rollBackHint(backup)}`
}

/**
 * Spec §5 start-up sequence, under the migration lock:
 * - refuse a newer database;
 * - with migrations pending on an existing database, take a pre-upgrade backup (if it fails, stop:
 *   maintenance, nothing migrated);
 * - apply each migration in its own transaction (if one fails, stop: maintenance naming the migration
 *   and the backup).
 *
 * 3d item 7: losing the database at any step rejects with DatabaseUnreachableError instead of a
 * maintenance verdict; each migration is one transaction, so a retry finds it either applied or pending,
 * never half-applied (decision 5). A lost migrate lock counts as losing the database: the lock dies with
 * its session. With `upgrade`, a retry reuses the pre-upgrade backup an earlier attempt took (decision 4),
 * `applied` covers every attempt, and MAX_STALLED_ATTEMPTS losses in a row at the same migration end in
 * an upgrade-failed verdict (fix round 1).
 */
export async function prepareDatabase(env: OpsEnv, options: PrepareDatabaseOptions = {}): Promise<StartupOutcome> {
  const now = env.now ?? (() => new Date())
  const maintenance = (reason: MaintenanceState['reason'], message: string, backupName: string | null): StartupOutcome => ({
    kind: 'maintenance',
    state: { reason, message, since: now().toISOString(), backupName },
  })
  // final fix 3: by default an unreachable database is waited for, not turned into a verdict
  await waitForPostgres(env.databaseUrl, {
    ...(options.waitAttempts === undefined ? {} : { attempts: options.waitAttempts }),
    // 3d item 6: a shutdown stops this wait
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  /** 3d item 7: a failure caused by losing the database is rethrown (start-up waits and retries); null means it is a real verdict */
  const lostTheDatabase = async (error: unknown): Promise<DatabaseUnreachableError | null> => {
    const code = unreachableCode(error) ?? (await databaseUnreachableNow(env.databaseUrl))
    return code === null ? null : new DatabaseUnreachableError(code, { cause: error })
  }
  // without a memo (a one-off call), this call alone is the whole start-up
  const memo = options.upgrade ?? newUpgradeMemo()
  const lockCheck = options.testOnly?.lockCheck
  return withOpsLock(
    env.databaseUrl,
    'migrate',
    async (guard) => {
      const status = await migrationStatus(env.databaseUrl, env.migrationsFolder)
      if (status.unknown.length > 0) {
        return maintenance('newer-database', 'The database is newer than this app. Restore the pre-upgrade backup, or run the newer image (docs/install.md → Roll back).', null)
      }
      // review #4: the migration an earlier attempt lost the database in committed after all
      const inFlight = memo.inFlight
      memo.inFlight = null
      if (inFlight !== null && status.applied.some((e) => e.tag === inFlight) && !memo.applied.includes(inFlight)) memo.applied.push(inFlight)
      if (status.pending.length === 0) return { kind: 'ready', applied: [...memo.applied], preUpgradeBackup: memo.preUpgradeBackup }
      let backup: string | null = memo.preUpgradeBackup
      // a first install (nothing applied yet) has nothing to back up (plan deviation 11)
      if (status.applied.length > 0 && backup === null) {
        try {
          backup = (await runBackup(env, 'pre-upgrade', { wait: true })).name
          memo.preUpgradeBackup = backup
          memo.stalled = null
        } catch (error) {
          const lost = await lostTheDatabase(error)
          if (lost === null) {
            return maintenance('backup-failed', `The pre-upgrade backup failed (${describeError(error)}), so nothing was migrated. Fix that (for example free space in BACKUP_DIR), then restart the app.`, null)
          }
          // 3d final fix (review #2): losses in a row during the pre-upgrade backup are bounded like those at a migration
          const attempts = memo.stalled?.tag === PRE_UPGRADE_BACKUP_STAGE ? memo.stalled.attempts + 1 : 1
          memo.stalled = { tag: PRE_UPGRADE_BACKUP_STAGE, attempts }
          if (attempts >= MAX_STALLED_ATTEMPTS) {
            console.error(`[startup] ${attempts} attempts in a row lost the database or the backup lock during the pre-upgrade backup (${lost.code}); giving up`)
            const message = `The pre-upgrade backup kept failing: ${attempts} attempts in a row lost the database or the backup lock while it ran (last: ${lost.code}), so nothing was migrated. Check that the database stays up and is not overloaded, then restart the app.`
            return maintenance('backup-failed', message, null)
          }
          console.warn(`[startup] lost the database or the backup lock during the pre-upgrade backup (${lost.code})`)
          throw lost
        }
      }
      const pending = status.pending.map((e) => e.tag)
      const appliedNow: string[] = []
      try {
        // 3d item 4 (ruling P2): a live check that this process still holds the migrate lock before each migration
        await applyMigrations(env.databaseUrl, env.migrationsFolder, {
          signal: guard.signal,
          beforeEach: () => guard.assertHeld(),
          onApplied: (tag) => {
            appliedNow.push(tag)
            memo.applied.push(tag)
          },
        })
        memo.stalled = null
        return { kind: 'ready', applied: [...memo.applied], preUpgradeBackup: backup }
      } catch (error) {
        const next = pending[appliedNow.length]
        const lost = await lostTheDatabase(error)
        if (lost === null) {
          // Fix round 1: any failure here — not only a MigrationFailedError from inside one migration's
          // own transaction, but also e.g. a missing migration file — must still end in maintenance naming
          // the backup (plan deviation 12: start-up failures never exit the process).
          return maintenance('upgrade-failed', upgradeFailedMessage(error, next, memo.applied, backup), backup)
        }
        memo.inFlight = next ?? null
        // review #2: an attempt that applied nothing and stopped at the same migration again counts towards the bound
        const stalledBefore = memo.stalled
        const stalled = next === undefined ? null : { tag: next, attempts: appliedNow.length === 0 && stalledBefore?.tag === next ? stalledBefore.attempts + 1 : 1 }
        memo.stalled = stalled
        if (stalled !== null && stalled.attempts >= MAX_STALLED_ATTEMPTS) {
          console.error(`[startup] ${stalled.attempts} attempts in a row lost the database at ${stalled.tag} (${lost.code}); giving up`)
          const message = `Upgrading kept failing at migration ${stalled.tag}: ${stalled.attempts} attempts in a row lost the database or the migration lock there (last: ${lost.code}), and none of them applied anything.${earlierApplied(memo.applied)} ${rollBackHint(backup)}`
          return maintenance('upgrade-failed', message, backup)
        }
        // the code only; the migrations that did commit stay committed, and the retry skips them
        console.warn(`[startup] lost the database while migrating (${lost.code})${appliedNow.length === 0 ? '' : `; applied before that: ${appliedNow.join(', ')}`}`)
        throw lost
      }
    },
    { wait: true, ...(lockCheck === undefined ? {} : { testOnly: { check: lockCheck } }) },
  )
}
