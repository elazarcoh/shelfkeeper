import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, statfs as fsStatfs, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import yazl from 'yazl'
import { DomainError, parseBackupManifest, type BackupManifest } from '@mylib/domain'
import { exists, syncDir, syncFile } from './fs-utils'
import { PgToolError, type PgTools } from './pg-tools'

export const BACKUP_DUMP = 'db.dump'
export const BACKUP_SECRET = 'secret.key'
export const BACKUP_MANIFEST = 'manifest.json'
export const BACKUP_ASSETS = 'assets/'
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
/** Zip-bomb guard: stop reading the central directory beyond this many entries (Important review finding). */
const DEFAULT_MAX_ENTRIES = 200_000
/** Zip-bomb guard: refuse a backup whose manifest declares more total bytes than this. Also the hard cap
 * an upload's own byte stream is held to (ruling R26; apps/server/src/backup-routes.ts). */
export const MAX_BACKUP_BYTES = 64 * 1024 ** 3
/** Margin kept free on top of what an extraction needs, before refusing for lack of disk space. */
const FREE_SPACE_MARGIN_BYTES = 1024 ** 3

export class BackupInvalidError extends DomainError {
  constructor(message: string) {
    super('INVALID', message)
  }
}

/** Thrown by checkFreeSpace: extracting (or writing) this backup would not leave enough free disk space.
 * Ruling R26: a dedicated class so callers can map it precisely, instead of matching on message text —
 * its own message never names a path, only byte counts. */
export class NotEnoughSpaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotEnoughSpaceError'
  }
}

/** A path inside the asset store: plain segments only, no dot-folders (`.prev-*`, `.restore-*`), no backslash, no drive. */
export function isSafeRelativePath(rel: string): boolean {
  if (rel === '' || rel.includes('\\') || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false
  return rel.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('.'))
}

/** The backup layout (spec §4): the three fixed files, or a file under assets/. */
export function isSafeEntryName(name: string): boolean {
  if (name === BACKUP_DUMP || name === BACKUP_SECRET || name === BACKUP_MANIFEST) return true
  return name.startsWith(BACKUP_ASSETS) && isSafeRelativePath(name.slice(BACKUP_ASSETS.length))
}

/** Unix mode is packed into the high 16 bits of a zip entry's external attributes (Info-Zip convention). */
function isSymlinkEntry(entry: yauzl.Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
}

/**
 * Round-2 review finding: a local I/O error reading the central directory or an entry (disk failure,
 * permissions, too many open files, out of space) is an environment problem, never a "this backup is
 * damaged" verdict -- consistent with `openZip`'s own check.
 */
const LOCAL_READ_ERROR_CODES = new Set(['EIO', 'EACCES', 'EMFILE', 'ENOSPC'])
function isLocalReadError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && LOCAL_READ_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? '')
}

async function hashStream(stream: Readable): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of stream) {
    const bytes = chunk as Buffer
    hash.update(bytes)
    size += bytes.length
  }
  return { size, sha256: hash.digest('hex') }
}

async function streamToString(stream: Readable, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const bytes = chunk as Buffer
    total += bytes.length
    if (total > limit) throw new BackupInvalidError('The backup manifest is damaged')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface BackupContent {
  dumpFile: string
  assetsRoot: string
  /** paths relative to assetsRoot, as stored in asset.path */
  assetPaths: readonly string[]
  secretKey: string
  manifest: Omit<BackupManifest, 'files'>
}

/** Writes the zip to `outFile` (which must not exist) and fsyncs it. The dump and the covers are stored, not recompressed. */
export async function writeBackupZip(outFile: string, content: BackupContent): Promise<BackupManifest> {
  const secret = Buffer.from(content.secretKey, 'utf8')
  const files: BackupManifest['files'] = [{ path: BACKUP_DUMP, ...(await hashStream(createReadStream(content.dumpFile))) }]
  for (const rel of content.assetPaths) {
    if (!isSafeRelativePath(rel)) throw new Error('An asset path is outside the asset store')
    files.push({ path: `${BACKUP_ASSETS}${rel}`, ...(await hashStream(createReadStream(path.join(content.assetsRoot, ...rel.split('/'))))) })
  }
  files.push({ path: BACKUP_SECRET, size: secret.length, sha256: createHash('sha256').update(secret).digest('hex') })
  const manifest: BackupManifest = { ...content.manifest, files }

  const zip = new yazl.ZipFile()
  zip.addFile(content.dumpFile, BACKUP_DUMP, { compress: false })
  for (const rel of content.assetPaths) zip.addFile(path.join(content.assetsRoot, ...rel.split('/')), `${BACKUP_ASSETS}${rel}`, { compress: false })
  zip.addBuffer(secret, BACKUP_SECRET)
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), BACKUP_MANIFEST)
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(outFile, { flags: 'wx' }))
  await syncFile(outFile)
  return manifest
}

