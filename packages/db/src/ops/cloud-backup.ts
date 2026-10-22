import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { listBackups, UPLOADS_DIR } from './backups'
import { describeError } from './fs-utils'

/**
 * #106: a copy of BACKUP_DIR's verified zips in the cloud (Backblaze B2 through its S3 API), made by restic,
 * which encrypts it on this machine (every zip carries APP_SECRET_KEY). Each copy is checked by reading the
 * newest zip back and comparing its hash. Nothing here touches the database: the status is a file next to the
 * backups, which the worker writes and Admin reads.
 */

/** snapshots carry this host, not the container's random hostname */
export const CLOUD_HOST = 'my-library'
export const CLOUD_RETENTION = ['--keep-daily', '14', '--keep-monthly', '12', '--keep-yearly', 'unlimited'] as const
export const CLOUD_STATUS_FILE = '.cloud-backup.json'
/** restic's cache: on the backup disk, not the SD card or the worker's in-memory /tmp */
export const CLOUD_CACHE_DIR = '.restic-cache'
/** restic's exit code when the repository does not exist (restic >= 0.17) */
const REPO_MISSING = 10
/** restic backup: the snapshot was made, but some file could not be read (a zip pruned mid-run) */
const PARTIAL = 3

/** The first call of a run: restic retries an unreachable cloud for about 15 minutes. */
const PROBE_TIMEOUT_MS = 2 * 60_000
/** Far longer than any household upload over home broadband, so only a hang hits them. */
const LONG_TIMEOUT_MS = 6 * 3_600_000
const SHORT_TIMEOUT_MS = 60 * 60_000

export interface CloudConfig {
  repository: string
  password: string
  /** credentials for the repository's backend: AWS_* for S3 (B2's S3 API), B2_* for restic's own B2 backend */
  credentials: Record<string, string>
  /** the restic binary (the image's /usr/local/bin/restic; tests: RESTIC_BIN) */
  bin?: string
}

export interface ResticResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type ResticRunner = (args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal; onStdout?: (chunk: Buffer) => void }) => Promise<ResticResult>

const KEEP_OUTPUT = 256 * 1024

/** restic with only its own variables: never the database URL or APP_SECRET_KEY. */
export function createResticRunner(config: CloudConfig, backupDir: string): ResticRunner {
  const cacheDir = path.join(backupDir, CLOUD_CACHE_DIR)
  const env: Record<string, string> = {
    ...config.credentials,
    RESTIC_REPOSITORY: config.repository,
    RESTIC_PASSWORD: config.password,
    RESTIC_CACHE_DIR: cacheDir,
    HOME: cacheDir,
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.TZ === undefined ? {} : { TZ: process.env.TZ }),
    // Windows (development and tests) needs these to resolve its own folders
    ...(process.platform === 'win32' ? Object.fromEntries(['SYSTEMROOT', 'TEMP', 'TMP', 'LOCALAPPDATA'].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]]]))) : {}),
  }
  return (args, options) =>
    new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const done = (result: ResticResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const child = spawn(config.bin ?? 'restic', [...args], { env, stdio: ['ignore', 'pipe', 'pipe'], ...(options.signal === undefined ? {} : { signal: options.signal }) })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, options.timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        if (options.onStdout !== undefined) options.onStdout(chunk)
        // the tail: `backup --json` ends with its summary, after a status line every few seconds
        else stdout = (stdout + chunk.toString()).slice(-KEEP_OUTPUT)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-KEEP_OUTPUT)
      })
      child.on('error', (error) => done({ code: null, stdout, stderr: `${stderr}\n${describeError(error)}`, timedOut }))
      child.on('close', (code) => done({ code, stdout, stderr, timedOut }))
    })
}

/** The line that says what went wrong: restic's last `Fatal:` line, else its last line. */
export function resticDetail(result: ResticResult): string {
  if (result.timedOut) {
    // restic retries every error for 15 minutes, a refused key too: its last retry says why
    const cause = [...result.stderr.matchAll(/returned error, retrying after [^:]*: (.+)$/gm)].at(-1)?.[1]?.trim()
    return cause === undefined ? 'no answer in time (is the cloud reachable?)' : `no answer in time: ${cause.length > 300 ? `${cause.slice(0, 300)}…` : cause}`
  }
  const lines = result.stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('{'))
  const line = [...lines].reverse().find((l) => l.startsWith('Fatal:')) ?? lines.at(-1) ?? `exit code ${result.code ?? 'none'}`
  return line.length > 300 ? `${line.slice(0, 300)}…` : line
}

class CloudCopyError extends Error {}

const at = z.iso.datetime()
export const CloudBackupStatus = z.object({
  configured: z.boolean(),
  lastSuccess: z.object({ at, file: z.string(), snapshot: z.string(), warning: z.string().nullable() }).nullable(),
  lastFailure: z.object({ at, error: z.string() }).nullable(),
})
export type CloudBackupStatus = z.output<typeof CloudBackupStatus>
const EMPTY: CloudBackupStatus = { configured: false, lastSuccess: null, lastFailure: null }

