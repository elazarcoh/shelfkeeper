import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { rewriteBackup, tempDir, testOpsEnv, useTestDb } from '../testing'
import { BackupInvalidError } from './backup-file'
import { runBackup } from './backups'
import { validateBackup } from './restore'

describe('validateBackup (restore step 2)', () => {
  const t = useTestDb()

  it('accepts a backup of this version and hands back its dump and key', async () => {
    const env = testOpsEnv(t.url)
    const backup = await runBackup(env, 'manual')
    const validated = await validateBackup(env, path.join(env.backupDir, backup.name), tempDir('work'))
    expect(validated.manifest).toEqual(backup.manifest)
    expect(validated.secretKey).toBe(env.appSecretKey)
  })

  it('refuses a backup from a newer version (its last migration is unknown here)', async () => {
    const env = testOpsEnv(t.url)
    const backup = await runBackup(env, 'manual')
    const newer = path.join(tempDir('zip'), 'newer.zip')
    await rewriteBackup(path.join(env.backupDir, backup.name), newer, {
      manifest: (m) => ({ ...m, appVersion: '9.0.0', lastMigration: { tag: '0042_future', when: 9_999_999_999_999 } }),
    })
    await expect(validateBackup(env, newer, tempDir('work'))).rejects.toThrow('This backup is from a newer version of My Library (9.0.0)')
  })

  it('refuses an unknown manifest format', async () => {
    const env = testOpsEnv(t.url)
    const backup = await runBackup(env, 'manual')
    const future = path.join(tempDir('zip'), 'future.zip')
    await rewriteBackup(path.join(env.backupDir, backup.name), future, { manifest: (m) => ({ ...m, format: 7 }) })
    await expect(validateBackup(env, future, tempDir('work'))).rejects.toThrow('format 7')
  })

  it('refuses a malformed secret key', async () => {
    const env = testOpsEnv(t.url)
    const backup = await runBackup(env, 'manual')
    const badKey = path.join(tempDir('zip'), 'bad-key.zip')
    await rewriteBackup(path.join(env.backupDir, backup.name), badKey, { replace: { 'secret.key': Buffer.from('not-a-key') } })
    await expect(validateBackup(env, badKey, tempDir('work'))).rejects.toBeInstanceOf(BackupInvalidError)
  })
})
