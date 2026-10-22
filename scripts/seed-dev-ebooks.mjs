// Copies a few EPUBs scattered under the media drive into dev-data/ebooks for the dev Calibre,
// Readarr and Chaptarr (spec §2). The source is only ever READ: the script refuses to write anywhere
// under it or on drive Z:, and never modifies, moves or deletes a file there.
//
//   pnpm dev:seed-ebooks -- --from "Z:\" --count 6 --max-mb 30
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeRealAncestor, assertSafeRealTarget, assertSafeTarget, option } from './lib/seed-guard.mjs'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const target = path.join(repoRoot, 'dev-data', 'ebooks')

const from = path.resolve(option('from', 'Z:\\'))
const count = Number(option('count', '6'))
const maxBytes = Number(option('max-mb', '30')) * 1024 * 1024
/** how deep to look; EPUBs are "scattered", but a whole-drive walk has to stop somewhere */
const maxDepth = Number(option('depth', '6'))

assertSafeTarget(target, from)

/** Breadth-first so books from different folders are picked, not 6 from the first author. */
async function findEpubs() {
  const found = []
  let level = [from]
  for (let depth = 0; depth <= maxDepth && level.length > 0 && found.length < count * 20; depth++) {
    const next = []
    for (const dir of level) {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue // unreadable folder (permissions, a system folder): skip it
      }
      for (const entry of entries) {
        const p = path.join(dir, entry.name)
        if (entry.isDirectory() && !entry.name.startsWith('$') && !entry.name.startsWith('.')) next.push(p)
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.epub')) found.push(p)
      }
    }
    level = next
  }
  return found
}

const candidates = await findEpubs()
// spread the picks across the list instead of taking the first few
const step = Math.max(1, Math.floor(candidates.length / Math.max(1, count)))
await mkdir(target, { recursive: true })
assertSafeRealTarget(target, from)
let copied = 0
for (let i = 0; i < candidates.length && copied < count; i += step) {
  const source = candidates[i]
  const { size } = await stat(source)
  if (size > maxBytes) continue
  // Readarr/Chaptarr expect <Author>/<Book>/<file>; the parent folder names are the best guess we have
  const parts = path.relative(from, source).split(path.sep)
  const author = parts.length >= 3 ? parts[parts.length - 3] : 'Unknown Author'
  const book = parts.length >= 2 ? parts[parts.length - 2] : path.basename(source, '.epub')
  const dest = path.join(target, author, book, path.basename(source))
  assertSafeRealAncestor(path.dirname(dest), from)
  await mkdir(path.dirname(dest), { recursive: true })
  // the author/book folders may already exist, one of them a junction into the source: check the real path
  assertSafeRealTarget(path.dirname(dest), from)
  try {
    // COPYFILE_EXCL: never overwrite; the source file is opened read-only by copyFile
    await copyFile(source, dest, 1)
    console.log(`copied ${path.relative(from, source)} (${Math.round(size / 1024)} KB)`)
    copied++
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}
console.log(copied === 0 ? `Nothing copied (${candidates.length} EPUBs found; all over --max-mb?)` : `Done: ${copied} EPUB(s) in ${target}`)
