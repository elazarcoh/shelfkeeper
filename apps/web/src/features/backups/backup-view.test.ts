import { describe, expect, it } from 'vitest'
import { bannersFor, canConfirmRestore, cloudLine, countsLine, downloadHref, formatBytes, maintenanceUrl, parseUploadResponse, settingsInput, workerLine } from './backup-view'

describe('backup view helpers', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB')
    expect(formatBytes(null)).toBe('unknown')
  })

  it('confirms a restore only when "restore" is typed', () => {
    expect(canConfirmRestore('restore')).toBe(true)
    expect(canConfirmRestore('  restore ')).toBe(true)
    expect(canConfirmRestore('Restore')).toBe(false)
    expect(canConfirmRestore('yes')).toBe(false)
  })

  it('builds the download and maintenance URLs', () => {
    expect(downloadHref('my-library-0.4.0+b1-20260928T030000Z-manual.zip')).toBe('/admin/backups/file/my-library-0.4.0%2Bb1-20260928T030000Z-manual.zip')
    expect(maintenanceUrl('/admin/backups')).toBe('/maintenance?next=%2Fadmin%2Fbackups')
  })

  it('summarizes restore counts', () => {
    expect(countsLine({ works: 12, editions: 15, sessions: 30, proposals: 4, sources: 2, covers: 10 })).toBe('12 books · 15 editions · 30 sessions · 4 proposals · 2 sources · 10 covers')
  })

  it('shows a banner for a stale backup and for a nearly full data volume', () => {
    expect(bannersFor({ backupStale: false, lowDisk: false, freeBytes: { data: 10 * 1024 ** 3 } })).toEqual([])
    expect(bannersFor({ backupStale: true, lowDisk: true, freeBytes: { data: 1024 ** 3 } }).map((b) => b.id)).toEqual(['backup-stale', 'low-disk'])
  })

  it('shows a banner when the cloud copy is set up but stale (#106)', () => {
    const base = { backupStale: false, lowDisk: false, freeBytes: { data: 10 * 1024 ** 3 } }
    expect(bannersFor({ ...base, cloud: null })).toEqual([])
    expect(bannersFor({ ...base, cloud: { stale: true } }).map((b) => b.id)).toEqual(['cloud-stale'])
  })

  it('describes the cloud copy (#106)', () => {
    const at = new Date('2026-10-15T03:05:00Z')
    expect(cloudLine(null)).toEqual({ text: 'Cloud copy: not set up (docs/install.md → Cloud backup).', tone: 'muted' })
    expect(cloudLine({ configured: true, lastSuccess: null, lastFailure: null }).text).toBe('Cloud copy: set up, waiting for the first copy.')
    const copied = cloudLine({ configured: true, lastSuccess: { at, file: 'a.zip', warning: null }, lastFailure: null })
    expect(copied.tone).toBe('muted')
    expect(copied.text).toMatch(/^Last cloud copy: .*, verified\.$/)
    const warned = cloudLine({ configured: true, lastSuccess: { at, file: 'a.zip', warning: 'repository check failed: x' }, lastFailure: null })
    expect(warned.tone).toBe('warning')
    expect(warned.text).toContain('Warning: repository check failed: x')
    const failed = cloudLine({ configured: true, lastSuccess: null, lastFailure: { at, error: 'could not reach the cloud repository: Fatal: no such host' } })
    expect(failed.tone).toBe('error')
    expect(failed.text).toContain('Fatal: no such host')
  })

  it("describes the worker's last job", () => {
    expect(workerLine(null)).toBe('No finished job yet')
    expect(workerLine({ job: 'backup', at: new Date('2026-09-28T03:01:00Z') })).toContain('backup')
  })

  it('reads the upload answer', () => {
    const ok = { uploadId: '11111111-1111-4111-8111-111111111111', appVersion: '0.4.0', createdAt: '2026-09-28T03:00:00.000Z', kind: 'manual', lastMigration: '0007_backups_system_state' }
    expect(parseUploadResponse(200, ok)).toEqual({ ok: true, upload: ok })
    expect(parseUploadResponse(400, { error: 'The backup manifest is damaged' })).toEqual({ ok: false, message: 'The backup manifest is damaged' })
    expect(parseUploadResponse(502, '<html>')).toEqual({ ok: false, message: 'The upload failed' })
  })

  it('turns the settings form into input, blank schedule meaning the default', () => {
    expect(settingsInput('', { scheduled: '14', preUpgrade: '5', preRestore: '5' })).toEqual({ ok: true, value: { schedule: null, retention: { scheduled: 14, preUpgrade: 5, preRestore: 5 } } })
    expect(settingsInput('0 25 * * *', { scheduled: '14', preUpgrade: '5', preRestore: '5' })).toMatchObject({ ok: false })
    expect(settingsInput('', { scheduled: '0', preUpgrade: '5', preRestore: '5' })).toMatchObject({ ok: false })
  })

  it('names the one field a validation error belongs to (ruling R28)', () => {
    const zeroRetention = settingsInput('', { scheduled: '0', preUpgrade: '5', preRestore: '5' })
    expect(zeroRetention.ok).toBe(false)
    if (!zeroRetention.ok) {
      expect(zeroRetention.errors.scheduled).toBeDefined()
      expect(zeroRetention.errors.schedule).toBeUndefined()
      expect(zeroRetention.errors.preUpgrade).toBeUndefined()
      expect(zeroRetention.errors.preRestore).toBeUndefined()
    }

    const badCron = settingsInput('0 25 * * *', { scheduled: '14', preUpgrade: '5', preRestore: '5' })
    expect(badCron.ok).toBe(false)
    if (!badCron.ok) {
      expect(badCron.errors.schedule).toBeDefined()
      expect(badCron.errors.scheduled).toBeUndefined()
      expect(badCron.errors.preUpgrade).toBeUndefined()
      expect(badCron.errors.preRestore).toBeUndefined()
    }
  })
})
