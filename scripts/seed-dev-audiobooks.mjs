// Copies a few audiobook folders into dev-data/audiobooks for the dev Audiobookshelf (spec §2).
// The source library is only ever READ. The script refuses to write anywhere under it (or on drive Z:).
//
//   pnpm dev:seed-audiobooks -- --from "Z:\Media\Audiobooks" --count 3 --max-mb 600
import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeRealAncestor, assertSafeRealTarget, assertSafeTarget, option } from './lib/seed-guard.mjs'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const target = path.join(repoRoot, 'dev-data', 'audiobooks')

const from = path.resolve(option('from', 'Z:\\Media\\Audiobooks'))
const count = Number(option('count', '3'))
const maxBytes = Number(option('max-mb', '600')) * 1024 * 1024

assertSafeTarget(target, from)

async function dirSize(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    total += entry.isDirectory() ? await dirSize(p) : (await stat(p)).size
    if (total > maxBytes) return total // early out: too big anyway
  }
  return total
}

async function subdirs(dir) {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

await mkdir(target, { recursive: true })
assertSafeRealTarget(target, from)

// Audiobookshelf layout: <Author>/<Book> (or <Author>/<Series>/<Book>, copied whole).
let copied = 0
for (const author of await subdirs(from)) {
  for (const book of await subdirs(path.join(from, author))) {
    if (copied >= count) break
    const source = path.join(from, author, book)
    const size = await dirSize(source)
    if (size > maxBytes) continue
    const dest = path.join(target, author, book)
    assertSafeRealAncestor(path.dirname(dest), from)
    await mkdir(path.dirname(dest), { recursive: true })
    // the author folder may already exist as a junction into the source: check the real path before copying
    assertSafeRealTarget(path.dirname(dest), from)
    await cp(source, dest, { recursive: true, force: false, errorOnExist: false })
    console.log(`copied ${author}/${book} (${Math.round(size / 1024 / 1024)} MB)`)
    copied++
  }
  if (copied >= count) break
}
console.log(copied === 0 ? 'Nothing copied (all candidates exceeded --max-mb?)' : `Done: ${copied} book folder(s) in ${target}`)
