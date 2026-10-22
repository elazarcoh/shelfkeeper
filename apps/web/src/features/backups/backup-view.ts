import { BackupKind, BackupSettingsInput, type RestoreCounts } from '@mylib/domain'
import { withBase } from '@/lib/base-path'

export const backupKindLabel: Record<BackupKind, string> = {
  scheduled: 'Scheduled',
  'pre-upgrade': 'Before an upgrade',
  'pre-restore': 'Before a restore',
  manual: 'Manual',
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit] ?? 'TB'}`
}

/** Spec §4 step 1: the admin types the word. */
export function canConfirmRestore(typed: string): boolean {
  return typed.trim() === 'restore'
}

export function downloadHref(name: string): string {
  return withBase(`/admin/backups/file/${encodeURIComponent(name)}`)
}

/** The server's maintenance page, which comes back to `next` (a full browser path, base included) when maintenance ends (plan deviation 17). */
export function maintenanceUrl(next: string): string {
  return withBase(`/maintenance?next=${encodeURIComponent(next)}`)
}

export function countsLine(c: RestoreCounts): string {
  return `${c.works} books · ${c.editions} editions · ${c.sessions} sessions · ${c.proposals} proposals · ${c.sources} sources · ${c.covers} covers`
}

export interface AdminBanner {
  id: 'backup-stale' | 'cloud-stale' | 'low-disk'
  text: string
}

export function bannersFor(status: { backupStale: boolean; lowDisk: boolean; freeBytes: { data: number | null }; cloud?: { stale: boolean } | null }): AdminBanner[] {
  const banners: AdminBanner[] = []
  if (status.backupStale) banners.push({ id: 'backup-stale', text: 'No successful backup in the last 48 hours.' })
  if (status.cloud?.stale === true) banners.push({ id: 'cloud-stale', text: 'No verified cloud copy in the last 48 hours.' })
  if (status.lowDisk) banners.push({ id: 'low-disk', text: `The data volume is almost full (${formatBytes(status.freeBytes.data)} free).` })
  return banners
}

export interface CloudView {
  configured: boolean
  lastSuccess: { at: Date; file: string; warning: string | null } | null
  lastFailure: { at: Date; error: string } | null
}

/** #106: one line about the cloud copy on Admin → Backups, and whether it is bad news. */
export function cloudLine(cloud: CloudView | null): { text: string; tone: 'muted' | 'warning' | 'error' } {
  if (cloud === null || !cloud.configured) return { text: 'Cloud copy: not set up (README → Cloud backup).', tone: 'muted' }
  if (cloud.lastFailure !== null) return { text: `The last cloud copy failed (${new Date(cloud.lastFailure.at).toLocaleString()}): ${cloud.lastFailure.error}`, tone: 'error' }
  if (cloud.lastSuccess === null) return { text: 'Cloud copy: set up, waiting for the first copy.', tone: 'muted' }
  const line = `Last cloud copy: ${new Date(cloud.lastSuccess.at).toLocaleString()}, verified.`
  return cloud.lastSuccess.warning === null ? { text: line, tone: 'muted' } : { text: `${line} Warning: ${cloud.lastSuccess.warning}`, tone: 'warning' }
}

export function workerLine(worker: { job: 'sync' | 'backup'; at: Date } | null): string {
  if (worker === null) return 'No finished job yet'
  return `Last ${worker.job} finished ${new Date(worker.at).toLocaleString()}`
}

export interface UploadedBackup {
  uploadId: string
  appVersion: string
  createdAt: string
  kind: BackupKind
  lastMigration: string
}

export function parseUploadResponse(status: number, body: unknown): { ok: true; upload: UploadedBackup } | { ok: false; message: string } {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const kind = BackupKind.safeParse(record.kind)
  if (
    status === 200 &&
    typeof record.uploadId === 'string' &&
    typeof record.appVersion === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.lastMigration === 'string' &&
    kind.success
  ) {
    return { ok: true, upload: { uploadId: record.uploadId, appVersion: record.appVersion, createdAt: record.createdAt, kind: kind.data, lastMigration: record.lastMigration } }
  }
  return { ok: false, message: typeof record.error === 'string' ? record.error : 'The upload failed' }
}

/** Ruling R28: a validation error names the one field it belongs to, not just "check the settings". */
export interface SettingsFieldErrors {
  schedule?: string
  scheduled?: string
  preUpgrade?: string
  preRestore?: string
}

const RETENTION_KEYS = ['scheduled', 'preUpgrade', 'preRestore'] as const

export function settingsInput(
  schedule: string,
  keep: { scheduled: string; preUpgrade: string; preRestore: string },
): { ok: true; value: BackupSettingsInput } | { ok: false; errors: SettingsFieldErrors } {
  const parsed = BackupSettingsInput.safeParse({
    schedule: schedule.trim() === '' ? null : schedule.trim(),
    retention: { scheduled: Number(keep.scheduled), preUpgrade: Number(keep.preUpgrade), preRestore: Number(keep.preRestore) },
  })
  if (parsed.success) return { ok: true, value: parsed.data }
  const errors: SettingsFieldErrors = {}
  for (const issue of parsed.error.issues) {
    const [root, key] = issue.path
    if (root === 'schedule' && errors.schedule === undefined) errors.schedule = issue.message
    else if (root === 'retention' && typeof key === 'string' && (RETENTION_KEYS as readonly string[]).includes(key) && errors[key as (typeof RETENTION_KEYS)[number]] === undefined) {
      errors[key as (typeof RETENTION_KEYS)[number]] = issue.message
    }
  }
  return { ok: false, errors }
}
