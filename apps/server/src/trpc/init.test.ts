import { describe, expect, it, vi } from 'vitest'
import { useServerHarness } from '../testing/harness'

const GENERIC = 'Something went wrong. Please try again.'

describe('unexpected failures are sealed in every router (#5)', () => {
  const h = useServerHarness()

  /** A database whose every query fails the way drizzle reports it: the SQL and its parameters in the message. */
  function brokenDb() {
    const failing = new Set(['select', 'selectDistinct', 'insert', 'update', 'delete', 'execute', 'transaction'])
    return new Proxy(h.db, {
      get(target, prop) {
        if (typeof prop === 'string' && failing.has(prop)) {
          return () => {
            throw new Error('Failed query: select "secret_column" from "users" where "email" = $1\nparams: hunter2@example.com')
          }
        }
        const value: unknown = Reflect.get(target, prop, target)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
  }

  it('answers a generic 500 and logs one redacted line, whichever router or middleware failed', async () => {
    const admin = await h.asNewUser('admin')
    const { api } = h.call(admin.user, null, { db: brokenDb() })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const calls: Record<string, () => Promise<unknown>> = {
        'goals.mine': () => api.goals.mine(),
        'sets.mine': () => api.sets.mine(),
        'library.queue': () => api.library.queue(),
        'inbox.count': () => api.inbox.count(),
        'jobs.list': () => api.jobs.list(),
        'activity.feed': () => api.activity.feed(),
      }
      for (const [path, run] of Object.entries(calls)) {
        logged.mockClear()
        const error: unknown = await run().catch((e: unknown) => e)
        expect(error, path).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: GENERIC })
        expect(JSON.stringify({ message: (error as Error).message }), path).not.toMatch(/secret_column|hunter2|Failed query/)
        expect(logged, path).toHaveBeenCalledTimes(1)
        const [line, detail] = logged.mock.calls[0] as [string, string]
        expect(line).toBe(`[trpc] ${path} failed:`)
        expect(detail).toContain('Failed query')
        expect(detail).not.toContain('hunter2')
      }
    } finally {
      logged.mockRestore()
    }
  })

  it('keeps typed errors as they are, unlogged', async () => {
    const member = await h.asNewUser()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(member.api.jobs.list()).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Admins only' })
      await expect(h.call().api.goals.mine()).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Please sign in' })
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})
