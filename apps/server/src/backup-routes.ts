import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { backupFilePath, describeFsError, freeBytes, MAX_BACKUP_BYTES, NotEnoughSpaceError, syncFile, uploadFilePath, UPLOADS_DIR, validateBackup, VALIDATION_WORK_PREFIX, type BackupLimits } from '@mylib/db'
import { DomainError } from '@mylib/domain'
import { Hono } from 'hono'
import { sessionUserFromCookie } from './auth/session-user'
import type { AppDeps } from './trpc/context'

/** A browser form can only send urlencoded, multipart or text/plain; requiring a zip type keeps this CSRF-safe (plan deviation 16). */
const ZIP_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream'])
/** leave this much free on the backup volume after an upload */
const UPLOAD_HEADROOM_BYTES = 1024 ** 3

async function adminCheck(deps: AppDeps, cookie: string | undefined): Promise<'ok' | 401 | 403> {
  const { user } = await sessionUserFromCookie(deps, cookie ?? null)
  if (!user) return 401
  return user.role === 'admin' ? 'ok' : 403
}

/** Thrown by sizeCapTransform to abort the upload pipeline once too much has been streamed. */
class UploadTooLargeError extends Error {
  constructor(
    readonly status: 413 | 507,
    message: string,
  ) {
    super(message)
    this.name = 'UploadTooLargeError'
  }
}

/**
 * Ruling R26: bounds the upload while it streams, not only from a declared `content-length` — a chunked
 * body has none, and a client could lie about one it does send. Counts bytes as they pass through and
 * aborts the pipeline (so the write stream is destroyed and nothing more is read from the source) once
 * the total exceeds `caps.hard` (413, this server's absolute limit) or `caps.freeSpace` (507, this
 * volume's actual free space right now), whichever is smaller.
 */
function sizeCapTransform(caps: { hard: number; freeSpace: number | null }): Transform {
  let total = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > caps.hard) {
        callback(new UploadTooLargeError(413, 'The upload is larger than this server will accept'))
        return
      }
      if (caps.freeSpace !== null && total > caps.freeSpace) {
        callback(new UploadTooLargeError(507, 'Not enough free space in BACKUP_DIR for this upload'))
        return
      }
      callback(null, chunk)
    },
  })
}

export interface BackupRoutesOptions {
  /** tests: caps the upload route's hard byte limit (default: MAX_BACKUP_BYTES) */
  maxUploadBytes?: number
  /** tests: overrides the free-space check that runs inside validateBackup (default: the real disk) */
  statfs?: BackupLimits['statfs']
  /** tests: overrides the upload route's own free-space check (both the declared-length pre-check and
   * the streaming cap in sizeCapTransform); default: the real disk via freeBytes */
  freeBytes?: (dir: string) => Promise<number | null>
}

/** Uploads and downloads (plan deviation 16): plain routes, not tRPC — a raw zip body and a streamed file are neither JSON. */
export function backupRoutes(deps: AppDeps, options: BackupRoutesOptions = {}): Hono {
  const app = new Hono()
  const hardCap = options.maxUploadBytes ?? MAX_BACKUP_BYTES
  const getFreeBytes = options.freeBytes ?? freeBytes

  app.post('/admin/backups/upload', async (c) => {
    const auth = await adminCheck(deps, c.req.header('cookie'))
    if (auth !== 'ok') return c.json({ error: auth === 401 ? 'Please sign in' : 'Admins only' }, auth)
    const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!ZIP_TYPES.has(type)) return c.json({ error: 'Send the backup as a .zip file' }, 415)
    const body = c.req.raw.body
    if (body === null) return c.json({ error: 'The upload was empty' }, 400)

    const free = await getFreeBytes(deps.ops.backupDir)
    const freeSpaceCap = free === null ? null : free - UPLOAD_HEADROOM_BYTES
    // an honest declared content-length is rejected up front, before any byte is read or written;
    // a chunked body (no content-length), or a lie, is still caught by the streaming cap below
    const declaredHeader = c.req.header('content-length')
    const declared = declaredHeader === undefined ? null : Number(declaredHeader)
    if (declared !== null && declared > hardCap) return c.json({ error: 'The upload is larger than this server will accept' }, 413)
    if (declared !== null && freeSpaceCap !== null && declared > freeSpaceCap) return c.json({ error: 'Not enough free space in BACKUP_DIR for this upload' }, 507)

    const uploadId = randomUUID()
    await mkdir(path.join(deps.ops.backupDir, UPLOADS_DIR), { recursive: true })
    const final = uploadFilePath(deps.ops.backupDir, uploadId)
    const temp = `${final}.tmp`
    try {
      // never buffered in memory: streamed straight to disk, size-capped as it goes
      await pipeline(Readable.fromWeb(body as NodeWebReadableStream<Uint8Array>), sizeCapTransform({ hard: hardCap, freeSpace: freeSpaceCap }), createWriteStream(temp, { flags: 'wx' }))
      await syncFile(temp)
      await rename(temp, final)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      if (error instanceof UploadTooLargeError) return c.json({ error: error.message }, error.status)
      console.error('[backups] upload failed:', describeFsError(error))
      return c.json({ error: 'The upload failed' }, 500)
    }
    // inside the try below: a failure here (mkdtemp included) still removes the uploaded file and
    // answers a proper JSON error, rather than crashing the handler
    try {
      const work = await mkdtemp(path.join(deps.ops.backupDir, VALIDATION_WORK_PREFIX))
      try {
        // exactOptionalPropertyTypes: only set `statfs` when a test actually overrides it
        const { manifest } = await validateBackup(deps.ops, final, work, options.statfs === undefined ? {} : { statfs: options.statfs })
        return c.json({ uploadId, appVersion: manifest.appVersion, createdAt: manifest.createdAt, kind: manifest.kind, lastMigration: manifest.lastMigration.tag })
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (error) {
      await unlink(final).catch(() => undefined)
      if (error instanceof NotEnoughSpaceError) return c.json({ error: 'Not enough free disk space to process this upload' }, 507)
      if (error instanceof DomainError) return c.json({ error: error.message }, 400)
      console.error('[backups] upload validation failed:', describeFsError(error))
      return c.json({ error: 'The upload could not be validated' }, 500)
    }
  })

  // backups contain the secret key: admin session only, never cached, never logged (spec §4)
  app.get('/admin/backups/file/:name', async (c) => {
    const auth = await adminCheck(deps, c.req.header('cookie'))
    if (auth !== 'ok') return c.text(auth === 401 ? 'Unauthorized' : 'Forbidden', auth)
    const name = c.req.param('name')
    const full = backupFilePath(deps.ops.backupDir, name)
    if (full === null) return c.notFound()
    let size: number
    try {
      size = (await stat(full)).size
    } catch {
      return c.notFound()
    }
    const stream = Readable.toWeb(createReadStream(full)) as unknown as ReadableStream<Uint8Array>
    return c.body(stream, 200, {
      'content-type': 'application/zip',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
  })

  return app
}
