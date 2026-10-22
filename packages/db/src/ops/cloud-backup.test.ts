import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupFileName } from '@mylib/domain'
import { CLOUD_STATUS_FILE, cloudCopyBehind, copyToCloud, createResticRunner, readCloudStatus, resticDetail, updateCloudStatus, type ResticResult, type ResticRunner } from './cloud-backup'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mylib-cloud-'))
  dirs.push(dir)
  return dir
}
function zip(dir: string, at: string, content: string): string {
  const name = backupFileName('0.4.0', new Date(at), 'scheduled')
  writeFileSync(path.join(dir, name), content)
  return name
}

const ok = (stdout = ''): ResticResult => ({ code: 0, stdout, stderr: '', timedOut: false })
const fail = (code: number, stderr: string): ResticResult => ({ code, stdout: '', stderr, timedOut: false })
const NOW = () => new Date('2026-10-15T03:05:00Z')

/** A fake restic: answers by subcommand, and records every call. */
function fakeRestic(answers: Partial<Record<string, ResticResult | ((args: readonly string[], onStdout?: (c: Buffer) => void) => ResticResult)>>) {
  const calls: string[][] = []
  const runner: ResticRunner = (args, options) => {
    calls.push([...args])
    const answer = answers[args[0] ?? '']
    if (answer === undefined) return Promise.resolve(ok())
    return Promise.resolve(typeof answer === 'function' ? answer(args, options.onStdout) : answer)
  }
  return { runner, calls }
}

describe('copyToCloud (with a fake restic)', () => {
  it('does nothing while there is no backup', async () => {
    const dir = tempDir()
    const { runner, calls } = fakeRestic({})
    expect(await copyToCloud(dir, runner)).toEqual({ outcome: 'nothing' })
    expect(calls).toEqual([])
  })

  it('records an unreachable cloud as a failure with restic’s own reason, and keeps the last success', async () => {
    const dir = tempDir()
    zip(dir, '2026-10-15T03:00:00Z', 'zip')
    await updateCloudStatus(dir, () => ({ configured: true, lastSuccess: { at: '2026-10-14T03:05:00.000Z', file: 'older.zip', snapshot: 'abc', warning: null }, lastFailure: null }))
    const { runner, calls } = fakeRestic({ cat: fail(1, 'repo listing\nFatal: unable to open config file: dial tcp: lookup s3.example: no such host\n') })
    const result = await copyToCloud(dir, runner, { now: NOW })
    expect(result).toEqual({ outcome: 'failed', error: 'could not reach the cloud repository: Fatal: unable to open config file: dial tcp: lookup s3.example: no such host' })
    expect(calls).toHaveLength(1)
    expect(await readCloudStatus(dir)).toEqual({
      configured: true,
      lastSuccess: { at: '2026-10-14T03:05:00.000Z', file: 'older.zip', snapshot: 'abc', warning: null },
      lastFailure: { at: '2026-10-15T03:05:00.000Z', error: result.outcome === 'failed' ? result.error : '' },
    })
  })

  it('creates the repository the first time', async () => {
    const dir = tempDir()
    zip(dir, '2026-10-15T03:00:00Z', 'zip')
    const { runner, calls } = fakeRestic({ cat: fail(10, 'Fatal: repository does not exist'), backup: ok('') })
    await copyToCloud(dir, runner, { now: NOW })
    expect(calls.map((c) => c[0])).toEqual(['cat', 'init', 'backup'])
  })

  it('fails when the copy read back from the cloud differs from the file', async () => {
    const dir = tempDir()
    const name = zip(dir, '2026-10-15T03:00:00Z', 'the real zip')
    const { runner } = fakeRestic({
      backup: ok('{"message_type":"status"}\n{"message_type":"summary","snapshot_id":"snap1"}\n'),
      ls: ok(`{"message_type":"snapshot"}\n{"type":"file","name":"${name}","path":"/backups/${name}"}\n`),
      dump: (_args, onStdout) => {
        onStdout?.(Buffer.from('something else'))
        return ok()
      },
    })
    expect(await copyToCloud(dir, runner, { now: NOW })).toEqual({ outcome: 'failed', error: `the cloud copy of ${name} does not match the file on disk` })
  })

  it('keeps a verified copy as a success when only pruning fails, with a warning', async () => {
    const dir = tempDir()
    const name = zip(dir, '2026-10-15T03:00:00Z', 'zip')
    const { runner, calls } = fakeRestic({
      backup: ok('{"message_type":"summary","snapshot_id":"snap1"}\n'),
      ls: ok(`{"type":"file","name":"${name}","path":"/backups/${name}"}\n`),
      dump: (_args, onStdout) => {
        onStdout?.(Buffer.from('zip'))
        return ok()
      },
      forget: fail(1, 'Fatal: unable to create lock in backend: repository is already locked'),
    })
    const result = await copyToCloud(dir, runner, { now: NOW })
    expect(result).toEqual({ outcome: 'copied', file: name, snapshot: 'snap1', warning: 'removing old cloud copies failed: Fatal: unable to create lock in backend: repository is already locked' })
    expect(calls.map((c) => c[0])).toEqual(['cat', 'backup', 'ls', 'dump', 'forget', 'check'])
    expect(calls[1]).toEqual(expect.arrayContaining(['--host', 'my-library', '--exclude', '.*']))
    expect(calls[3]).toEqual(['dump', 'snap1', `/backups/${name}`])
    expect(await cloudCopyBehind(dir)).toBe(false)
    zip(dir, '2026-10-16T03:00:00Z', 'newer')
    expect(await cloudCopyBehind(dir)).toBe(true)
  })

  it('says a timeout is no answer, not an empty error', () => {
    expect(resticDetail({ code: null, stdout: '', stderr: '', timedOut: true })).toBe('no answer in time (is the cloud reachable?)')
    expect(resticDetail(fail(1, ''))).toBe('exit code 1')
    const refused = 'Stat(<config/>) returned error, retrying after 1.4s: Stat: Malformed Access Key Id\nStat(<config/>) returned error, retrying after 4.6s: Stat: The key is not valid\n'
    expect(resticDetail({ code: null, stdout: '', stderr: refused, timedOut: true })).toBe('no answer in time: Stat: The key is not valid')
  })
})