/** Null when the worker has never written one (an older worker, or the very first start). */
export async function readCloudStatus(backupDir: string): Promise<CloudBackupStatus | null> {
  try {
    const parsed = CloudBackupStatus.safeParse(JSON.parse(await readFile(path.join(backupDir, CLOUD_STATUS_FILE), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function writeCloudStatus(backupDir: string, status: CloudBackupStatus): Promise<void> {
  const file = path.join(backupDir, CLOUD_STATUS_FILE)
  await writeFile(`${file}.new`, JSON.stringify(status))
  await rename(`${file}.new`, file)
}

export async function updateCloudStatus(backupDir: string, change: (status: CloudBackupStatus) => CloudBackupStatus): Promise<void> {
  await writeCloudStatus(backupDir, change((await readCloudStatus(backupDir)) ?? EMPTY))
}

async function sha256(source: AsyncIterable<Buffer>): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of source) hash.update(chunk)
  return hash.digest('hex')
}

export type CloudCopyResult = { outcome: 'nothing' } | { outcome: 'copied'; file: string; snapshot: string; warning: string | null } | { outcome: 'failed'; error: string }

/**
 * One copy: create the repository if it is new, back up BACKUP_DIR's zips, read the newest one back and compare
 * it with the local file, then forget and prune old snapshots and check the repository. The copy succeeds once
 * the read-back matches; a failed prune or check after that is a warning. Never throws; the result is also
 * written to the status file.
 */
export async function copyToCloud(backupDir: string, restic: ResticRunner, options: { signal?: AbortSignal; now?: () => Date } = {}): Promise<CloudCopyResult> {
  const now = options.now ?? (() => new Date())
  const run = (args: readonly string[], timeoutMs: number, onStdout?: (chunk: Buffer) => void) =>
    restic(args, { timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }), ...(onStdout === undefined ? {} : { onStdout }) })
  const newest = (await listBackups(backupDir))[0]
  if (newest === undefined) return { outcome: 'nothing' }
  let result: CloudCopyResult
  try {
    const probe = await run(['cat', 'config'], PROBE_TIMEOUT_MS)
    if (probe.code === REPO_MISSING) {
      const init = await run(['init'], PROBE_TIMEOUT_MS)
      if (init.code !== 0) throw new CloudCopyError(`could not create the cloud repository: ${resticDetail(init)}`)
    } else if (probe.code !== 0) {
      throw new CloudCopyError(`could not reach the cloud repository: ${resticDetail(probe)}`)
    }

    const backup = await run(['backup', backupDir, '--host', CLOUD_HOST, '--json', '--exclude', path.join(backupDir, UPLOADS_DIR), '--exclude', '.*', '--exclude', '*.tmp'], LONG_TIMEOUT_MS)
    if (backup.code !== 0 && backup.code !== PARTIAL) throw new CloudCopyError(`the upload failed: ${resticDetail(backup)}`)
    const summary = backup.stdout
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as { message_type?: string; snapshot_id?: string }
        } catch {
          return null
        }
      })
      .find((m) => m?.message_type === 'summary')
    const snapshot = summary?.snapshot_id
    if (snapshot === undefined) throw new CloudCopyError('the upload finished without a snapshot')
    const warnings: string[] = backup.code === PARTIAL ? [`a file changed during the upload: ${resticDetail(backup)}`] : []

    // the read-back: the newest zip, as stored, must hash the same as the file on disk
    const listing = await run(['ls', '--json', snapshot], SHORT_TIMEOUT_MS)
    if (listing.code !== 0) throw new CloudCopyError(`could not list the new snapshot: ${resticDetail(listing)}`)
    const stored = listing.stdout
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as { type?: string; name?: string; path?: string }
        } catch {
          return null
        }
      })
      .find((n) => n?.type === 'file' && n.name === newest.name)?.path
    if (stored === undefined) throw new CloudCopyError(`${newest.name} is missing from the new snapshot`)
    const remote = createHash('sha256')
    const dump = await run(['dump', snapshot, stored], LONG_TIMEOUT_MS, (chunk) => remote.update(chunk))
    if (dump.code !== 0) throw new CloudCopyError(`could not read ${newest.name} back from the cloud: ${resticDetail(dump)}`)
    if (remote.digest('hex') !== (await sha256(createReadStream(path.join(backupDir, newest.name))))) {
      throw new CloudCopyError(`the cloud copy of ${newest.name} does not match the file on disk`)
    }

    const forget = await run(['forget', '--host', CLOUD_HOST, ...CLOUD_RETENTION, '--prune'], SHORT_TIMEOUT_MS)
    if (forget.code !== 0) warnings.push(`removing old cloud copies failed: ${resticDetail(forget)}`)
    const check = await run(['check'], SHORT_TIMEOUT_MS)
    if (check.code !== 0) warnings.push(`repository check failed: ${resticDetail(check)}`)
    result = { outcome: 'copied', file: newest.name, snapshot, warning: warnings.length === 0 ? null : warnings.join('; ') }
  } catch (error) {
    result = { outcome: 'failed', error: error instanceof CloudCopyError ? error.message : describeError(error) }
  }
  // stopped by the worker (a shutdown, a restore): not a failure of the cloud copy, so not recorded as one
  if (options.signal?.aborted === true && result.outcome === 'failed') return result
  const finished = now().toISOString()
  try {
    await updateCloudStatus(backupDir, (s) =>
      result.outcome === 'copied'
        ? { ...s, configured: true, lastSuccess: { at: finished, file: result.file, snapshot: result.snapshot, warning: result.warning }, lastFailure: null }
        : { ...s, configured: true, lastFailure: { at: finished, error: result.error } },
    )
  } catch (error) {
    console.error(`[cloud] could not write the cloud backup status: ${describeError(error)}`)
  }
  return result
}

/** Whether BACKUP_DIR has a newer zip than the last verified cloud copy. */
export async function cloudCopyBehind(backupDir: string): Promise<boolean> {
  const newest = (await listBackups(backupDir))[0]
  if (newest === undefined) return false
  return (await readCloudStatus(backupDir))?.lastSuccess?.file !== newest.name
}
