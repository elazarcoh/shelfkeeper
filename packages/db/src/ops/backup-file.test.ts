import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, readdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { sql } from 'drizzle-orm'
import yauzl from 'yauzl'
import yazl from 'yazl'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BackupManifest } from '@mylib/domain'
import { createScratchDatabase, rewriteBackup, tempDir, testPgTools, zipOf, type ScratchDatabase } from '../testing'
import { BackupInvalidError, copyBackupAssets, isSafeEntryName, openBackup, readBackupManifest, verifyBackupZip, writeBackupZip } from './backup-file'
import { createPgTools, PgToolError } from './pg-tools'

const tools = testPgTools()
const KEY = 'ZGV2LW9ubHktc2VjcmV0LWtleS1kby1ub3QtdXNlISE='
const head: Omit<BackupManifest, 'files'> = {
  format: 1,
  appVersion: '0.4.0',
  lastMigration: { tag: '0007_backups_system_state', when: 1 },
  createdAt: '2026-09-28T03:00:00.000Z',
  kind: 'manual',
}
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

describe('backup file', () => {
  let db: ScratchDatabase
  let dumpFile: string
  beforeAll(async () => {
    db = await createScratchDatabase()
    dumpFile = path.join(tempDir('dump'), 'db.dump')
    await tools.dump(db.url, dumpFile)
  })
  afterAll(async () => {
    await db.drop()
  })

  async function makeBackup(): Promise<{ zip: string; assetsRoot: string }> {
    const assetsRoot = tempDir('assets')
    mkdirSync(path.join(assetsRoot, 'covers', 'aa'), { recursive: true })
    mkdirSync(path.join(assetsRoot, 'covers', 'bb'), { recursive: true })
    writeFileSync(path.join(assetsRoot, 'covers', 'aa', 'one.png'), 'one')
    writeFileSync(path.join(assetsRoot, 'covers', 'bb', 'two.png'), 'two')
    const zip = path.join(tempDir('zip'), 'backup.zip')
    await writeBackupZip(zip, { dumpFile, assetsRoot, assetPaths: ['covers/aa/one.png', 'covers/bb/two.png'], secretKey: KEY, manifest: head })
    return { zip, assetsRoot }
  }

  it('writes a zip whose manifest lists every file with its size and sha256, and verifies it', async () => {
    const { zip } = await makeBackup()
    const verified = await verifyBackupZip(zip, tools, tempDir('work'))
    expect(verified.manifest.files.map((f) => f.path)).toEqual(['db.dump', 'assets/covers/aa/one.png', 'assets/covers/bb/two.png', 'secret.key'])
    expect(verified.manifest.files.find((f) => f.path === 'assets/covers/aa/one.png')).toEqual({ path: 'assets/covers/aa/one.png', size: 3, sha256: sha('one') })
    expect(verified.secretKey).toBe(KEY)
    expect(readFileSync(verified.dumpFile).equals(readFileSync(dumpFile))).toBe(true)
    expect(await readBackupManifest(zip)).toEqual(verified.manifest)
  })

  it("copies the backup's covers into an asset folder, keeping files already there", async () => {
    const { zip } = await makeBackup()
    const target = tempDir('restored-assets')
    mkdirSync(path.join(target, 'covers', 'aa'), { recursive: true })
    writeFileSync(path.join(target, 'covers', 'aa', 'one.png'), 'one')
    expect(await copyBackupAssets(zip, target)).toBe(1)
    expect(readFileSync(path.join(target, 'covers', 'bb', 'two.png'), 'utf8')).toBe('two')
  })

  it('refuses a truncated zip', async () => {
    const { zip } = await makeBackup()
    truncateSync(zip, Math.floor(readFileSync(zip).length / 2))
    await expect(verifyBackupZip(zip, tools, tempDir('work'))).rejects.toBeInstanceOf(BackupInvalidError)
  })

  it('refuses a zip whose file does not match its checksum', async () => {
    const { zip } = await makeBackup()
    const tampered = path.join(tempDir('zip'), 'tampered.zip')
    await rewriteBackup(zip, tampered, { replace: { 'assets/covers/aa/one.png': Buffer.from('ONE') }, keepChecksums: true })
    await expect(verifyBackupZip(tampered, tools, tempDir('work'))).rejects.toThrow('does not match its checksum')
  })

  it('refuses a zip with an entry outside the backup layout or a traversal path', async () => {
    for (const bad of ['assets/../secret.key', 'assets/covers/../../x', '../db.dump', 'assets\\covers\\x.png', 'C:/x', '/etc/passwd', 'assets/.prev-1/x.png', 'notes.txt', 'assets/']) {
      expect(isSafeEntryName(bad), bad).toBe(false)
    }
    for (const good of ['db.dump', 'secret.key', 'manifest.json', 'assets/covers/ab/abc.png']) expect(isSafeEntryName(good), good).toBe(true)

    const { zip } = await makeBackup()
    const extra = path.join(tempDir('zip'), 'extra.zip')
    await rewriteBackup(zip, extra, { add: { 'notes.txt': Buffer.from('hi') } })
    const target = tempDir('untouched')
    await expect(copyBackupAssets(extra, target)).rejects.toThrow('outside the backup layout')
    expect(readdirSync(target)).toEqual([])
  })

  it('refuses a zip with no manifest, an unknown format, or a file the manifest does not list', async () => {
    await expect(openBackup(await zipOf({ 'db.dump': 'x', 'secret.key': KEY }))).rejects.toThrow('no manifest')
    const { zip } = await makeBackup()
    const future = path.join(tempDir('zip'), 'future.zip')
    await rewriteBackup(zip, future, { manifest: (m) => ({ ...m, format: 2 }) })
    await expect(openBackup(future)).rejects.toThrow('format 2')
    await expect(openBackup(await zipOf({ 'manifest.json': JSON.stringify({ ...head, files: [] }), 'db.dump': 'x' }))).rejects.toThrow('does not list')
  })

  it('refuses a dump pg_restore cannot read', async () => {
    const { zip } = await makeBackup()
    const garbage = path.join(tempDir('zip'), 'garbage.zip')
    await rewriteBackup(zip, garbage, { replace: { 'db.dump': Buffer.from('not a dump') } })
    await expect(verifyBackupZip(garbage, tools, tempDir('work'))).rejects.toThrow('database dump in the backup cannot be read')
  })

  // R3 (controller ruling): verifyBackupZip must map ONLY a genuine "pg_restore ran and rejected the
  // dump" PgToolError to the damaged-dump verdict. A tool that can't even be spawned (missing binary,
  // bad PATH, ...) must surface as itself -- a missing pg_restore must never look like a corrupt backup.
  it('rejects with the underlying PgToolError, not a damaged-dump verdict, when pg_restore cannot be spawned', async () => {
    const { zip } = await makeBackup()
    const bareTools = createPgTools({ prefix: ['mylib-no-such-binary'] })
    let caught: unknown
    try {
      await verifyBackupZip(zip, bareTools, tempDir('work'))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PgToolError)
    expect(caught).not.toBeInstanceOf(BackupInvalidError)
    expect((caught as Error).message).toMatch(/could not be started/)
  })

  // R21 (Critical, review round 1): pg_restore --list stops reading stdin once it has the TOC, which
  // for a multi-MB dump closes the pipe long before our write side is done -- exercised here through
  // the real docker-exec'd pg_restore/pg_dump, not a fake tool, to prove the fix holds end to end.
  it(
    'verifies a real multi-MB dump end to end, and reports a damaged dump when it is truncated inside its header/TOC (not a broken pipe)',
    async () => {
      const big = await createScratchDatabase('empty')
      try {
        await big.db.execute(sql`create table big (v text)`)
        // high-entropy text (md5 hex, not a repeated character) so the dump doesn't compress away to nothing
        await big.db.execute(sql`insert into big (v) select md5(gs::text) from generate_series(1, 300000) gs`)
        const bigDump = path.join(tempDir('dump'), 'big.dump')
        await tools.dump(big.url, bigDump)
        expect(readFileSync(bigDump).length).toBeGreaterThan(1024 * 1024)

        const zip = path.join(tempDir('zip'), 'big-backup.zip')
        await writeBackupZip(zip, { dumpFile: bigDump, assetsRoot: tempDir('empty-assets'), assetPaths: [], secretKey: KEY, manifest: head })
        const verified = await verifyBackupZip(zip, tools, tempDir('work'))
        expect(readFileSync(verified.dumpFile).equals(readFileSync(bigDump))).toBe(true)

        // `pg_restore --list` only reads the archive header and its (compact) table of contents, up
        // front, never the bulk COPY data that follows -- empirically, on this dump, that boundary is
        // well under 2 KB. Truncating anywhere past it (e.g. halfway through the file) leaves `--list`
        // no worse off, so the truncation has to land inside the header/TOC itself to be caught by it.
        const original = readFileSync(bigDump)
        const truncatedDump = path.join(tempDir('dump'), 'truncated.dump')
        writeFileSync(truncatedDump, original.subarray(0, 1024))
        const truncatedZip = path.join(tempDir('zip'), 'truncated-backup.zip')
        await writeBackupZip(truncatedZip, { dumpFile: truncatedDump, assetsRoot: tempDir('empty-assets2'), assetPaths: [], secretKey: KEY, manifest: head })
        let caught: unknown
        try {
          await verifyBackupZip(truncatedZip, tools, tempDir('work2'))
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(BackupInvalidError)
        expect((caught as Error).message).toContain('database dump in the backup cannot be read')
      } finally {
        await big.drop()
      }
    },
    60_000,
  )

  // Important review finding: zip-bomb guards.
  it('refuses a zip with more entries than the configured cap', async () => {
    const zip = await zipOf({ a: '1', b: '2', c: '3', d: '4' })
    await expect(openBackup(zip, { maxEntries: 2 })).rejects.toThrow('too many entries')
  })

  it("refuses a manifest whose declared size does not match the zip entry's actual size", async () => {
    const manifest = {
      ...head,
      files: [
        { path: 'db.dump', size: 999, sha256: sha(Buffer.from('x')) },
        { path: 'secret.key', size: Buffer.byteLength(KEY), sha256: sha(Buffer.from(KEY)) },
      ],
    }
    const zip = await zipOf({ 'manifest.json': JSON.stringify(manifest), 'db.dump': 'x', 'secret.key': KEY })
    await expect(openBackup(zip)).rejects.toThrow('does not match its zip entries')
  })

  it('refuses a manifest that lists the same path twice', async () => {
    const manifest = {
      ...head,
      files: [
        { path: 'db.dump', size: 1, sha256: sha(Buffer.from('x')) },
        { path: 'db.dump', size: 1, sha256: sha(Buffer.from('x')) },
        { path: 'secret.key', size: Buffer.byteLength(KEY), sha256: sha(Buffer.from(KEY)) },
      ],
    }
    const zip = await zipOf({ 'manifest.json': JSON.stringify(manifest), 'db.dump': 'x', 'secret.key': KEY })
    await expect(openBackup(zip)).rejects.toThrow('manifest lists a file twice')
  })

  it('refuses to extract when the target filesystem does not have enough free space', async () => {
    const { zip } = await makeBackup()
    const statfs = () => Promise.resolve({ bavail: 0, bsize: 4096 })
    await expect(verifyBackupZip(zip, tools, tempDir('work'), { statfs })).rejects.toThrow('Not enough free disk space')
    const target = tempDir('restored-assets-full')
    await expect(copyBackupAssets(zip, target, { statfs })).rejects.toThrow('Not enough free disk space')
  })

  // Round 2: copyBackupAssets used to statfs the asset store before ever creating it, so a fresh
  // install (no asset store yet) failed with ENOENT instead of extracting the covers.
  it('copies covers into an asset root that does not exist yet', async () => {
    const { zip } = await makeBackup()
    const target = path.join(tempDir('restored-assets-parent'), 'assets-root-not-created-yet')
    expect(await copyBackupAssets(zip, target)).toBe(2)
    expect(readFileSync(path.join(target, 'covers', 'aa', 'one.png'), 'utf8')).toBe('one')
    expect(readFileSync(path.join(target, 'covers', 'bb', 'two.png'), 'utf8')).toBe('two')
  })

  // Round 2, item 3: the 64 GiB total-size cap, exercised cheaply via an injected small cap.
  it('refuses a backup whose manifest declares more total bytes than the configured cap', async () => {
    const { zip } = await makeBackup()
    await expect(openBackup(zip, { maxTotalBytes: 5 })).rejects.toThrow('larger than this server will extract')
  })

  // Round 2, item 3: an extract-time checksum mismatch (as opposed to a size mismatch caught before
  // hashing, or the general re-verify of non-dump files) must delete whatever it half-wrote.
  it('refuses a dump whose checksum does not match at extraction time, and removes the leftover file', async () => {
    const { zip } = await makeBackup()
    // same length as the real dump (so the size check passes) but different content, so the mismatch
    // is caught specifically at extraction time, not by the earlier size-mismatch check
    const flipped = Buffer.from(readFileSync(dumpFile))
    const middle = Math.floor(flipped.length / 2)
    flipped[middle] = ((flipped[middle] ?? 0) + 1) % 256
    const tampered = path.join(tempDir('zip'), 'tampered-dump.zip')
    await rewriteBackup(zip, tampered, { replace: { 'db.dump': flipped }, keepChecksums: true })
    const work = tempDir('work')
    await expect(verifyBackupZip(tampered, tools, work)).rejects.toThrow('does not match its checksum')
    expect(readdirSync(work)).toEqual([])
  })

  it('refuses a cover whose checksum does not match at extraction time, and removes the leftover temp file', async () => {
    const { zip } = await makeBackup()
    const tampered = path.join(tempDir('zip'), 'tampered-cover.zip')
    await rewriteBackup(zip, tampered, { replace: { 'assets/covers/aa/one.png': Buffer.from('ONE') }, keepChecksums: true })
    const target = tempDir('restored-assets-mismatch')
    await expect(copyBackupAssets(tampered, target)).rejects.toThrow('does not match its checksum')
    const coversAaDir = path.join(target, 'covers', 'aa')
    expect(readdirSync(coversAaDir)).toEqual([])
  })

  // Round 2, item 1: a directory entry must only be accepted under assets/ -- slicing off the first 7
  // characters of e.g. "secret.key/" without first checking the "assets/" prefix used to make it look
  // like a safe relative path ("key"), wrongly letting that directory entry through as if it were assets/*.
  it('refuses a directory entry for a name outside assets/, but accepts one under assets/', async () => {
    const manifest = {
      ...head,
      files: [
        { path: 'db.dump', size: 1, sha256: sha(Buffer.from('x')) },
        { path: 'secret.key', size: Buffer.byteLength(KEY), sha256: sha(Buffer.from(KEY)) },
      ],
    }
    async function buildZip(dirName: string): Promise<string> {
      const zip = new yazl.ZipFile()
      zip.addBuffer(Buffer.from('x'), 'db.dump')
      zip.addBuffer(Buffer.from(KEY), 'secret.key')
      zip.addEmptyDirectory(dirName)
      zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json')
      zip.end()
      const file = path.join(tempDir('zip'), `dir-${dirName.replace(/[^a-z0-9]/gi, '_')}.zip`)
      await pipeline(zip.outputStream, createWriteStream(file))
      return file
    }
    for (const bad of ['secret.key', 'manifest.json', 'x']) {
      await expect(openBackup(await buildZip(bad)), bad).rejects.toThrow('outside the backup layout')
    }
    await expect(openBackup(await buildZip('assets/covers'))).resolves.toBeDefined()
  })

  // Minor review findings.
  it('refuses a symlink entry, before extracting anything', async () => {
    const linkTarget = Buffer.from('../../etc/passwd')
    const manifest = {
      ...head,
      files: [
        { path: 'db.dump', size: 1, sha256: sha(Buffer.from('x')) },
        { path: 'assets/covers/aa/link.png', size: linkTarget.length, sha256: sha(linkTarget) },
        { path: 'secret.key', size: Buffer.byteLength(KEY), sha256: sha(Buffer.from(KEY)) },
      ],
    }
    const zip = new yazl.ZipFile()
    zip.addBuffer(Buffer.from('x'), 'db.dump')
    zip.addBuffer(linkTarget, 'assets/covers/aa/link.png', { mode: 0o120777 })
    zip.addBuffer(Buffer.from(KEY), 'secret.key')
    zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json')
    zip.end()
    const file = path.join(tempDir('zip'), 'symlink.zip')
    await pipeline(zip.outputStream, createWriteStream(file))
    const target = tempDir('symlink-target')
    await expect(copyBackupAssets(file, target)).rejects.toThrow('symlink')
    expect(readdirSync(target)).toEqual([])
  })

  it('rethrows a local I/O error opening the zip file itself, rather than a damaged-backup verdict', async () => {
    const missing = path.join(tempDir('zip'), 'missing.zip')
    let caught: unknown
    try {
      await openBackup(missing)
    } catch (error) {
      caught = error
    }
    expect(caught).not.toBeInstanceOf(BackupInvalidError)
    expect((caught as NodeJS.ErrnoException).code).toBe('ENOENT')
  })

  // Round 2, item 4: a local I/O error reading the central directory or an entry (disk failure,
  // permissions, ...) must surface as itself, not as "The backup file is damaged" -- consistent with
  // openZip. A real disk fault isn't reproducible portably in a test, so these inject a deterministic
  // one by spying on yauzl's own prototype methods, exercising exactly the three call sites named in
  // the review: readEntries' error handler, openEntry (used by both `read()` and `verify()`), and
  // verify()'s own catch block.
  function injectedError(code: string): NodeJS.ErrnoException {
    const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException
    error.code = code
    return error
  }

  it('rethrows a local I/O error reading the central directory, rather than a damaged-backup verdict', async () => {
    const { zip } = await makeBackup()
    const spy = vi.spyOn(yauzl.ZipFile.prototype, 'readEntry').mockImplementation(function (this: yauzl.ZipFile) {
      this.emit('error', injectedError('EACCES'))
    })
    try {
      let caught: unknown
      try {
        await openBackup(zip)
      } catch (error) {
        caught = error
      }
      expect(caught).not.toBeInstanceOf(BackupInvalidError)
      expect((caught as NodeJS.ErrnoException).code).toBe('EACCES')
    } finally {
      spy.mockRestore()
    }
  })

  it('rethrows a local I/O error reading an entry during extraction (openEntry via read()), rather than a damaged-backup verdict', async () => {
    const { zip } = await makeBackup()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- rebound explicitly via .call() below
    const original = yauzl.ZipFile.prototype.openReadStream
    const spy = vi
      .spyOn(yauzl.ZipFile.prototype, 'openReadStream')
      .mockImplementation(function (this: yauzl.ZipFile, entry: yauzl.Entry, callback: (err: Error | null, stream: Readable) => void) {
        if (entry.fileName === 'db.dump') {
          callback(injectedError('EIO'), undefined as unknown as Readable)
          return
        }
        original.call(this, entry, callback)
      })
    try {
      let caught: unknown
      try {
        await verifyBackupZip(zip, tools, tempDir('work'))
      } catch (error) {
        caught = error
      }
      expect(caught).not.toBeInstanceOf(BackupInvalidError)
      expect((caught as NodeJS.ErrnoException).code).toBe('EIO')
    } finally {
      spy.mockRestore()
    }
  })

  it("rethrows a local I/O error reading an entry during verify(), rather than a damaged-backup verdict", async () => {
    const { zip } = await makeBackup()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- rebound explicitly via .call() below
    const original = yauzl.ZipFile.prototype.openReadStream
    const spy = vi
      .spyOn(yauzl.ZipFile.prototype, 'openReadStream')
      .mockImplementation(function (this: yauzl.ZipFile, entry: yauzl.Entry, callback: (err: Error | null, stream: Readable) => void) {
        if (entry.fileName === 'secret.key') {
          callback(injectedError('EACCES'), undefined as unknown as Readable)
          return
        }
        original.call(this, entry, callback)
      })
    try {
      let caught: unknown
      try {
        await verifyBackupZip(zip, tools, tempDir('work'))
      } catch (error) {
        caught = error
      }
      expect(caught).not.toBeInstanceOf(BackupInvalidError)
      expect((caught as NodeJS.ErrnoException).code).toBe('EACCES')
    } finally {
      spy.mockRestore()
    }
  })
})
