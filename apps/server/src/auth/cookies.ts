export const SESSION_COOKIE = 'mylib_session'

/** `path` is the URL prefix the app is served under ('/' at the root), so the cookie isn't sent to other apps on the same host. */
export function sessionCookie(token: string, maxAgeSec: number, secure: boolean, path = '/'): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export const clearSessionCookie = (secure: boolean, path = '/'): string => sessionCookie('', 0, secure, path)

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) {
      const value = rest.join('=')
      return value === '' ? null : value
    }
  }
  return null
}
