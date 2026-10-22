import { z } from 'zod'
import { err, ok, type Result } from './result'

export const backupKinds = ['scheduled', 'pre-upgrade', 'pre-restore', 'manual'] as const
export const BackupKind = z.enum(backupKinds)
export type BackupKind = z.infer<typeof BackupKind>

/** The only manifest format this version reads and writes (spec §4). */
export const BACKUP_FORMAT = 1
/** Admins see a banner when no successful backup is newer than this (spec §4). */
export const BACKUP_STALE_HOURS = 48
/** Admins see a banner when the data volume has less free space than this (spec §3). */
export const LOW_DISK_BYTES = 2 * 1024 ** 3

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)

export const BackupManifest = z.object({
  format: z.number().int().positive(),
  appVersion: z.string().min(1).max(64),
  /** drizzle's created_at ("when") of the last applied migration, and its tag (plan deviation 8) */
  lastMigration: z.object({ tag: z.string().min(1).max(200), when: z.number().int().nonnegative() }),
  createdAt: z.iso.datetime(),
  kind: BackupKind,
  files: z.array(z.object({ path: z.string().min(1).max(500), size: z.number().int().nonnegative(), sha256: Sha256 })).max(1_000_000),
})
export type BackupManifest = z.output<typeof BackupManifest>

/** An unknown format is named as such, so a backup from a future version is not mistaken for a damaged one. */
export function parseBackupManifest(value: unknown): Result<BackupManifest, string> {
  const head = z.object({ format: z.number() }).safeParse(value)
  if (!head.success) return err('The backup has no readable manifest')
  if (head.data.format !== BACKUP_FORMAT) return err(`This backup uses format ${head.data.format}, which this version cannot read`)
  const full = BackupManifest.safeParse(value)
  return full.success ? ok(full.data) : err('The backup manifest is damaged')
}

/** 2026-09-28T03:00:07.900Z → 20260928T030007Z (whole seconds, UTC). */
export function backupStamp(at: Date): string {
  return `${at.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`
}

const VERSION_UNSAFE = /[^0-9A-Za-z.+_-]/g

/** `my-library-<appVersion>-<UTC timestamp>-<kind>.zip` (spec §4). */
export function backupFileName(appVersion: string, at: Date, kind: BackupKind): string {
  const version = appVersion.replace(VERSION_UNSAFE, '_').slice(0, 64)
  return `my-library-${version === '' ? 'unknown' : version}-${backupStamp(at)}-${kind}.zip`
}

export interface BackupFileInfo {
  name: string
  appVersion: string
  createdAt: Date
  kind: BackupKind
}

const FILE_NAME = /^my-library-([0-9A-Za-z.+_-]{1,64})-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(scheduled|pre-upgrade|pre-restore|manual)\.zip$/

/** Only finished backups match: a `.tmp`, a path or any other file is null. */
export function parseBackupFileName(name: string): BackupFileInfo | null {
  const m = FILE_NAME.exec(name)
  if (!m) return null
  const [, version, y, mo, d, h, mi, s, kind] = m
  const createdAt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)))
  if (Number.isNaN(createdAt.getTime()) || backupStamp(createdAt) !== `${y ?? ''}${mo ?? ''}${d ?? ''}T${h ?? ''}${mi ?? ''}${s ?? ''}Z`) return null
  const parsedKind = BackupKind.safeParse(kind)
  if (version === undefined || !parsedKind.success) return null
  return { name, appVersion: version, createdAt, kind: parsedKind.data }
}

export interface BackupRetention {
  scheduled: number
  preUpgrade: number
  preRestore: number
}

export const DEFAULT_RETENTION: BackupRetention = { scheduled: 14, preUpgrade: 5, preRestore: 5 }

function keepOf(retention: BackupRetention, kind: BackupKind): number | null {
  switch (kind) {
    case 'scheduled':
      return retention.scheduled
    case 'pre-upgrade':
      return retention.preUpgrade
    case 'pre-restore':
      return retention.preRestore
    case 'manual':
      return null
  }
}

const newestFirst = (a: BackupFileInfo, b: BackupFileInfo): number => b.createdAt.getTime() - a.createdAt.getTime() || b.name.localeCompare(a.name)

