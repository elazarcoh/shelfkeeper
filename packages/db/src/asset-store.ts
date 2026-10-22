import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { exists, syncDir } from './ops/fs-utils'

/** Files on the mounted assets volume (spec §2), named by content hash so a cover shared by many copies is stored once. */
export interface AssetStore {
  put(bytes: Uint8Array, ext: string): Promise<{ path: string; sha256: string }>
  read(relativePath: string): Promise<Uint8Array<ArrayBuffer>>
}

export function createFileAssetStore(root: string): AssetStore {
  const base = path.resolve(root)
  const resolve = (relativePath: string) => {
    if (path.isAbsolute(relativePath)) throw new Error('That path is outside the asset store')
    const full = path.resolve(base, relativePath)
    if (!full.startsWith(base + path.sep)) throw new Error('That path is outside the asset store')
    return full
  }
  return {
    async put(bytes, ext) {
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const relativePath = `covers/${sha256.slice(0, 2)}/${sha256}.${ext}`
      const full = resolve(relativePath)
      // same content already stored (another job, or a cover shared by several copies)
      if (await exists(full)) return { path: relativePath, sha256 }
      const dir = path.dirname(full)
      await mkdir(dir, { recursive: true })
      // written beside the final name, flushed, then renamed: a crash never leaves a truncated cover at `full`
      const temp = `${full}.${randomUUID()}.tmp`
      try {
        const handle = await open(temp, 'wx')
        try {
          await handle.writeFile(bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
        try {
          await rename(temp, full)
        } catch (error) {
          // a concurrent writer renamed the same content first
          if (!(await exists(full))) throw error
        }
        await syncDir(dir)
      } finally {
        await unlink(temp).catch(() => undefined)
      }
      return { path: relativePath, sha256 }
    },
    async read(relativePath) {
      // a link inside the store must not lead out of it either
      const [real, realBase] = await Promise.all([realpath(resolve(relativePath)), realpath(base)])
      if (!real.startsWith(realBase + path.sep)) throw new Error('That path is outside the asset store')
      return new Uint8Array(await readFile(real))
    },
  }
}

const TEMP_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Best effort: deletes the temp files a crash mid-`put` left under covers/. Only ones older than
 * `olderThanMs`, so a write in flight is never touched. Returns how many were removed.
 */
export async function removeStaleTempFiles(root: string, olderThanMs = TEMP_MAX_AGE_MS): Promise<number> {
  const dir = path.join(path.resolve(root), 'covers')
  let entries: string[]
  try {
    entries = await readdir(dir, { recursive: true })
  } catch {
    return 0 // nothing stored yet
  }
  const cutoff = Date.now() - olderThanMs
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.tmp')) continue
    const full = path.join(dir, entry)
    try {
      if ((await stat(full)).mtimeMs >= cutoff) continue
      await unlink(full)
      removed++
    } catch {
      // gone already, or not ours to remove
    }
  }
  return removed
}
