import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { SESSION_COOKIE } from './auth/cookies'
import { useServerHarness } from './testing/harness'

describe('http app', () => {
  const h = useServerHarness()

  it('answers health checks with the version, the database and the maintenance state', async () => {
    const res = await createApp(h.deps()).request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: '0.4.0-test', db: 'ok', maintenance: null })
  })

  it('answers 503 with the maintenance page for everything but health and status', async () => {
    const deps = h.deps()
    const state = { reason: 'restore' as const, message: 'Restoring a backup.', since: '2026-09-28T03:00:00.000Z', backupName: 'x.zip' }
    deps.gate.hold(state)
    const app = createApp(deps)

    const page = await app.request('/library')
    expect(page.status).toBe(503)
    expect(page.headers.get('x-mylib-maintenance')).toBe('1')
    // Ruling R24: an anonymous request never sees the raw message or the backup name.
    const pageText = await page.text()
    expect(pageText).not.toContain('Restoring a backup.')
    expect(pageText).not.toContain('x.zip')

    const api = await app.request('/trpc/auth.status')
    expect(api.status).toBe(503)
    expect(await api.json()).toEqual({ maintenance: { reason: 'restore', message: expect.any(String) as string, since: state.since, backupName: null } })

    const health = await app.request('/health')
    expect(health.status).toBe(503)
    expect(await health.json()).toMatchObject({ ok: false, db: 'ok', maintenance: { reason: 'restore', backupName: null } })

    expect(await (await app.request('/maintenance/status')).json()).toEqual({ maintenance: { reason: 'restore', message: expect.any(String) as string, since: state.since, backupName: null } })
    expect((await app.request('/maintenance?next=/admin/backups')).status).toBe(503)

    // A signed-in admin sees the real detail on every one of the same endpoints.
    const { cookie } = await h.signedInCookie('admin')
    const adminHeaders = { cookie }
    expect(await (await app.request('/library', { headers: adminHeaders })).text()).toContain('Restoring a backup.')
    expect(await (await app.request('/trpc/auth.status', { headers: adminHeaders })).json()).toEqual({ maintenance: state })
    expect(await (await app.request('/health', { headers: adminHeaders })).json()).toMatchObject({ maintenance: state })
    expect(await (await app.request('/maintenance/status', { headers: adminHeaders })).json()).toEqual({ maintenance: state })
    expect(await (await app.request('/maintenance', { headers: adminHeaders })).text()).toContain('Restoring a backup.')

    deps.gate.leave()
    const back = await app.request('/maintenance?next=/admin/backups')
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/admin/backups')
  })

  // Fix round 1 minor (Ruling R24): a slow admin lookup must not hang the maintenance response —
  // it races against a 1 s timeout and treats a timeout as "not admin", the same way pingDatabase does.
  it('treats a slow admin lookup as not-admin rather than hanging', async () => {
    const deps = h.deps()
    const hangingDb = {
      select: () => ({ from: () => ({ innerJoin: () => ({ where: () => new Promise(() => undefined) }) }) }),
    } as unknown as typeof deps.db
    const state = { reason: 'restore' as const, message: 'Restoring a backup.', since: '2026-09-28T03:00:00.000Z', backupName: 'x.zip' }
    deps.gate.hold(state)
    const app = createApp({ ...deps, db: hangingDb })
    const res = await app.request('/maintenance/status', { headers: { cookie: `${SESSION_COOKIE}=whatever-looks-like-a-token` } })
    expect(await res.json()).toEqual({ maintenance: { reason: 'restore', message: expect.any(String) as string, since: state.since, backupName: null } })
  }, 3000)

  it('rejects non-JSON tRPC posts (CSRF guard)', async () => {
    const res = await createApp(h.deps()).request('/trpc/auth.logout', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(res.status).toBe(415)
  })

  it('runs setup over HTTP and sets an HttpOnly session cookie', async () => {
    const app = createApp(h.deps())
    const res = await app.request('/trpc/auth.setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { username: 'parent', displayName: 'Parent', password: 'long enough pw' } }),
    })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    const status = await app.request('/trpc/auth.status', { headers: { cookie: cookie.split(';')[0] ?? '' } })
    const body = (await status.json()) as { result: { data: { json: { user: { username: string } | null } } } }
    expect(body.result.data.json.user?.username).toBe('parent')
  })

  it('rejects oversized tRPC batches', async () => {
    const app = createApp(h.deps())
    const paths = Array.from({ length: 21 }, () => 'auth.status').join(',')
    const input = encodeURIComponent(JSON.stringify({}))
    expect((await app.request(`/trpc/${paths}?batch=1&input=${input}`)).status).toBe(400)
    const ok = Array.from({ length: 20 }, () => 'auth.status').join(',')
    expect((await app.request(`/trpc/${ok}?batch=1&input=${input}`)).status).toBe(200)
  })

  it('refuses a tRPC request body over the size limit', async () => {
    const res = await createApp(h.deps()).request('/trpc/csv.import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(8 * 1024 * 1024 + 1) })
    expect(res.status).toBe(413)
  })
})
