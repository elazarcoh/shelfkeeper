/**
 * Serving the app under a URL prefix (BASE_PATH, e.g. /mylibrary) behind a reverse proxy. The prefix is
 * '' when unset, and every route then is exactly what it was before. Requests may arrive with the prefix
 * (the proxy passes the path through) or without it (the proxy strips it, or the container's own
 * `/health` check): the app strips it when present, so its routes stay prefix-free either way.
 */

const SEGMENT = /^[A-Za-z0-9._~-]+$/

/** '' (served at the root) or '/prefix' without a trailing slash. Anything but plain path segments is refused. */
export function normalizeBasePath(value: string): string {
  const trimmed = value.trim()
  const segments = trimmed.split('/').filter((s) => s !== '')
  const plain = !trimmed.startsWith('//') && segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')
  if (!plain) throw new Error(`BASE_PATH must be a plain URL path like /mylibrary, got "${value}"`)
  return segments.length === 0 ? '' : `/${segments.join('/')}`
}

/** The request path the routes see: the prefix removed on a segment boundary, anything else unchanged. */
export function stripBasePath(pathname: string, basePath: string): string {
  if (basePath === '') return pathname
  if (pathname === basePath) return '/'
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname
}
