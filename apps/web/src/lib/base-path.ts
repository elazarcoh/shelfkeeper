/**
 * Serving the app under a URL prefix (e.g. http://host/mylibrary/ behind a reverse proxy). The prefix is
 * fixed at build time: `BASE_PATH` becomes Vite's `base` (vite.config.ts), and the bundle reads it back as
 * `import.meta.env.BASE_URL`. Unset, it is "/" and every URL is exactly what it was before.
 */

const SEGMENT = /^[A-Za-z0-9._~-]+$/

/** `BASE_PATH` in Vite's form: "/" or "/prefix/". Anything but plain path segments is refused. */
export function normalizeBase(value: string | undefined): string {
  const segments = (value ?? '').trim().split('/').filter((s) => s !== '')
  for (const s of segments) {
    if (!SEGMENT.test(s) || s === '.' || s === '..') throw new Error(`BASE_PATH must be a plain URL path like /mylibrary, got "${value}"`)
  }
  if ((value ?? '').trim().startsWith('//')) throw new Error(`BASE_PATH must be a plain URL path like /mylibrary, got "${value}"`)
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`
}

/** `base` ("/" or "/prefix/") + a root-absolute path ("/trpc"). */
export function joinBase(base: string, path: string): string {
  return `${base.slice(0, -1)}${path}`
}

/** TanStack Router's `basepath`: "/" or "/prefix". */
export function routerBasepath(base: string): string {
  return base === '/' ? '/' : base.slice(0, -1)
}

/** A root-absolute server path (an API call, a cover, a download) under this build's base. */
export function withBase(path: string): string {
  return joinBase(import.meta.env.BASE_URL, path)
}
