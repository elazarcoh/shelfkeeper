import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { NotEnoughSpaceError, runBackup, startBackupRun, updateCloudStatus, UPLOADS_DIR, withOpsLock, works } from '@mylib/db'
import { seedWork, zipOf } from '@mylib/db/testing'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app'
import type { RestoreRunner } from '../ops/restore-runner'
import { appRouter } from '../router'
import { useServerHarness } from '../testing/harness'
import { createCallerFactory } from '../trpc/init'

const RETENTION = { scheduled: 7, preUpgrade: 5, preRestore: 5 }

describe('backups and system routers', () => {
  const h = useServerHarness()
  const upload = async (body: Uint8Array, contentType = 'application/zip') => {
    const admin = await h.signedInCookie('admin')
    return createApp(h.deps()).request('/admin/backups/upload', { method: 'POST', headers: { cookie: admin.cookie, 'content-type': contentType }, body })
  }

  it('is for admins only', async () => {
    const { api } = await h.asNewUser('member')
    await expect(api.backups.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(api.system.status()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('queues a manual backup', async () => {
    const { api } = await h.asNewUser('admin')
    await api.backups.runNow()
    expect(h.backupsEnqueued).toEqual([{ kind: 'manual' }])
  })

  it('saves the schedule and retention, and rejects a bad schedule', async () => {
    const { api } = await h.asNewUser('admin')
    await api.backups.updateSettings({ schedule: '30 2 * * *', retention: RETENTION })
    expect(await api.backups.settings()).toMatchObject({ schedule: '30 2 * * *', scheduleIsDefault: false, retention: RETENTION })
    await expect(api.backups.updateSettings({ schedule: 'every night', retention: RETENTION })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('lists and deletes backups, only by name', async () => {
    const { api } = await h.asNewUser('admin')
    const backup = await runBackup(h.ops(), 'manual')
    expect((await api.backups.list()).map((b) => b.name)).toEqual([backup.name])
    await expect(api.backups.delete({ name: `../${backup.name}` })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await api.backups.delete({ name: backup.name })
    expect(await api.backups.list()).toEqual([])
  })

  it('serves a backup download to admins only, as an attachment that is never cached', async () => {
    const backup = await runBackup(h.ops(), 'manual')
    const app = createApp(h.deps())
    const url = `/admin/backups/file/${encodeURIComponent(backup.name)}`
    expect((await app.request(url)).status).toBe(401)
    const member = await h.signedInCookie('member')
    expect((await app.request(url, { headers: { cookie: member.cookie } })).status).toBe(403)
    const admin = await h.signedInCookie('admin')
    const res = await app.request(url, { headers: { cookie: admin.cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${backup.name}"`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.arrayBuffer()).byteLength).toBe(backup.sizeBytes)
    // a traversal attempt doesn't even parse as one of our names
    expect((await app.request('/admin/backups/file/..%2F..%2Fetc%2Fpasswd', { headers: { cookie: admin.cookie } })).status).toBe(404)
    // a well-formed name that simply isn't on disk (deleted, or never existed) answers the same 404, not a crash
    const wellFormedButMissing = 'my-library-0.4.0-test-20260101T000000Z-manual.zip'
    expect((await app.request(`/admin/backups/file/${wellFormedButMissing}`, { headers: { cookie: admin.cookie } })).status).toBe(404)
  })

  it('refuses a form post and an invalid upload, and keeps nothing', async () => {
    expect((await upload(Buffer.from('--x--'), 'multipart/form-data; boundary=x')).status).toBe(415)
    const bogus = await upload(readFileSync(await zipOf({ 'notes.txt': 'hi' })))
    expect(bogus.status).toBe(400)
    expect(await bogus.json()).toEqual({ error: 'The backup contains a file outside the backup layout' })
    expect(readdirSync(path.join(h.ops().backupDir, UPLOADS_DIR))).toEqual([])
  })

  it('accepts application/octet-stream, not only application/zip', async () => {
    const backup = await runBackup(h.ops(), 'manual')
    const res = await upload(readFileSync(path.join(h.ops().backupDir, backup.name)), 'application/octet-stream')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ appVersion: '0.4.0-test', kind: 'manual' })
  })

  it('caps a chunked upload (no content-length) at a small injected size, and leaves no temp file (ruling R26)', async () => {
    const admin = await h.signedInCookie('admin')
    const chunk = Buffer.alloc(64, 1)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 100; i++) controller.enqueue(chunk)
        controller.close()
      },
    })
    const res = await createApp(h.deps(), { maxUploadBytes: 1024 }).request('/admin/backups/upload', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/zip' },
      body,
      duplex: 'half',
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'The upload is larger than this server will accept' })
    expect(readdirSync(path.join(h.ops().backupDir, UPLOADS_DIR))).toEqual([])
  })

  // Fix round 2 (minor): the streaming free-space branch (as opposed to the hard-cap 413 branch, and as
  // opposed to the declared-content-length pre-check, both already covered) — a chunked body (no
  // content-length, so the pre-check is skipped) over an injected tiny free-space figure.
  it('caps a chunked upload against the volume\'s free space, not only the hard byte cap', async () => {
    const admin = await h.signedInCookie('admin')
    const chunk = Buffer.alloc(64, 1)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 100; i++) controller.enqueue(chunk)
        controller.close()
      },
    })
    const res = await createApp(h.deps(), { freeBytes: () => Promise.resolve(2048) }).request('/admin/backups/upload', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/zip' },
      body,
      duplex: 'half',
    })
    expect(res.status).toBe(507)
    expect(await res.json()).toEqual({ error: 'Not enough free space in BACKUP_DIR for this upload' })
    expect(readdirSync(path.join(h.ops().backupDir, UPLOADS_DIR))).toEqual([])
  })

  it('leaves no temp file when the upload stream itself aborts', async () => {
    const admin = await h.signedInCookie('admin')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('partial'))
        controller.error(new Error('client disconnected'))
      },
    })
    const res = await createApp(h.deps()).request('/admin/backups/upload', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/zip' },
      body,
      duplex: 'half',
    })
    expect(res.status).toBe(500)
    expect(readdirSync(path.join(h.ops().backupDir, UPLOADS_DIR))).toEqual([])
  })

  it('maps not enough disk space to 507 on upload validation, with a message that names no path (ruling R26)', async () => {
    const backup = await runBackup(h.ops(), 'manual')
    const admin = await h.signedInCookie('admin')
    const tinyStatfs = () => Promise.resolve({ bavail: 0, bsize: 4096 })
    const res = await createApp(h.deps(), { statfs: tinyStatfs }).request('/admin/backups/upload', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/zip' },
      body: readFileSync(path.join(h.ops().backupDir, backup.name)),
    })
    expect(res.status).toBe(507)
    expect(await res.json()).toEqual({ error: 'Not enough free disk space to process this upload' })
    expect(readdirSync(path.join(h.ops().backupDir, UPLOADS_DIR))).toEqual([])
  })

  it('restores a backup from the list in the background and reports the summary', async () => {
    const { api } = await h.asNewUser('admin')
    await seedWork(h.db, { title: 'Kept' })
    const backup = await runBackup(h.ops(), 'manual')
    await seedWork(h.db, { title: 'Added after the backup' })
    expect(await api.backups.restore({ source: { kind: 'file', name: backup.name }, confirm: 'restore' })).toEqual({ backupName: backup.name })
    await h.restorer().idle()
    expect((await h.db.select({ title: works.title }).from(works)).map((w) => w.title)).toEqual(['Kept'])
    expect(await api.backups.lastRestore()).toMatchObject({ ok: true, summary: { backupName: backup.name, counts: { works: 1 } } })
  })

  it('restores an uploaded backup and deletes the upload afterwards', async () => {
    const { api } = await h.asNewUser('admin')
    const backup = await runBackup(h.ops(), 'manual')
    const res = await upload(readFileSync(path.join(h.ops().backupDir, backup.name)))
    expect(res.status).toBe(200)
    const uploaded = (await res.json()) as { uploadId: string; appVersion: string; kind: string }
    expect(uploaded).toMatchObject({ appVersion: '0.4.0-test', kind: 'manual' })
    // Ruling R10: the admin-facing name is the manifest-derived backup name, never the upload's uuid temp filename.
    const restored = await api.backups.restore({ source: { kind: 'upload', uploadId: uploaded.uploadId }, confirm: 'restore' })
    expect(restored).toEqual({ backupName: backup.name })
    await h.restorer().idle()
    expect(readdirSync(path.join(h.ops().backupDir, UPLOADS_DIR))).toEqual([])
    expect(await api.backups.lastRestore()).toMatchObject({ ok: true, summary: { backupName: backup.name } })
  })

  it('refuses a second restore while one runs', async () => {
    const { api } = await h.asNewUser('admin')
    const backup = await runBackup(h.ops(), 'manual')
    const input = { source: { kind: 'file' as const, name: backup.name }, confirm: 'restore' as const }
    const results = await Promise.allSettled([api.backups.restore(input), api.backups.restore(input)])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } })
    await h.restorer().idle()
  })

  it('starts a restore despite a stale "running" backup row: only the backup lock itself means busy (final fix 6)', async () => {
    const { api } = await h.asNewUser('admin')
    const backup = await runBackup(h.ops(), 'manual')
    await startBackupRun(h.db, 'manual') // left "running" by a process that died
    expect(await api.backups.restore({ source: { kind: 'file', name: backup.name }, confirm: 'restore' })).toEqual({ backupName: backup.name })
    await h.restorer().idle()
    expect(await api.backups.lastRestore()).toMatchObject({ ok: true })
  })

  it('refuses a restore up front while another process holds the backup lock (final fix 6)', async () => {
    const { api } = await h.asNewUser('admin')
    const backup = await runBackup(h.ops(), 'manual')
    await withOpsLock(h.ops().databaseUrl, 'backup', async () => {
      await expect(api.backups.restore({ source: { kind: 'file', name: backup.name }, confirm: 'restore' })).rejects.toMatchObject({ code: 'CONFLICT' })
    })
    await h.restorer().idle()
    expect(await api.backups.lastRestore()).toMatchObject({ ok: false, error: expect.stringContaining('backup') as unknown })
  })

  it('asks the admin to type "restore"', async () => {
    const { api } = await h.asNewUser('admin')
    const backup = await runBackup(h.ops(), 'manual')
    // @ts-expect-error the confirmation word is part of the input type
    await expect(api.backups.restore({ source: { kind: 'file', name: backup.name }, confirm: 'yes' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  // Ruling R7: the admin must always see why a restore didn't happen, even when it never got as far as
  // running — here, a second restore is refused by RestoreRunner.start() itself (not inside restoreBackup).
  // Fix round 1: made deterministic with a hook that holds the winner mid-restore (so the second call is
  // guaranteed to see it already `busy`), instead of racing two concurrent calls and hoping one loses.
  it('records the refused restore as a failed last_restore outcome, not just a rejected call', async () => {
    const { api } = await h.asNewUser('admin')
    const backup = await runBackup(h.ops(), 'manual')
    const input = { source: { kind: 'file' as const, name: backup.name }, confirm: 'restore' as const }
    let releaseWinner: () => void = () => undefined
    const winnerReached = new Promise<void>((resolveReached) => {
      h.restoreHooks.current = {
        afterPgRestore: () =>
          new Promise<void>((resolveHook) => {
            releaseWinner = resolveHook
            resolveReached()
          }),
      }
    })
    const winner = api.backups.restore(input)
    // Fix round 2 (minor): if the winner's restore fails outright, or somehow finishes without ever
    // calling the hook, `winnerReached` would otherwise never resolve and the test would just hang until
    // vitest's own timeout. Racing it against the winner's own outcome — `winner` settling fast is the
    // normal case; a rejection surfaces immediately, and once it resolves, `idle()` reflects this run and
    // only resolves once it's actually done — means a wrong turn here fails fast, with the real reason,
    // instead of a bare "test timed out".
    await Promise.race([winnerReached, winner.then(() => h.restorer().idle())])
    await expect(api.backups.restore(input)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await api.backups.lastRestore()).toMatchObject({ ok: false, backupName: backup.name })
    releaseWinner()
    await winner
    await h.restorer().idle()
  })

  // Fix round 1 (ruling R26): NotEnoughSpaceError is a dedicated class, mapped explicitly here (a fake
  // restorer stands in for RestoreRunner so the mapping is tested without starving real disk space).
  it('maps not enough disk space to PRECONDITION_FAILED', async () => {
    const { user } = await h.asNewUser('admin')
    const backup = await runBackup(h.ops(), 'manual')
    const fakeRestorer = { start: () => Promise.reject(new NotEnoughSpaceError('not enough free disk space (test)')), idle: () => Promise.resolve() }
    const api = createCallerFactory(appRouter)({ ...h.deps(), user, sessionId: null, resHeaders: new Headers(), restorer: fakeRestorer as unknown as RestoreRunner })
    await expect(api.backups.restore({ source: { kind: 'file', name: backup.name }, confirm: 'restore' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  // Carried requirement: the restore is triggered from an HTTP request the maintenance gate counts as
  // in-flight. If the runner entered maintenance before that request finished, the gate would wait out
  // its whole drain window (30 s) before the response could complete. Going through the real HTTP app
  // (not the in-process caller, which never touches the gate's in-flight counter) proves it doesn't.
  it('answers the restore request promptly, well before the maintenance drain window could elapse', async () => {
    const deps = h.deps()
    const backup = await runBackup(h.ops(), 'manual')
    const app = createApp(deps)
    const admin = await h.signedInCookie('admin')
    const started = Date.now()
    const res = await app.request('/trpc/backups.restore', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ json: { source: { kind: 'file', name: backup.name }, confirm: 'restore' } }),
    })
    expect(res.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(5000)
    await h.restorer().idle()
  })

  it('reports the version, the last backup, free space and the 48-hour flag', async () => {
    const { api } = await h.asNewUser('admin')
    expect(await api.system.status()).toMatchObject({ version: '0.4.0-test', lastBackup: null, backupStale: true, backupRunning: false, lowDisk: false })
    const backup = await runBackup(h.ops(), 'scheduled')
    const status = await api.system.status()
    expect(status).toMatchObject({ lastBackup: { name: backup.name, kind: 'scheduled', verified: true }, backupStale: false, worker: { job: 'backup' } })
    expect(status.freeBytes.backups).toBeGreaterThan(0)
    expect(status.cloud).toBeNull()
  })

  it('reports the cloud copy the worker recorded (#106)', async () => {
    const { api } = await h.asNewUser('admin')
    await updateCloudStatus(h.ops().backupDir, () => ({ configured: false, lastSuccess: null, lastFailure: null }))
    expect((await api.system.status()).cloud).toEqual({ configured: false, lastSuccess: null, lastFailure: null, stale: false })
    const recent = new Date(Date.now() - 3_600_000).toISOString()
    await updateCloudStatus(h.ops().backupDir, () => ({
      configured: true,
      lastSuccess: { at: '2026-01-01T03:00:00.000Z', file: 'a.zip', snapshot: 's', warning: null },
      lastFailure: { at: recent, error: 'could not reach the cloud repository: Fatal: no such host' },
    }))
    expect((await api.system.status()).cloud).toEqual({
      configured: true,
      lastSuccess: { at: new Date('2026-01-01T03:00:00.000Z'), file: 'a.zip', warning: null },
      lastFailure: { at: new Date(recent), error: 'could not reach the cloud repository: Fatal: no such host' },
      stale: true,
    })
  })
})
