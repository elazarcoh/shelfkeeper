import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { sessionCookie } from './auth/cookies'
import { normalizeBasePath, stripBasePath } from './base-path'
import { loadConfig } from './config'
import { maintenancePage } from './maintenance'
import { useServerHarness } from './testing/harness'

describe('BASE_PATH', () => {
  it('normalizes to "" (served at the root) or "/prefix" without a trailing slash', () => {
    expect(loadConfig({}).basePath).toBe('')
    expect(normalizeBasePath('')).toBe('')
    expect(normalizeBasePath('/')).toBe('')
    expect(normalizeBasePath('/mylibrary')).toBe('/mylibrary')
    expect(normalizeBasePath('mylibrary/')).toBe('/mylibrary')
    expect(normalizeBasePath(' /apps/my-library/ ')).toBe('/apps/my-library')
    expect(loadConfig({ BASE_PATH: '/mylibrary/' }).basePath).toBe('/mylibrary')
  })

  it('refuses a prefix that is not plain path segments', () => {
    for (const bad of ['//evil.example', '/a b', '/a?b', '/../x', 'http://x']) expect(() => normalizeBasePath(bad), bad).toThrow()
    expect(() => loadConfig({ BASE_PATH: '/a?b' })).toThrow()
  })

  it('strips the prefix only on a segment boundary, and leaves other paths alone', () => {
    expect(stripBasePath('/mylibrary', '/mylibrary')).toBe('/')
    expect(stripBasePath('/mylibrary/', '/mylibrary')).toBe('/')
    expect(stripBasePath('/mylibrary/trpc/auth.status', '/mylibrary')).toBe('/trpc/auth.status')
    expect(stripBasePath('/mylibraryx/a', '/mylibrary')).toBe('/mylibraryx/a')
    expect(stripBasePath('/health', '/mylibrary')).toBe('/health')
    expect(stripBasePath('/mylibrary/x', '')).toBe('/mylibrary/x')
  })

  it('scopes the session cookie to the prefix', () => {
    expect(sessionCookie('t', 60, false)).toContain('Path=/;')
    expect(sessionCookie('t', 60, false, '/mylibrary')).toContain('Path=/mylibrary;')
  })

  it('points the maintenance page at the prefixed status endpoint and home', () => {
    const state = { reason: 'restore' as const, message: 'm', since: '2026-09-28T03:00:00.000Z', backupName: null }
    const root = maintenancePage(state)
    expect(root).toContain(`fetch('/maintenance/status'`)
    expect(root).toContain(`location.pathname==='/maintenance'?'/'`)
    const sub = maintenancePage(state, '/mylibrary')
    expect(sub).toContain(`fetch('/mylibrary/maintenance/status'`)
    expect(sub).toContain(`location.pathname==='/mylibrary/maintenance'?'/mylibrary/'`)
  })
})

describe('http app under a base path', () => {
  const h = useServerHarness()
  let webDist = ''

  beforeAll(async () => {
    webDist = await mkdtemp(path.join(tmpdir(), 'mylib-web-'))
    await mkdir(path.join(webDist, 'assets'))
    await writeFile(path.join(webDist, 'index.html'), '<!doctype html><title>index</title>')
    await writeFile(path.join(webDist, 'assets', 'app.js'), 'console.log(1)')
  })
  afterAll(async () => {
    await rm(webDist, { recursive: true, force: true })
  })

  const app = () => {
    const deps = h.deps()
    return { deps, app: createApp({ ...deps, config: { ...deps.config, basePath: '/mylibrary', webDist } }) }
  }

  it('answers every route under the prefix (proxy keeps it) and without it (proxy strips it; the container health check)', async () => {
    const { app: a } = app()
    expect((await a.request('/mylibrary/health')).status).toBe(200)
    expect((await a.request('/health')).status).toBe(200)
    const status = await a.request('/mylibrary/trpc/auth.status')
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ result: { data: { json: { needsSetup: true } } } })
    expect((await a.request('/trpc/auth.status')).status).toBe(200)
  })

  it('serves the web app and its assets under the prefix', async () => {
    const { app: a } = app()
    expect(await (await a.request('/mylibrary/assets/app.js')).text()).toBe('console.log(1)')
    expect(await (await a.request('/mylibrary/books/123')).text()).toContain('<title>index</title>')
    expect(await (await a.request('/mylibrary/')).text()).toContain('<title>index</title>')
    expect(await (await a.request('/mylibrary')).text()).toContain('<title>index</title>')
  })

  it('sets the session cookie on the prefix', async () => {
    const { app: a } = app()
    const res = await a.request('/mylibrary/trpc/auth.setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { username: 'parent', displayName: 'Parent', password: 'long enough pw' } }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Path=/mylibrary;')
  })

  it('keeps maintenance redirects and the maintenance page under the prefix', async () => {
    const { deps, app: a } = app()
    const back = await a.request('/mylibrary/maintenance')
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/mylibrary/')
    const next = await a.request('/mylibrary/maintenance?next=%2Fmylibrary%2Fadmin%2Fbackups')
    expect(next.headers.get('location')).toBe('/mylibrary/admin/backups')

    deps.gate.hold({ reason: 'restore', message: 'Restoring a backup.', since: '2026-09-28T03:00:00.000Z', backupName: null })
    const page = await a.request('/mylibrary/library')
    expect(page.status).toBe(503)
    expect(await page.text()).toContain(`fetch('/mylibrary/maintenance/status'`)
    expect((await a.request('/mylibrary/maintenance/status')).status).toBe(200)
    const api = await a.request('/mylibrary/trpc/auth.status')
    expect(api.status).toBe(503)
    expect(api.headers.get('content-type')).toContain('application/json')
  })
})
