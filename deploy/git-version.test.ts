import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('./git-version.sh', import.meta.url))
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const T = 'c'.repeat(40)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A .git folder holding only what the image build gets: HEAD, refs/ and packed-refs. */
function gitDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mylib-git-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), `${content}\n`)
  }
  return dir
}
function version(dir: string) {
  const run = spawnSync('sh', [SCRIPT, dir], { encoding: 'utf8' })
  return { code: run.status, out: run.stdout.trim() }
}

describe('git-version.sh: the release a checkout is', () => {
  it('reads the tag on the branch Komodo checked out (loose refs, as on the Pi)', () => {
    expect(version(gitDir({ HEAD: 'ref: refs/heads/main', 'refs/heads/main': A, 'refs/tags/v0.4.44': A, 'refs/tags/v0.4.43': B }))).toEqual({ code: 0, out: '0.4.44' })
  })

  it('reads a detached HEAD, packed tags and annotated (peeled) tags', () => {
    const packed = ['# pack-refs with: peeled fully-peeled sorted', `${B} refs/tags/v0.4.1`, `${T} refs/tags/v0.4.2`, `^${A}`, `${A} refs/remotes/origin/main`].join('\n')
    expect(version(gitDir({ HEAD: A, 'packed-refs': packed }))).toEqual({ code: 0, out: '0.4.2' })
    // the branch itself packed too
    expect(version(gitDir({ HEAD: 'ref: refs/heads/main', 'packed-refs': `${A} refs/heads/main\n${A} refs/tags/v1.0.0` }))).toEqual({ code: 0, out: '1.0.0' })
  })

  it('takes the highest of several releases on one commit, by version and not by text', () => {
    expect(version(gitDir({ HEAD: A, 'refs/tags/v0.4.9': A, 'refs/tags/v0.4.10': A, 'refs/tags/not-a-release': A }))).toEqual({ code: 0, out: '0.4.10' })
  })

  it('names an untagged commit by its short sha, and fails with no HEAD at all', () => {
    expect(version(gitDir({ HEAD: A, 'refs/tags/v0.4.1': B }))).toEqual({ code: 0, out: '0.0.0-dev+aaaaaaa' })
    expect(version(gitDir({ 'refs/tags/v0.4.1': B })).code).toBe(1)
    expect(version(gitDir({ HEAD: 'ref: refs/heads/gone' })).code).toBe(1)
  })
})
