import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import type { BackupManifest } from '@mylib/domain'
import { BACKUP_MANIFEST, openBackup } from '../ops/backup-file'
import { tempDir } from './ops'

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** A zip with exactly these entries (no manifest unless one is given), for tests that need a malformed backup. */
export async function zipOf(entries: Record<string, Buffer | string>): Promise<string> {
  const file = path.join(tempDir('zip'), 'backup.zip')
  const zip = new yazl.ZipFile()
  for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), name)
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(file))
  return file
}

/**
 * Copies a real backup with changes: a patched manifest, replaced entry contents (checksums updated
 * unless `keepChecksums`), or extra entries the manifest does not list.
 */
export async function rewriteBackup(
  source: string,
  target: string,
  change: { manifest?: (m: BackupManifest) => unknown; replace?: Record<string, Buffer>; add?: Record<string, Buffer>; keepChecksums?: boolean },
): Promise<void> {
  const backup = await openBackup(source)
  try {
    const zip = new yazl.ZipFile()
    let manifest: BackupManifest = backup.manifest
    for (const file of backup.manifest.files) {
      const replaced = change.replace?.[file.path]
      const data = replaced ?? (await toBuffer(await backup.read(file.path)))
      zip.addBuffer(data, file.path)
      if (replaced !== undefined && change.keepChecksums !== true) {
        manifest = { ...manifest, files: manifest.files.map((f) => (f.path === file.path ? { path: f.path, size: data.length, sha256: sha(data) } : f)) }
      }
    }
    for (const [name, data] of Object.entries(change.add ?? {})) zip.addBuffer(data, name)
    zip.addBuffer(Buffer.from(JSON.stringify(change.manifest ? change.manifest(manifest) : manifest)), BACKUP_MANIFEST)
    zip.end()
    await pipeline(zip.outputStream, createWriteStream(target))
  } finally {
    backup.close()
  }
}
