import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCloudStatus, type ResticResult, type ResticRunner } from '@mylib/db'
import { backupFileName } from '@mylib/domain'
import { CloudCopier } from './cloud-copy'

const dirs: string[] = []
const copiers: CloudCopier[] = []
afterEach(async () => {
  for (const c of copiers.splice(0)) await c.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function backupDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mylib-cloud-copier-'))
  dirs.push(dir)
  return dir
}
function zip(dir: string, at: string): string {
  const name = backupFileName('0.4.0', new Date(at), 'scheduled')
  writeFileSync(path.join(dir, name), name)
  return name
}
const ok = (stdout = ''): ResticResult => ({ code: 0, stdout, stderr: '', timedOut: false })

/** A restic that copies whatever is newest; `gate` holds each backup until released. */
function fakeRestic(dir: string, options: { hold?: boolean } = {}) {
  const backups: string[] = []
  let release: (() => void) | null = null
  const runner: ResticRunner = async (args, { onStdout, signal }) => {
    const [command] = args
    if (command === 'backup') {
      backups.push(`snap${backups.length + 1}`)
      if (options.hold === true) {
        await new Promise<void>((resolve) => {
          release = resolve
          signal?.addEventListener('abort', () => resolve())
        })
        if (signal?.aborted === true) return { code: null, stdout: '', stderr: 'interrupted', timedOut: false }
      }
      return ok(`{"message_type":"summary","snapshot_id":"snap${backups.length}"}\n`)
    }
    if (command === 'ls') {
      const { readdirSync } = await import('node:fs')
      return ok(readdirSync(dir).map((name) => JSON.stringify({ type: 'file', name, path: `/backups/${name}` })).join('\n'))
    }
    if (command === 'dump') {
      onStdout?.(Buffer.from(path.basename(args[2] ?? '')))
      return ok()
    }
    return ok()
  }
  return { runner, backups, release: () => release?.() }
}

describe('CloudCopier (#106)', () => {
  it('only records that no cloud copy is set up', async () => {
    const dir = backupDir()
    zip(dir, '2026-10-15T03:00:00Z')
    const copier = new CloudCopier({ backupDir: dir, restic: null, log: () => undefined })
    copiers.push(copier)
    await copier.start()
    await copier.request()
    expect(await readCloudStatus(dir)).toEqual({ configured: false, lastSuccess: null, lastFailure: null })
  })

  it('copies on start when the cloud is behind, and again after a new backup', async () => {
    const dir = backupDir()
    const first = zip(dir, '2026-10-15T03:00:00Z')
    const restic = fakeRestic(dir)
    const copier = new CloudCopier({ backupDir: dir, restic: restic.runner, log: () => undefined })
    copiers.push(copier)
    await copier.start()
    await vi.waitFor(async () => expect((await readCloudStatus(dir))?.lastSuccess?.file).toBe(first))
    const second = zip(dir, '2026-10-16T03:00:00Z')
    await copier.request()
    expect((await readCloudStatus(dir))?.lastSuccess).toMatchObject({ file: second, snapshot: 'snap2' })
  })

  it('runs once more when asked during a copy, and a stop interrupts a copy without recording a failure', async () => {
    const dir = backupDir()
    zip(dir, '2026-10-15T03:00:00Z')
    const restic = fakeRestic(dir, { hold: true })
    const copier = new CloudCopier({ backupDir: dir, restic: restic.runner, log: () => undefined })
    copiers.push(copier)
    await copier.start()
    await vi.waitFor(() => expect(restic.backups).toHaveLength(1))
    void copier.request()
    void copier.request()
    restic.release()
    await vi.waitFor(() => expect(restic.backups).toHaveLength(2))
    await copier.stop()
    expect(restic.backups).toHaveLength(2)
    expect(await readCloudStatus(dir)).toMatchObject({ configured: true, lastFailure: null, lastSuccess: { snapshot: 'snap1' } })
  })
})
