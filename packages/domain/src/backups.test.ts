import { describe, expect, it } from 'vitest'
import {
  backupFileName,
  backupIsStale,
  BackupSettingsInput,
  DEFAULT_RETENTION,
  isValidCron,
  isWellFormedSecretKey,
  parseBackupFileName,
  parseBackupManifest,
  planPrune,
  type BackupFileInfo,
  type BackupKind,
} from './backups'

const SHA = 'a'.repeat(64)

function info(kind: BackupKind, iso: string, version = '0.4.0'): BackupFileInfo {
  const parsed = parseBackupFileName(backupFileName(version, new Date(iso), kind))
  if (parsed === null) throw new Error('name did not parse')
  return parsed
}

describe('backup file names', () => {
  it('names a backup by version, UTC second and kind, and reads the name back', () => {
    const name = backupFileName('0.4.0', new Date('2026-09-28T00:00:07.900Z'), 'scheduled')
    expect(name).toBe('my-library-0.4.0-20260928T000007Z-scheduled.zip')
    expect(parseBackupFileName(name)).toEqual({ name, appVersion: '0.4.0', createdAt: new Date('2026-09-28T00:00:07Z'), kind: 'scheduled' })
  })

  it('keeps a pre-release version with dashes and makes unsafe characters safe', () => {
    const name = backupFileName('0.4.0-rc.1', new Date('2026-01-02T03:04:05Z'), 'pre-upgrade')
    expect(parseBackupFileName(name)).toMatchObject({ appVersion: '0.4.0-rc.1', kind: 'pre-upgrade' })
    expect(backupFileName('1.0 beta/2', new Date('2026-01-02T03:04:05Z'), 'manual')).toBe('my-library-1.0_beta_2-20260102T030405Z-manual.zip')
  })

  it('ignores anything that is not a finished backup name, including traversal attempts and impossible dates', () => {
    for (const name of [
      'my-library-0.4.0-20260928T000007Z-scheduled.zip.tmp',
      '../my-library-0.4.0-20260928T000007Z-manual.zip',
      'my-library-0.4.0-20261328T000007Z-manual.zip',
      'my-library-0.4.0-20260928T000007Z-weekly.zip',
      'notes.txt',
    ]) {
      expect(parseBackupFileName(name)).toBeNull()
    }
  })
})

describe('planPrune', () => {
  it('keeps the newest N of each kind and never prunes manual backups', () => {
    const files = [
      info('scheduled', '2026-09-01T00:00:00Z'),
      info('scheduled', '2026-09-02T00:00:00Z'),
      info('scheduled', '2026-09-03T00:00:00Z'),
      info('pre-upgrade', '2026-08-01T00:00:00Z'),
      info('pre-upgrade', '2026-08-02T00:00:00Z'),
      info('manual', '2020-01-01T00:00:00Z'),
      info('manual', '2020-01-02T00:00:00Z'),
    ]
    const doomed = planPrune(files, { scheduled: 2, preUpgrade: 1, preRestore: 5 })
    expect(doomed.sort()).toEqual([files[0]?.name, files[3]?.name].sort())
  })

  it('never deletes the newest backup, even when its kind is over the limit', () => {
    const newest = info('scheduled', '2026-09-03T00:00:00Z')
    expect(planPrune([info('scheduled', '2026-09-01T00:00:00Z'), newest], { scheduled: 0, preUpgrade: 5, preRestore: 5 })).not.toContain(newest.name)
  })

  it('uses 14 / 5 / 5 by default', () => {
    expect(DEFAULT_RETENTION).toEqual({ scheduled: 14, preUpgrade: 5, preRestore: 5 })
  })
})

describe('parseBackupManifest', () => {
  const manifest = {
    format: 1,
    appVersion: '0.4.0',
    lastMigration: { tag: '0007_backups_system_state', when: 1_790_600_000_000 },
    createdAt: '2026-09-28T03:00:00.000Z',
    kind: 'scheduled',
    files: [{ path: 'db.dump', size: 10, sha256: SHA }],
  }

  it('accepts a format-1 manifest', () => {
    expect(parseBackupManifest(manifest)).toEqual({ ok: true, value: manifest })
  })

  it('names an unknown format instead of calling the file damaged', () => {
    expect(parseBackupManifest({ ...manifest, format: 2 })).toEqual({ ok: false, error: 'This backup uses format 2, which this version cannot read' })
  })

  it('refuses a missing or damaged manifest', () => {
    expect(parseBackupManifest(null)).toMatchObject({ ok: false, error: 'The backup has no readable manifest' })
    expect(parseBackupManifest({ ...manifest, files: [{ path: 'db.dump', size: 1, sha256: 'xyz' }] })).toMatchObject({ ok: false, error: 'The backup manifest is damaged' })
  })
})

describe('cron and settings', () => {
  it('accepts five-field schedules and rejects everything else', () => {
    for (const ok of ['0 3 * * *', '*/15 * * * *', '0 3 * * 1-5', '30 2 1,15 * *', '0 0 * * 7']) expect(isValidCron(ok), ok).toBe(true)
    for (const bad of ['0 3 * *', '60 3 * * *', '0 24 * * *', '0 3 0 * *', '* * * * * *', 'a b c d e', '5-1 * * * *', '*/0 * * * *', '']) {
      expect(isValidCron(bad), bad).toBe(false)
    }
  })

  it('validates settings: a null schedule means "use BACKUP_SCHEDULE"', () => {
    expect(BackupSettingsInput.safeParse({ schedule: null, retention: DEFAULT_RETENTION }).success).toBe(true)
    expect(BackupSettingsInput.safeParse({ schedule: '0 25 * * *', retention: DEFAULT_RETENTION }).success).toBe(false)
    expect(BackupSettingsInput.safeParse({ schedule: null, retention: { ...DEFAULT_RETENTION, scheduled: 0 } }).success).toBe(false)
  })
})

describe('backupIsStale', () => {
  const now = new Date('2026-09-28T12:00:00Z')
  it('is stale with no backup, or with none in the last 48 hours', () => {
    expect(backupIsStale(null, now)).toBe(true)
    expect(backupIsStale(new Date('2026-09-26T13:00:00Z'), now)).toBe(false)
    expect(backupIsStale(new Date('2026-09-26T11:00:00Z'), now)).toBe(true)
  })
})

describe('isWellFormedSecretKey', () => {
  it('wants exactly 32 bytes of base64', () => {
    expect(isWellFormedSecretKey('ZGV2LW9ubHktc2VjcmV0LWtleS1kby1ub3QtdXNlISE=')).toBe(true)
    expect(isWellFormedSecretKey('')).toBe(false)
    expect(isWellFormedSecretKey('c2hvcnQ=')).toBe(false)
    expect(isWellFormedSecretKey('ZGV2LW9ubHktc2VjcmV0LWtleS1kby1ub3QtdXNlISE=x')).toBe(false)
  })
})
