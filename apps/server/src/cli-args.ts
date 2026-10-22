export type RestoreArgs = { zipFile: string; preRestoreBackup: boolean; force: boolean } | { error: string }

// Carried requirement (Task 9 deferred minor 8): restoreBackup takes the 'backup' advisory lock, not
// 'migrate' — it cannot see a start-up in progress, and a starting app cannot see it either. Document
// that here, since this is the operator-facing surface for it.
const USAGE = [
  'Usage: node dist/restore-cli.js <backup.zip> [--no-pre-restore-backup] [--force]',
  '',
  'Stop the app and the worker first: docker compose stop app worker.',
  '',
  "Do not run this while another instance of the app is starting up. The restore takes the 'backup'",
  "advisory lock, not the 'migrate' lock a starting app holds while it runs its own checks and",
  'migrations — the two locks cannot see each other, so a restore that races a start-up is not refused.',
  '',
  '--force: proceed even though another session (the app, the worker, or anything else) is still',
  'connected to the live database. Without it, the CLI refuses rather than restore underneath a',
  'process that is still reading or writing.',
].join('\n')

const KNOWN_FLAGS = new Set(['--no-pre-restore-backup', '--force'])

export function parseRestoreArgs(argv: readonly string[]): RestoreArgs {
  const flags = argv.filter((a) => a.startsWith('--'))
  const files = argv.filter((a) => !a.startsWith('--'))
  const unknown = flags.find((f) => !KNOWN_FLAGS.has(f))
  if (unknown !== undefined) return { error: `Unknown option ${unknown}` }
  const [zipFile, ...rest] = files
  if (zipFile === undefined || rest.length > 0) return { error: USAGE }
  return { zipFile, preRestoreBackup: !flags.includes('--no-pre-restore-backup'), force: flags.includes('--force') }
}
