import { Hono } from 'hono'
import { z } from 'zod'
import { findVisibleAsset, loadUserScope } from '@mylib/db'
import { sessionUserFromCookie } from './auth/session-user'
import type { AppDeps } from './trpc/context'

const AssetId = z.uuid()

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** Covers and uploads, only for signed-in people who can see a book using them (plan deviation 14). */
export function mediaRoutes(deps: AppDeps): Hono {
  const app = new Hono()
  app.get('/media/:id', async (c) => {
    const { user } = await sessionUserFromCookie(deps, c.req.header('cookie') ?? null)
    if (!user) return c.text('Unauthorized', 401)
    const id = AssetId.safeParse(c.req.param('id'))
    if (!id.success) return c.notFound()
    const asset = await findVisibleAsset(deps.db, await loadUserScope(deps.db, user), id.data)
    if (asset === null) return c.notFound()

    const etag = `"${asset.sha256}"`
    const headers = {
      'content-type': asset.mime,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      etag,
    }
    // the sha256 alone tells us whether the client's cached copy is still good; no need to touch the store for that
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers)

    let bytes: Uint8Array<ArrayBuffer>
    try {
      bytes = await deps.assets.read(asset.path)
    } catch (error) {
      const code = errorCode(error)
      // a cover row whose file went missing (deleted from under us) reads the same as "not found"
      if (code === 'ENOENT') return c.notFound()
      // anything else (permissions, IO, a containment violation) is our problem, not a 404 — visible to the operator, without leaking a path
      console.error('[media] read failed', { assetId: id.data, code: code ?? null })
      return c.text('', 500)
    }
    return c.body(bytes, 200, headers)
  })
  return app
}
