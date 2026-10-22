import { describe, expect, it, vi } from 'vitest'
import { COVER_PNG } from '@mylib/connectors/testing'
import { userHiddenWorks } from '@mylib/db'
import { seedCover, seedWork } from '@mylib/db/testing'
import { createApp } from './app'
import { useServerHarness } from './testing/harness'

describe('GET /media/:id', () => {
  const h = useServerHarness()

  async function withCover() {
    const { workId, editionIds } = await seedWork(h.db, { title: 'The Final Empire', formats: ['audiobook'] })
    const stored = await h.deps().assets.put(COVER_PNG, 'png')
    // server code may not import drizzle-orm (eslint boundary), so the db test factory sets the cover
    const assetId = await seedCover(h.db, editionIds[0] ?? '', { ...stored, mime: 'image/png' })
    return { workId, assetId, sha256: stored.sha256 }
  }

  it('serves the image to a signed-in user who can see the book', async () => {
    const { assetId, sha256 } = await withCover()
    const { cookie } = await h.signedInCookie()
    const res = await createApp(h.deps()).request(`/media/${assetId}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(res.headers.get('etag')).toBe(`"${sha256}"`)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(COVER_PNG)
  })

  it('answers 401 signed out and 404 for a hidden book or an unknown id', async () => {
    const { workId, assetId } = await withCover()
    const app = createApp(h.deps())
    expect((await app.request(`/media/${assetId}`)).status).toBe(401)
    const { cookie, user } = await h.signedInCookie()
    await h.db.insert(userHiddenWorks).values({ userId: user.id, workId })
    expect((await app.request(`/media/${assetId}`, { headers: { cookie } })).status).toBe(404)
    expect((await app.request('/media/not-a-uuid', { headers: { cookie } })).status).toBe(404)
  })

  it('answers 404 for a well-formed id nothing uses', async () => {
    const { cookie } = await h.signedInCookie()
    const res = await createApp(h.deps()).request('/media/11111111-1111-4111-8111-111111111111', { headers: { cookie } })
    expect(res.status).toBe(404)
  })

  it('answers 401 for an expired session', async () => {
    const { assetId } = await withCover()
    const { cookie } = await h.signedInCookie('member', { expiresAt: new Date(Date.now() - 1000) })
    const res = await createApp(h.deps()).request(`/media/${assetId}`, { headers: { cookie } })
    expect(res.status).toBe(401)
  })

  it('serves the same asset to a second user who can also see the book', async () => {
    const { assetId } = await withCover()
    const { cookie: cookieA } = await h.signedInCookie()
    const { cookie: cookieB } = await h.signedInCookie()
    const app = createApp(h.deps())
    expect((await app.request(`/media/${assetId}`, { headers: { cookie: cookieA } })).status).toBe(200)
    expect((await app.request(`/media/${assetId}`, { headers: { cookie: cookieB } })).status).toBe(200)
  })

  it('answers 404 when the asset row points at a file that is no longer on disk (ENOENT)', async () => {
    const { editionIds } = await seedWork(h.db, { title: 'Missing File', formats: ['physical'] })
    const assetId = await seedCover(h.db, editionIds[0] ?? '', { path: 'covers/00/missing.png', sha256: 'deadbeef', mime: 'image/png' })
    const { cookie } = await h.signedInCookie()
    const res = await createApp(h.deps()).request(`/media/${assetId}`, { headers: { cookie } })
    expect(res.status).toBe(404)
  })

  it('answers 500 without leaking a path when the store fails to read for a reason other than "missing"', async () => {
    const { assetId } = await withCover()
    const { cookie } = await h.signedInCookie()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failing = { ...h.deps().assets, read: () => Promise.reject(Object.assign(new Error("EACCES: permission denied, open '/secret/covers/x.png'"), { code: 'EACCES' })) }
    const res = await createApp({ ...h.deps(), assets: failing }).request(`/media/${assetId}`, { headers: { cookie } })
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).toBe('')
    expect(spy).toHaveBeenCalledWith('[media] read failed', { assetId, code: 'EACCES' })
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/\/secret/)
    spy.mockRestore()
  })

  it('answers 304 when If-None-Match matches the stored hash, after auth and visibility checks still apply', async () => {
    const { workId, assetId, sha256 } = await withCover()
    const app = createApp(h.deps())
    // no cookie: still 401, never a bare 304 for a signed-out request
    expect((await app.request(`/media/${assetId}`, { headers: { 'if-none-match': `"${sha256}"` } })).status).toBe(401)
    const { cookie, user } = await h.signedInCookie()
    // hidden: still 404, an ETag never reveals a hidden book either
    await h.db.insert(userHiddenWorks).values({ userId: user.id, workId })
    expect((await app.request(`/media/${assetId}`, { headers: { cookie, 'if-none-match': `"${sha256}"` } })).status).toBe(404)

    const { cookie: visibleCookie } = await h.signedInCookie()
    const match = await app.request(`/media/${assetId}`, { headers: { cookie: visibleCookie, 'if-none-match': `"${sha256}"` } })
    expect(match.status).toBe(304)
    expect((await match.arrayBuffer()).byteLength).toBe(0)
    const stale = await app.request(`/media/${assetId}`, { headers: { cookie: visibleCookie, 'if-none-match': '"stale"' } })
    expect(stale.status).toBe(200)
  })
})