function findRestic(): string | null {
  const bin = process.env.RESTIC_BIN ?? 'restic'
  return spawnSync(bin, ['version']).status === 0 ? bin : null
}
const restic = findRestic()

// RESTIC_BIN (or restic on PATH) runs these against a real restic, with a local folder as the repository
describe.skipIf(restic === null)('copyToCloud (with a real restic)', () => {
  it('copies, reads back and keeps copying the backups into an encrypted repository', async () => {
    const dir = tempDir()
    const repo = path.join(tempDir(), 'repo')
    mkdirSync(path.join(dir, 'uploads'))
    writeFileSync(path.join(dir, 'uploads', 'half.zip'), 'an upload in progress')
    writeFileSync(path.join(dir, '.my-library-volume'), '')
    const first = zip(dir, '2026-10-14T03:00:00Z', 'first backup')
    const runner = createResticRunner({ repository: repo, password: 'test password', credentials: {}, bin: restic ?? 'restic' }, dir)

    const one = await copyToCloud(dir, runner, { now: NOW })
    expect(one).toMatchObject({ outcome: 'copied', file: first, warning: null })
    const second = zip(dir, '2026-10-15T03:00:00Z', 'second backup')
    const two = await copyToCloud(dir, runner, { now: NOW })
    expect(two).toMatchObject({ outcome: 'copied', file: second, warning: null })

    const ls = await runner(['ls', '--json', 'latest'], { timeoutMs: 60_000 })
    const names = ls.stdout
      .split('\n')
      .flatMap((l) => {
        try {
          const n = JSON.parse(l) as { type?: string; name?: string }
          return n.type === 'file' ? [n.name] : []
        } catch {
          return []
        }
      })
      .sort()
    // the zips only: not uploads, the volume marker, the status file or restic's own cache
    expect(names).toEqual([first, second].sort())
    expect(readdirSync(dir)).toContain(CLOUD_STATUS_FILE)

    const wrong = createResticRunner({ repository: repo, password: 'not the password', credentials: {}, bin: restic ?? 'restic' }, dir)
    const denied = await copyToCloud(dir, wrong, { now: NOW })
    expect(denied).toMatchObject({ outcome: 'failed' })
    expect(denied.outcome === 'failed' ? denied.error : '').toMatch(/^could not reach the cloud repository: .*(wrong password|no key found)/)
  }, 120_000)
})
