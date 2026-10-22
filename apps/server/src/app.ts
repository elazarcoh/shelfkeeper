import { serveStatic } from '@hono/node-server/serve-static'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { pingDatabase } from '@mylib/db'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getPath } from 'hono/utils/url'
import { sessionUserFromCookie } from './auth/session-user'
import { backupRoutes, type BackupRoutesOptions } from './backup-routes'
import { stripBasePath } from './base-path'
import { maintenancePage, publicState, safeNext } from './maintenance'
import { mediaRoutes } from './media'
import { appRouter } from './router'
import { createContext, type AppDeps } from './trpc/context'

/** Largest tRPC batch accepted in one HTTP request. */
export const MAX_BATCH_SIZE = 20

/** Largest tRPC request body accepted; a CSV import is the largest legitimate request (≤ 2000 rows). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/** How long the R24 admin lookup may take before it's treated as "not admin" (same idea as `pingDatabase`'s timeout: the database is very possibly the start-up problem). */
const ADMIN_LOOKUP_TIMEOUT_MS = 1000

/**
 * Ruling R24: only a signed-in admin sees maintenance detail (it may embed internal paths or error
 * text). A lookup failure or a slow database — the database itself may be the start-up problem —
 * fails closed to "not admin" rather than throwing through, or hanging, the maintenance response.
 */
async function isAdminRequest(deps: AppDeps, req: Request): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { user } = await Promise.race([
      sessionUserFromCookie(deps, req.headers.get('cookie')),
      new Promise<{ user: null; sessionId: null }>((resolve) => {
        timer = setTimeout(() => resolve({ user: null, sessionId: null }), ADMIN_LOOKUP_TIMEOUT_MS)
      }),
    ])
    return user?.role === 'admin'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function createApp(deps: AppDeps, options: BackupRoutesOptions = {}): Hono {
  // BASE_PATH: routes below never see the prefix (a request may arrive with or without it, base-path.ts)
  const basePath = deps.config.basePath
  const app = new Hono({ getPath: (req) => stripBasePath(getPath(req), basePath) })

  // maintenance first: every route below is behind it, except /health and /maintenance*
  app.use('*', deps.gate.middleware((req) => isAdminRequest(deps, req), basePath))

  app.get('/health', async (c) => {
    const db = (await pingDatabase(deps.db)) ? 'ok' : 'unreachable'
    const state = deps.gate.state
    const ok = db === 'ok' && state === null
    const maintenance = state === null ? null : publicState(state, await isAdminRequest(deps, c.req.raw))
    return c.json({ ok, version: deps.config.appVersion, db, maintenance }, ok ? 200 : 503)
  })
  app.get('/maintenance/status', async (c) => {
    const state = deps.gate.state
    const maintenance = state === null ? null : publicState(state, await isAdminRequest(deps, c.req.raw))
    return c.json({ maintenance }, 200, { 'cache-control': 'no-store' })
  })
  app.get('/maintenance', async (c) => {
    const state = deps.gate.state
    if (state !== null) return c.html(maintenancePage(publicState(state, await isAdminRequest(deps, c.req.raw)), basePath), 503, { 'cache-control': 'no-store' })
    return c.redirect(safeNext(c.req.query('next'), `${basePath}/`), 302)
  })

  app.route('/', mediaRoutes(deps))
  app.route('/', backupRoutes(deps, options))

  // a CSV import is the largest legitimate request (≤ 2000 rows); anything bigger is refused before parsing
  app.use('/trpc/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.text('Payload Too Large', 413) }))

  // CSRF guard: browsers cannot send cross-site application/json POSTs without a CORS preflight.
  app.use('/trpc/*', async (c, next) => {
    if (c.req.method === 'POST' && !(c.req.header('content-type') ?? '').startsWith('application/json')) {
      return c.text('Unsupported Media Type', 415)
    }
    await next()
  })

  app.all('/trpc/*', (c) =>
    fetchRequestHandler({
      // tRPC reads the procedure from the raw URL, which still carries the prefix if the proxy kept it
      endpoint: `${new URL(c.req.url).pathname.startsWith(`${basePath}/`) ? basePath : ''}/trpc`,
      req: c.req.raw,
      router: appRouter,
      // Bounds work per request; keep in sync with the web client's httpBatchLink maxItems.
      maxBatchSize: MAX_BATCH_SIZE,
      createContext: ({ req, resHeaders }) => createContext(deps, req, resHeaders),
    }),
  )

  const webDist = deps.config.webDist
  if (webDist !== null) {
    app.use('/*', serveStatic({ root: webDist }))
    app.get('*', serveStatic({ path: `${webDist}/index.html` }))
  }
  return app
}