/** Important review finding: an I/O error opening the zip file itself (missing, unreadable, too many open files, …) is an environment problem, never a "this backup is damaged" verdict. */
function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error: Error | null, zip: yauzl.ZipFile | undefined) => {
      if (error !== null) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EMFILE' || code === 'EIO') {
          reject(error)
          return
        }
        reject(new BackupInvalidError('This is not a readable backup file'))
        return
      }
      if (zip === undefined) {
        reject(new BackupInvalidError('This is not a readable backup file'))
        return
      }
      resolve(zip)
    })
  })
}

/** Zip-bomb guard: stops reading (and rejects) as soon as more than `maxEntries` entries have been seen. */
function readEntries(zip: yauzl.ZipFile, maxEntries: number): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = []
    let stopped = false
    zip.on('entry', (entry: yauzl.Entry) => {
      if (stopped) return
      entries.push(entry)
      if (entries.length > maxEntries) {
        stopped = true
        reject(new BackupInvalidError('The backup has too many entries'))
        return
      }
      zip.readEntry()
    })
    zip.once('end', () => resolve(entries))
    zip.once('error', (error: Error) => reject(isLocalReadError(error) ? error : new BackupInvalidError('The backup file is damaged')))
    zip.readEntry()
  })
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error: Error | null, stream: Readable | undefined) => {
      if (error !== null || stream === undefined) reject(isLocalReadError(error) ? error : new BackupInvalidError('The backup file is damaged'))
      else resolve(stream)
    })
  })
}

export interface OpenedBackup {
  manifest: BackupManifest
  /** re-reads every listed file (except any in `options.except`) and checks its size and sha256 */
  verify(options?: { except?: readonly string[] }): Promise<void>
  read(name: string): Promise<Readable>
  close(): void
}

export interface BackupLimits {
  /** zip-bomb guard: stop reading the central directory beyond this many entries (default 200,000) */
  maxEntries?: number
  /** zip-bomb guard: refuse a backup whose manifest declares more total bytes than this (default 64 GiB) */
  maxTotalBytes?: number
  /** the free-space check before extracting; injectable for tests (default: `node:fs/promises` `statfs`) */
  statfs?: (dir: string) => Promise<{ bavail: number; bsize: number }>
  /** 3d item 3/4: stops the `pg_restore --list` check (a lost ops lock) */
  signal?: AbortSignal
}

async function defaultStatfs(dir: string): Promise<{ bavail: number; bsize: number }> {
  const stats = await fsStatfs(dir)
  return { bavail: stats.bavail, bsize: stats.bsize }
}

/** Important review finding: refuses to extract into a filesystem that does not have `bytesNeeded` plus a safety margin free. */
async function checkFreeSpace(dir: string, bytesNeeded: number, statfs: (dir: string) => Promise<{ bavail: number; bsize: number }>): Promise<void> {
  const stats = await statfs(dir)
  const free = stats.bavail * stats.bsize
  const needed = bytesNeeded + FREE_SPACE_MARGIN_BYTES
  if (free < needed) throw new NotEnoughSpaceError(`Not enough free disk space to extract this backup (need ${needed} bytes, ${free} free)`)
}

function hashingTransform(): { stream: Transform; digest: () => { size: number; sha256: string } } {
  const hash = createHash('sha256')
  let size = 0
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      size += chunk.length
      callback(null, chunk)
    },
  })
  return { stream, digest: () => ({ size, sha256: hash.digest('hex') }) }
}

/**
 * Important review finding: extracts `source` into `target` (which must not exist) while hashing in the
 * same pass, so a large file is never read twice. Deletes `target` and throws on any I/O error or on a
 * size/sha256 mismatch against `expected` — never leaves a half-written or unverified file behind.
 */
