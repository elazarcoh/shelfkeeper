import { describe, expect, it } from 'vitest'
import { DEV_SECRET_KEY } from '@mylib/db'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('leaves a missing production key to the start-up checks instead of crashing', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).appSecretKey).toBe('')
    expect(loadConfig({}).appSecretKey).toBe(DEV_SECRET_KEY)
  })

  it('reads the backup, path and version settings', () => {
    const config = loadConfig({
      APP_VERSION: '0.4.0',
      BACKUP_DIR: '/backups',
      PROTECTED_PATHS: '/Media/Media: /Media/Downloads:',
      HOST_DATA_DIR: '/Media/komodo/stacks/my-library/data',
      HOST_BACKUP_DIR: '/Media/Backup/my-library',
      REQUIRE_VOLUME_MARKERS: 'true',
    })
    expect(config).toMatchObject({
      appVersion: '0.4.0',
      backupDir: '/backups',
      backupScheduleDefault: '0 3 * * *',
      protectedPaths: ['/Media/Media', '/Media/Downloads'],
      hostDataDir: '/Media/komodo/stacks/my-library/data',
      hostBackupDir: '/Media/Backup/my-library',
      requireVolumeMarkers: true,
    })
    expect(() => loadConfig({ BACKUP_SCHEDULE: '0 25 * * *' })).toThrow()
  })

  // Carried requirement (not in the brief's literal test): PROTECTED_PATHS is POSIX ':'-separated
  // (host paths are Linux paths on the Pi), but a naive split must not mangle a Windows drive letter
  // typed on a Windows dev box.
  it('keeps a Windows drive letter together when parsing PROTECTED_PATHS', () => {
    expect(loadConfig({ PROTECTED_PATHS: 'C:\\Users\\x:D:\\data' }).protectedPaths).toEqual(['C:\\Users\\x', 'D:\\data'])
    expect(loadConfig({ PROTECTED_PATHS: 'C:/Users/x' }).protectedPaths).toEqual(['C:/Users/x'])
  })
})
