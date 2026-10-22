import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { withOpsLock } from '@mylib/db'
import { testOpsEnv, useTestDb } from '@mylib/db/testing'
import { runBackupJob } from './run-backup'

describe('runBackupJob', () => {
  const t = useTestDb()

  it('writes a scheduled backup into BACKUP_DIR', async () => {
    const env = testOpsEnv(t.url)
    expect(await runBackupJob({ ops: env, log: () => undefined }, { kind: 'scheduled' })).toBe('done')
    expect(readdirSync(env.backupDir)).toEqual([expect.stringMatching(/-scheduled\.zip$/)])
  })

  it('skips, without failing, while another backup or a restore holds the lock', async () => {
    const env = testOpsEnv(t.url)
    await withOpsLock(env.databaseUrl, 'backup', async () => {
      expect(await runBackupJob({ ops: env, log: () => undefined }, { kind: 'scheduled' })).toBe('busy')
    })
    expect(readdirSync(env.backupDir)).toEqual([])
  })
})
