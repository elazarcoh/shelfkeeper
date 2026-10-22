import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { MaintenanceState } from '@mylib/domain'
import { MaintenanceGate, maintenancePage, publicState, readableUtc, safeNext } from './maintenance'

const state: MaintenanceState = { reason: 'restore', message: 'Restoring my-library-0.4.0-20260928T030000Z-manual.zip.', since: '2026-09-28T03:00:00.000Z', backupName: 'my-library-0.4.0-20260928T030000Z-manual.zip' }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function appWith(gate: MaintenanceGate) {
  const app = new Hono()
  app.use('*', gate.middleware())
  let finish: () => void = () => undefined
  app.get('/slow', async (c) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return c.text('done')
  })
  app.get('/fast', (c) => c.text('fast'))
  return { app, finish: () => finish() }
}

describe('MaintenanceGate', () => {
  it('waits for requests in flight before entering, and refuses new ones at once', async () => {
    const gate = new MaintenanceGate()
    const { app, finish } = appWith(gate)
    const slow = app.request('/slow')
    await sleep(20)
    let entered = false
    const entering = gate.enter(state, 5000).then(() => {
      entered = true
    })
    await sleep(50)
    expect(entered).toBe(false)
    expect((await app.request('/fast')).status).toBe(503)
    finish()
    expect(await (await slow).text()).toBe('done')
    await entering
    expect(entered).toBe(true)
    gate.leave()
    expect((await app.request('/fast')).status).toBe(200)
  })

  it('stops waiting after the drain time', async () => {
    const gate = new MaintenanceGate()
    const { app, finish } = appWith(gate)
    const slow = app.request('/slow')
    await sleep(20)
    const started = Date.now()
    await gate.enter(state, 100)
    expect(Date.now() - started).toBeLessThan(1000)
    // Fix round 1: resolve the dangling /slow request instead of leaving it hanging past the test.
    finish()
    await slow
  })

  it('shows "since" as a readable time, never a raw ISO string, and keeps the ISO value for the local-time script', () => {
    expect(readableUtc('2026-10-06T16:05:01.000Z')).toBe('2026-10-06 16:05 UTC')
    expect(readableUtc('not a date')).toBe('not a date')
    const page = maintenancePage({ ...state, since: '2026-10-06T16:05:01.000Z' })
    expect(page).toContain('datetime="2026-10-06T16:05:01.000Z">2026-10-06 16:05 UTC</time>')
  })

  it('escapes the message on the page and only follows local "next" paths', () => {
    expect(maintenancePage({ ...state, message: '<script>alert(1)</script>' })).not.toContain('<script>alert(1)')
    expect(safeNext('/admin/backups')).toBe('/admin/backups')
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('https://evil.example')).toBe('/')
    expect(safeNext(undefined)).toBe('/')
  })

  // Fix round 1 (Ruling R25): open-redirect tricks a naive "does it start with one slash" check
  // misses — a raw or percent-encoded control character, and the backslash-as-slash trick browsers
  // apply for special schemes.
  it('rejects control characters (raw or percent-encoded) and the backslash trick', () => {
    expect(safeNext('/\t/evil.example')).toBe('/')
    expect(safeNext('/\\evil.example')).toBe('/')
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('/%09/evil.example')).toBe('/')
  })

  it('normalizes a same-origin path, keeping its search and hash', () => {
    expect(safeNext('/admin/backups?tab=schedule#top')).toBe('/admin/backups?tab=schedule#top')
  })
})

// Carried ruling R24 (not in the brief's literal test): maintenance detail is only for signed-in
// admins — everyone else gets a generic line, even though `reason` stays visible.
describe('publicState (Ruling R24)', () => {
  it('shows the real message and backup name only to an admin', () => {
    expect(publicState(state, true)).toEqual(state)
    const redacted = publicState(state, false)
    expect(redacted.reason).toBe('restore')
    expect(redacted.since).toBe(state.since)
    expect(redacted.backupName).toBeNull()
    expect(redacted.message).not.toContain('my-library-0.4.0-20260928T030000Z-manual.zip')
    expect(redacted.message.length).toBeGreaterThan(0)
  })
})

describe('MaintenanceGate.middleware with an admin resolver', () => {
  it('passes the real detail through to a caller resolveAdmin approves', async () => {
    const gate = new MaintenanceGate()
    gate.hold(state)
    const app = new Hono()
    app.use('*', gate.middleware((req) => Promise.resolve(req.headers.get('x-admin') === '1')))
    app.all('/trpc/x', (c) => c.text('unreachable'))

    const asAnyone = await app.request('/trpc/x')
    expect(await asAnyone.json()).toMatchObject({ maintenance: { backupName: null } })

    const asAdmin = await app.request('/trpc/x', { headers: { 'x-admin': '1' } })
    expect(await asAdmin.json()).toEqual({ maintenance: state })
  })

  it('fails closed to non-admin when the resolver throws', async () => {
    const gate = new MaintenanceGate()
    gate.hold(state)
    const app = new Hono()
    app.use(
      '*',
      gate.middleware(() => Promise.reject(new Error('db unreachable'))),
    )
    app.all('/trpc/x', (c) => c.text('unreachable'))
    expect(await (await app.request('/trpc/x')).json()).toMatchObject({ maintenance: { backupName: null } })
  })
})

// Fix round 1 minor: every kind of route the app actually serves must be blocked consistently —
// a tRPC mutation (not just a query), /media/*, and a plain static asset path.
describe('MaintenanceGate.middleware blocks every kind of route', () => {
  it('answers JSON for a tRPC POST mutation and for /media/*, and the HTML page for a static asset', async () => {
    const gate = new MaintenanceGate()
    gate.hold(state)
    const app = new Hono()
    app.use('*', gate.middleware())
    app.post('/trpc/auth.logout', (c) => c.text('unreachable'))
    app.get('/media/abc123', (c) => c.text('unreachable'))
    app.get('/assets/app-x.js', (c) => c.text('unreachable'))

    const trpcRes = await app.request('/trpc/auth.logout', { method: 'POST' })
    expect(trpcRes.status).toBe(503)
    expect(trpcRes.headers.get('content-type')).toContain('application/json')

    const mediaRes = await app.request('/media/abc123')
    expect(mediaRes.status).toBe(503)
    expect(mediaRes.headers.get('content-type')).toContain('application/json')

    const staticRes = await app.request('/assets/app-x.js')
    expect(staticRes.status).toBe(503)
    expect(staticRes.headers.get('content-type')).toContain('text/html')
  })

  it('treats the bare "/trpc" path as an API path but not "/trpcx"', async () => {
    const gate = new MaintenanceGate()
    gate.hold(state)
    const app = new Hono()
    app.use('*', gate.middleware())
    app.get('/trpc', (c) => c.text('unreachable'))
    app.get('/trpcx', (c) => c.text('unreachable'))

    expect((await app.request('/trpc')).headers.get('content-type')).toContain('application/json')
    expect((await app.request('/trpcx')).headers.get('content-type')).toContain('text/html')
  })
})