/** File names pruning deletes: per kind, all but the newest `keep`; manual backups never; the newest backup overall never. */
export function planPrune(files: readonly BackupFileInfo[], retention: BackupRetention): string[] {
  const sorted = [...files].sort(newestFirst)
  const newest = sorted[0]?.name
  const doomed: string[] = []
  for (const kind of backupKinds) {
    const keep = keepOf(retention, kind)
    if (keep === null) continue
    for (const file of sorted.filter((f) => f.kind === kind).slice(keep)) {
      if (file.name !== newest) doomed.push(file.name)
    }
  }
  return doomed
}

const CRON_RANGES: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
]

function validCronField(field: string, [min, max]: readonly [number, number]): boolean {
  return field.split(',').every((part) => {
    const m = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) return false
    const [, from, to, step] = m
    const inRange = (n: string | undefined) => n === undefined || (Number(n) >= min && Number(n) <= max)
    if (step !== undefined && Number(step) < 1) return false
    if (!inRange(from) || !inRange(to)) return false
    return to === undefined || Number(from) <= Number(to)
  })
}

/** Five fields: minute hour day-of-month month day-of-week (the form pg-boss schedules take). */
export function isValidCron(text: string): boolean {
  const fields = text.trim().split(/\s+/)
  return (
    fields.length === 5 &&
    fields.every((field, i) => {
      const range = CRON_RANGES[i]
      return range !== undefined && validCronField(field, range)
    })
  )
}

export const CronExpression = z
  .string()
  .trim()
  .max(100)
  .refine(isValidCron, 'Use five cron fields: minute hour day month weekday (for example "0 3 * * *")')

export const BackupSettingsInput = z.object({
  /** null: use BACKUP_SCHEDULE from the environment (plan deviation 20) */
  schedule: CronExpression.nullable(),
  retention: z.object({
    scheduled: z.number().int().min(1).max(365),
    preUpgrade: z.number().int().min(1).max(100),
    preRestore: z.number().int().min(1).max(100),
  }),
})
export type BackupSettingsInput = z.output<typeof BackupSettingsInput>

export interface BackupSettingsView {
  schedule: string
  scheduleIsDefault: boolean
  defaultSchedule: string
  retention: BackupRetention
}

export const maintenanceReasons = ['restore', 'upgrading', 'upgrade-failed', 'backup-failed', 'newer-database', 'config'] as const
export const MaintenanceState = z.object({
  reason: z.enum(maintenanceReasons),
  message: z.string().max(2000),
  since: z.iso.datetime(),
  /** the backup to restore, or the one being restored */
  backupName: z.string().max(200).nullable(),
})
export type MaintenanceState = z.output<typeof MaintenanceState>

const Count = z.number().int().nonnegative()
export const RestoreCounts = z.object({ works: Count, editions: Count, sessions: Count, proposals: Count, sources: Count, covers: Count })
export type RestoreCounts = z.output<typeof RestoreCounts>

export const RestoreSummary = z.object({
  backupName: z.string(),
  preRestoreBackup: z.string().nullable(),
  counts: RestoreCounts,
  resealedSecrets: Count,
  unreadableSecrets: Count,
  /** the sources whose saved login could not be read (re-enter them in Admin → Sources); absent in older summaries */
  unreadableSources: z.array(z.string()).optional(),
  migrationsApplied: z.array(z.string()),
  /** the worker never confirmed it paused (ruling R8); the restore went on. Absent in older summaries. */
  workerPauseUnconfirmed: z.boolean().optional(),
  finishedAt: z.iso.datetime(),
})
export type RestoreSummary = z.output<typeof RestoreSummary>

export const RestoreOutcome = z.union([
  z.object({ ok: z.literal(true), summary: RestoreSummary }),
  z.object({ ok: z.literal(false), backupName: z.string(), preRestoreBackup: z.string().nullable(), error: z.string().max(2000), at: z.iso.datetime() }),
])
export type RestoreOutcome = z.output<typeof RestoreOutcome>

export function backupIsStale(lastBackupAt: Date | null, now: Date): boolean {
  return lastBackupAt === null || now.getTime() - lastBackupAt.getTime() > BACKUP_STALE_HOURS * 3_600_000
}

/** APP_SECRET_KEY: 32 random bytes, base64 (44 characters ending in one "="). */
export function isWellFormedSecretKey(text: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(text)
}
