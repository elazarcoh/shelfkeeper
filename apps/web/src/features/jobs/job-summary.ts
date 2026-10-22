import type { SyncStats } from '@mylib/domain'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
export type JobTrigger = 'manual' | 'schedule' | 'rerun'

export const statusLabel: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
}

export const triggerLabel: Record<JobTrigger, string> = { manual: 'Sync now', schedule: 'Scheduled', rerun: 'Re-run' }

export const isActive = (status: JobStatus): boolean => status === 'queued' || status === 'running'

/** How long a run took, e.g. "2m 5s" or "9s"; null when it hasn't both started and finished. */
export function formatRunDuration(startedAt: Date | null, finishedAt: Date | null): string | null {
  if (startedAt === null || finishedAt === null) return null
  const totalSec = Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000))
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function statsLine(stats: SyncStats | null): string {
  if (stats === null) return ''
  const parts: [number, string][] = [
    [stats.seen, 'seen'],
    [stats.created, 'new'],
    [stats.changed, 'changed'],
    [stats.removed, 'gone'],
    [stats.restored, 'back'],
    [stats.linked ?? 0, 'linked to copies already here'],
    [stats.invalid, 'unreadable'],
  ]
  const shown = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`)
  return shown.length === 0 ? 'Nothing found' : shown.join(' · ')
}