async function extractVerified(source: Readable, target: string, expected: { size: number; sha256: string }): Promise<void> {
  const { stream: hasher, digest } = hashingTransform()
  try {
    await pipeline(source, hasher, createWriteStream(target, { flags: 'wx' }))
  } catch (error) {
    await unlink(target).catch(() => undefined)
    throw error
  }
  const actual = digest()
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    await unlink(target).catch(() => undefined)
    throw new BackupInvalidError('The backup is damaged (a file does not match its checksum)')
  }
}

/** Opens a zip and checks its layout and manifest; nothing is extracted yet. */
export async function openBackup(zipFile: string, limits: BackupLimits = {}): Promise<OpenedBackup> {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_BACKUP_BYTES
  const zip = await openZip(zipFile)
  try {
    const byName = new Map<string, yauzl.Entry>()
    for (const entry of await readEntries(zip, maxEntries)) {
      if (isSymlinkEntry(entry)) throw new BackupInvalidError('The backup contains a symlink, which is not allowed')
      if (entry.fileName.endsWith('/')) {
        // a folder entry some zip tools add ("assets/", "assets/covers/"): nothing to read. Minor
        // review finding: only accepted under assets/ -- never for the three fixed top-level names.
        // Round-2 finding: the startsWith check is required -- without it, slicing off the first 7
        // characters of e.g. "secret.key/" or "manifest.json/" can itself look like a safe relative
        // path ("key" or a prefix of "json/"), wrongly treating that directory entry as assets/*.
        if (entry.fileName === BACKUP_ASSETS || (entry.fileName.startsWith(BACKUP_ASSETS) && isSafeRelativePath(entry.fileName.slice(BACKUP_ASSETS.length, -1)))) continue
        throw new BackupInvalidError('The backup contains a directory entry outside the backup layout')
      }
      if (!isSafeEntryName(entry.fileName)) throw new BackupInvalidError('The backup contains a file outside the backup layout')
      if (byName.has(entry.fileName)) throw new BackupInvalidError('The backup lists a file twice')
      byName.set(entry.fileName, entry)
    }
    const manifestEntry = byName.get(BACKUP_MANIFEST)
    if (manifestEntry === undefined) throw new BackupInvalidError('The backup has no manifest')
    let json: unknown
    try {
      json = JSON.parse(await streamToString(await openEntry(zip, manifestEntry), MAX_MANIFEST_BYTES))
    } catch (error) {
      if (error instanceof BackupInvalidError) throw error
      throw new BackupInvalidError('The backup has no readable manifest')
    }
    const parsed = parseBackupManifest(json)
    if (!parsed.ok) throw new BackupInvalidError(parsed.error)
    const manifest = parsed.value

    const listed = new Set<string>()
    let totalDeclaredBytes = 0
    for (const file of manifest.files) {
      if (listed.has(file.path)) throw new BackupInvalidError('The backup manifest lists a file twice')
      listed.add(file.path)
      totalDeclaredBytes += file.size
      if (!isSafeEntryName(file.path) || file.path === BACKUP_MANIFEST) throw new BackupInvalidError('The backup manifest lists a file outside the backup layout')
      const zipEntry = byName.get(file.path)
      if (zipEntry === undefined) throw new BackupInvalidError('The backup is missing a file its manifest lists')
      // Important review finding: fail fast on a declared-size mismatch, before ever hashing the entry.
      if (zipEntry.uncompressedSize !== file.size) throw new BackupInvalidError('The backup manifest does not match its zip entries')
    }
    for (const name of byName.keys()) {
      if (name !== BACKUP_MANIFEST && !listed.has(name)) throw new BackupInvalidError('The backup contains a file its manifest does not list')
    }
    if (totalDeclaredBytes > maxTotalBytes) throw new BackupInvalidError('The backup is larger than this server will extract')
    if (!listed.has(BACKUP_DUMP) || !listed.has(BACKUP_SECRET)) throw new BackupInvalidError('The backup has no database dump or no secret key')

    const entryOf = (name: string): yauzl.Entry => {
      const entry = byName.get(name)
      if (entry === undefined) throw new BackupInvalidError('The backup is missing a file its manifest lists')
      return entry
    }
    return {
      manifest,
      async verify(options = {}) {
        const skip = new Set(options.except ?? [])
        for (const file of manifest.files) {
          if (skip.has(file.path)) continue
          let actual: { size: number; sha256: string }
          try {
            actual = await hashStream(await openEntry(zip, entryOf(file.path)))
          } catch (error) {
            if (isLocalReadError(error)) throw error
            throw new BackupInvalidError('The backup is damaged (a file cannot be read back)')
          }
          if (actual.size !== file.size || actual.sha256 !== file.sha256) throw new BackupInvalidError('The backup is damaged (a file does not match its checksum)')
        }
      },
      read: (name) => openEntry(zip, entryOf(name)),
      close: () => zip.close(),
    }
  } catch (error) {
    zip.close()
    throw error
  }
}

