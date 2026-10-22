import type { Db, UserRecord } from '@mylib/db'
import { findSessionUser } from '@mylib/db'
import { readCookie, SESSION_COOKIE } from './cookies'
import { sessionIdFromToken } from './session-token'

/**
 * Resolves the signed-in user (and their live session id) from a request's cookie header.
 * Shared by tRPC's context and /media so both apply the exact same session rule.
 */
export async function sessionUserFromCookie(
  deps: { db: Db; now: () => Date },
  cookieHeader: string | null,
): Promise<{ user: UserRecord | null; sessionId: string | null }> {
  const token = readCookie(cookieHeader, SESSION_COOKIE)
  if (token === null) return { user: null, sessionId: null }
  const sessionId = sessionIdFromToken(token)
  const user = await findSessionUser(deps.db, sessionId, deps.now())
  return { user, sessionId: user ? sessionId : null }
}
