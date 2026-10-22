import { mkdir, mkdtemp, readdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileAssetStore, removeStaleTempFiles } from './asset-store'

describe('file asset store', () => {
  it('stores by content hash, once, and reads it back', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'assets-'))
    const store = createFileAssetStore(root)
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])
    const first = await store.put(bytes, 'jpg')
    const again = await store.put(bytes, 'jpg')
    expect(again).toEqual(first)
    expect(first.path).toMatch(/^covers\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/)
    expect(await store.read(first.path)).toEqual(bytes)
    expect(await readdir(path.join(root, 'covers'))).toHaveLength(1)
    // written atomically: no temp file is left beside the cover
    expect(await readdir(path.join(root, path.dirname(first.path)))).toEqual([path.basename(first.path)])
  })

  it('refuses a path outside its root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'assets-'))
    const store = createFileAssetStore(root)
    await expect(store.read('../../etc/passwd')).rejects.toThrow('outside the asset store')
    await expect(store.read('covers/../../outside.jpg')).rejects.toThrow('outside the asset store')
    await expect(store.read(path.resolve(root, 'covers', 'x.jpg'))).rejects.toThrow('outside the asset store')
    await expect(store.read('/etc/passwd')).rejects.toThrow('outside the asset store')
  })

  it('refuses a link inside the store that leads out of it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'assets-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'))
    await writeFile(path.join(outside, 'secret.txt'), 'secret')
    await mkdir(path.join(root, 'covers'))
    // a junction needs no privileges on Windows; elsewhere the type is ignored
    await symlink(outside, path.join(root, 'covers', 'evil'), 'junction')
    await expect(createFileAssetStore(root).read('covers/evil/secret.txt')).rejects.toThrow('outside the asset store')
  })

  it('removes temp files a crash left behind, once they are an hour old', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'assets-'))
    const dir = path.join(root, 'covers', 'ab')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'abc.jpg'), 'cover')
    await writeFile(path.join(dir, 'abc.jpg.old.tmp'), 'half')
    await writeFile(path.join(dir, 'abc.jpg.new.tmp'), 'in progress')
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000)
    await utimes(path.join(dir, 'abc.jpg.old.tmp'), twoHoursAgo, twoHoursAgo)
    await utimes(path.join(dir, 'abc.jpg'), twoHoursAgo, twoHoursAgo)
    expect(await removeStaleTempFiles(root)).toBe(1)
    expect((await readdir(dir)).sort()).toEqual(['abc.jpg', 'abc.jpg.new.tmp'])
    // a store that has never been written to has nothing to clean
    expect(await removeStaleTempFiles(path.join(root, 'missing'))).toBe(0)
  })
})