export async function readBackupManifest(zipFile: string): Promise<BackupManifest> {
  const backup = await openBackup(zipFile)
  backup.close()
  return backup.manifest
}

/**
 * Spec §4 verification: re-read the zip, check every sha256, and `pg_restore --list` the dump. The
 * dump is left at `workDir/verify.dump` (a restore restores from it); the caller removes `workDir`.
 * The dump is hashed while it is extracted (one pass, not hash-then-re-read); every other listed file
 * is hash-checked without being written to disk.
 *
 * Controller ruling R3: only a PgToolError that means "pg_restore actually ran and rejected this dump"
 * is mapped to the damaged-dump verdict. Any other error -- the tool couldn't even be spawned, an I/O
 * failure reading/writing the dump, ... -- is rethrown unchanged, so a missing pg_restore binary never
 * gets reported as a corrupt backup. See `PgToolError.kind` in ./pg-tools.
 */
export async function verifyBackupZip(zipFile: string, pgTools: PgTools, workDir: string, limits: BackupLimits = {}): Promise<{ manifest: BackupManifest; dumpFile: string; secretKey: string }> {
  const backup = await openBackup(zipFile, limits)
  try {
    const dumpMeta = backup.manifest.files.find((file) => file.path === BACKUP_DUMP)
    if (dumpMeta === undefined) throw new BackupInvalidError('The backup has no database dump or no secret key')
    await checkFreeSpace(workDir, dumpMeta.size, limits.statfs ?? defaultStatfs)
    const dumpFile = path.join(workDir, 'verify.dump')
    await unlink(dumpFile).catch(() => undefined)
    await extractVerified(await backup.read(BACKUP_DUMP), dumpFile, dumpMeta)
    await backup.verify({ except: [BACKUP_DUMP] })
    try {
      await pgTools.list(dumpFile, limits.signal === undefined ? {} : { signal: limits.signal })
    } catch (error) {
      if (error instanceof PgToolError && error.kind === 'exit') {
        throw new BackupInvalidError('The database dump in the backup cannot be read')
      }
      throw error
    }
    const secretKey = (await streamToString(await backup.read(BACKUP_SECRET), 4096)).trim()
    return { manifest: backup.manifest, dumpFile, secretKey }
  } finally {
    backup.close()
  }
}

/**
 * Restore (plan deviation 7): every cover in the backup is written into the content-addressed store
 * (temp file, hashed while it is written, fsync, rename), and a file already there is kept. Returns
 * how many were written.
 */
export async function copyBackupAssets(zipFile: string, assetsRoot: string, limits: BackupLimits = {}): Promise<number> {
  const backup = await openBackup(zipFile, limits)
  let written = 0
  try {
    const assetFiles = backup.manifest.files.filter((file) => file.path.startsWith(BACKUP_ASSETS))
    const targetOf = (file: (typeof assetFiles)[number]) => path.join(assetsRoot, ...file.path.slice(BACKUP_ASSETS.length).split('/'))
    const missing: typeof assetFiles = []
    for (const file of assetFiles) {
      if (!(await exists(targetOf(file)))) missing.push(file)
    }
    const totalBytes = missing.reduce((sum, file) => sum + file.size, 0)
    // Round-2 finding: a fresh install has no asset store yet -- create it before statfs'ing it,
    // or the free-space check itself fails with ENOENT.
    await mkdir(assetsRoot, { recursive: true })
    await checkFreeSpace(assetsRoot, totalBytes, limits.statfs ?? defaultStatfs)
    for (const file of missing) {
      const target = targetOf(file)
      await mkdir(path.dirname(target), { recursive: true })
      const temp = `${target}.${randomUUID()}.tmp`
      try {
        await extractVerified(await backup.read(file.path), temp, file)
        await syncFile(temp)
        await rename(temp, target)
        await syncDir(path.dirname(target))
        written++
      } finally {
        await unlink(temp).catch(() => undefined)
      }
    }
    return written
  } finally {
    backup.close()
  }
}
