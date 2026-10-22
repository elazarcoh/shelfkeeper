import { describe, expect, it } from 'vitest'
import { parseRestoreArgs } from './cli-args'

describe('parseRestoreArgs', () => {
  it('takes one backup file and optional flags', () => {
    expect(parseRestoreArgs(['/backups/a.zip'])).toEqual({ zipFile: '/backups/a.zip', preRestoreBackup: true, force: false })
    expect(parseRestoreArgs(['--no-pre-restore-backup', '/backups/a.zip'])).toEqual({ zipFile: '/backups/a.zip', preRestoreBackup: false, force: false })
    // Fix round 1 minor: --force lets the CLI proceed even with other sessions on the live database.
    expect(parseRestoreArgs(['--force', '/backups/a.zip'])).toEqual({ zipFile: '/backups/a.zip', preRestoreBackup: true, force: true })
    expect(parseRestoreArgs(['--force', '--no-pre-restore-backup', '/backups/a.zip'])).toEqual({ zipFile: '/backups/a.zip', preRestoreBackup: false, force: true })
  })
  it('explains how to call it otherwise', () => {
    expect(parseRestoreArgs([])).toMatchObject({ error: expect.stringContaining('Usage') as unknown })
    expect(parseRestoreArgs(['a.zip', 'b.zip'])).toMatchObject({ error: expect.stringContaining('Usage') as unknown })
    expect(parseRestoreArgs(['--bogus', 'a.zip'])).toEqual({ error: 'Unknown option --bogus' })
  })

  // Carried requirement: document that this must not run during another instance's start-up, since
  // restore takes the 'backup' lock, not 'migrate' (Task 9 deferred minor 8).
  it('documents the backup-vs-migrate lock caveat', () => {
    const result = parseRestoreArgs([])
    expect(result).toMatchObject({ error: expect.stringMatching(/'backup'[\s\S]*lock/) as unknown })
    expect(result).toMatchObject({ error: expect.stringMatching(/'migrate'[\s\S]*lock/) as unknown })
  })
})
