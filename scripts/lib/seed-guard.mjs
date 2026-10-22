// Shared by seed-dev-ebooks.mjs and seed-dev-audiobooks.mjs: both only ever READ their `--from`
// source and refuse to write anywhere under it or on drive Z:.
import fs from 'node:fs'
import path from 'node:path'

export function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function isUnsafe(candidate, from) {
  return /^z:/i.test(path.parse(candidate).root) || isInside(candidate, from)
}

/** Lexical guard, checked before the target exists. */
export function assertSafeTarget(target, from) {
  if (isUnsafe(target, from)) {
    console.error(`Refusing to write to ${target}: it is on the media drive or inside the source.`)
    process.exit(1)
  }
}

/**
 * Real-path guard, checked once the target directory exists: a junction under dev-data that points
 * into the media drive resolves to a different real path than its lexical one, so the lexical check
 * above wouldn't catch it. Re-applies the same z:/inside-source rule to the resolved paths.
 */
export function assertSafeRealTarget(target, from) {
  const realTarget = fs.realpathSync(target)
  const realFrom = fs.realpathSync(from)
  if (isUnsafe(realTarget, realFrom)) {
    console.error(`Refusing to write to ${target}: its real path is on the media drive or inside the source.`)
    process.exit(1)
  }
}

/**
 * The same real-path guard for a folder that may not exist yet, checked BEFORE creating it: its
 * nearest existing ancestor must be safe, so `mkdir -p` can't create folders inside the source
 * through a junction (assertSafeRealTarget then re-checks the created folder itself).
 */
export function assertSafeRealAncestor(dir, from) {
  let existing = dir
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing)
  assertSafeRealTarget(existing, from)
}
