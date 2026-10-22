import { describe, expect, it } from 'vitest'
import { createSession, findUserForLogin, setPinHash } from '@mylib/db'
import { SESSION_COOKIE } from '../auth/cookies'
import { hashSecret } from '../auth/password'
import { sessionIdFromToken } from '../auth/session-token'
import { useServerHarness } from '../testing/harness'
import { createContext } from '../trpc/context'

function tokenFrom(headers: Headers): string {
  const cookie = headers.get('set-cookie') ?? ''
  const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(cookie)
  return match?.[1] ?? ''
}

describe('auth router', () => {
  const h = useServerHarness()
  const setupInput = { username: 'Parent', displayName: 'Parent', password: 'long enough pw' }

  it('reports setup state and creates the first admin with a session cookie', async () => {
    const { api, resHeaders } = h.call()
    expect(await api.auth.status()).toEqual({ needsSetup: true, user: null })
    const user = await api.auth.setup(setupInput)
    expect(user).toMatchObject({ username: 'parent', role: 'admin' })
    expect(tokenFrom(resHeaders)).not.toBe('')
    expect((await h.call().api.auth.status()).needsSetup).toBe(false)
    await expect(h.call().api.auth.setup({ ...setupInput, username: 'other' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('logs in with a password and resolves the session from the cookie', async () => {
    await h.call().api.auth.setup(setupInput)
    const { api, resHeaders } = h.call()
    await api.auth.login({ username: 'parent', password: 'long enough pw' })
    const req = new Request('http://x/trpc', { headers: { cookie: `${SESSION_COOKIE}=${tokenFrom(resHeaders)}` } })
    const ctx = await createContext(h.deps(), req, new Headers())
    expect(ctx.user?.username).toBe('parent')
  })

  it('rejects wrong passwords and unknown users the same way', async () => {
    await h.call().api.auth.setup(setupInput)
    await expect(h.call().api.auth.login({ username: 'parent', password: 'nope' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Invalid username or password',
    })
    await expect(h.call().api.auth.login({ username: 'ghost', password: 'nope' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Invalid username or password',
    })
  })

  it('locks a username after 5 failed attempts, even for the right PIN', async () => {
    const { user } = await h.asNewUser()
    await setPinHash(h.db, user.id, await hashSecret('1234'))
    for (let i = 0; i < 5; i++) {
      await expect(h.call().api.auth.loginPin({ username: user.username, pin: '0000' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      })
    }
    await expect(h.call().api.auth.loginPin({ username: user.username, pin: '1234' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })
  })

  it('counts concurrent attempts so parallel guesses cannot bypass the lock', async () => {
    const { user } = await h.asNewUser()
    await setPinHash(h.db, user.id, await hashSecret('1234'))
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => h.call().api.auth.loginPin({ username: user.username, pin: '0000' })),
    )
    const codes = results.map((r) => (r.status === 'rejected' ? (r.reason as { code: string }).code : 'OK'))
    expect(codes.filter((c) => c === 'UNAUTHORIZED')).toHaveLength(5)
    expect(codes.filter((c) => c === 'TOO_MANY_REQUESTS')).toHaveLength(15)
    await expect(h.call().api.auth.loginPin({ username: user.username, pin: '1234' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })
  })

  it('logs in with a PIN only when one is set', async () => {
    const { user } = await h.asNewUser()
    await expect(h.call().api.auth.loginPin({ username: user.username, pin: '1234' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    await setPinHash(h.db, user.id, await hashSecret('1234'))
    await expect(h.call().api.auth.loginPin({ username: user.username, pin: '1234' })).resolves.toMatchObject({
      id: user.id,
    })
  })

  it('ignores expired sessions and clears the cookie on logout', async () => {
    const { user } = await h.asNewUser()
    await createSession(h.db, { id: sessionIdFromToken('old'), userId: user.id, expiresAt: new Date(Date.now() - 1000) })
    const req = new Request('http://x/trpc', { headers: { cookie: `${SESSION_COOKIE}=old` } })
    expect((await createContext(h.deps(), req, new Headers())).user).toBeNull()

    const { api, resHeaders } = h.call(user, 'some-session')
    await api.auth.logout()
    expect(resHeaders.get('set-cookie')).toContain('Max-Age=0')
  })

  it('changes the password after verifying the current one', async () => {
    await h.call().api.auth.setup(setupInput)
    const found = await findUserForLogin(h.db, 'parent')
    const { api } = h.call(found?.user ?? null)
    await expect(api.auth.changePassword({ current: 'wrong', next: 'another long pw' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    await api.auth.changePassword({ current: 'long enough pw', next: 'another long pw' })
    await expect(h.call().api.auth.login({ username: 'parent', password: 'another long pw' })).resolves.toBeDefined()
  })

  it('requires a session for authed procedures', async () => {
    await expect(h.call().api.auth.updateMe({ shareActivity: false })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('saves the title languages and rejects an empty list', async () => {
    const { api } = await h.asNewUser()
    await expect(api.auth.updateMe({ titleLanguages: [] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const saved = await api.auth.updateMe({ titleLanguages: ['Hebrew', 'eng', 'he'] })
    expect(saved.titleLanguages).toEqual(['he', 'en'])
  })
})
