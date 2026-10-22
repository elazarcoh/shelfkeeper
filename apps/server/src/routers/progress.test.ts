import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useServerHarness } from '../testing/harness'

const book = (title: string, pageCount: number | null) => ({ title, authors: ['Someone'], editions: [{ format: 'physical' as const, pageCount }] })

describe('progress router', () => {
  const h = useServerHarness()

  // the server clock is pinned, so the client-"today" check (RP6) is deterministic
  beforeEach(() => {
    h.clock.now = new Date('2026-03-04T12:00:00Z')
  })

  async function readingToday() {
    const owner = await h.asNewUser()
    const { workId } = await owner.api.catalog.create({ work: book('A', 300) })
    const sessionId = (await owner.api.sessions.start({ workId, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })).sessionId
    return { ...owner, workId, sessionId }
  }

  it('adds, lists, updates and removes a point; check-in state and Home see it', async () => {
    const { api, workId, sessionId } = await readingToday()
    const pointId = await api.progress.add({ sessionId, today: '2026-03-04', kind: 'page', value: 120 })
    expect(await api.progress.list({ sessionId })).toEqual([{ id: pointId, sessionId, on: '2026-03-04', kind: 'page', value: 120, fraction: 0.4, editionId: expect.any(String) as string, volume: null }])
    expect((await api.sessions.checkinState({ today: '2026-03-04' })).inProgress[0]?.progress).toMatchObject({ pointCount: 1, latest: { value: 120 } })
    expect(await api.progress.current()).toEqual([{ workId, sessionId, on: '2026-03-04', fraction: 0.4 }])

    await api.progress.update({ pointId, today: '2026-03-04', on: '2026-03-03', kind: 'page', value: 150 })
    expect((await api.progress.list({ sessionId }))[0]).toMatchObject({ on: '2026-03-03', value: 150 })
    await api.progress.remove({ pointId })
    expect(await api.progress.list({ sessionId })).toEqual([])
  })

  it('answers in typed errors: not yours, a bad date, a value out of range, a finished session', async () => {
    const { api, sessionId } = await readingToday()
    const other = await h.asNewUser()
    await expect(other.api.progress.add({ sessionId, today: '2026-03-04', kind: 'page', value: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(api.progress.add({ sessionId, today: '2026-03-04', on: '2026-03-05', kind: 'page', value: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(api.progress.add({ sessionId, today: '2026-03-04', kind: 'page', value: 1.5 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await api.sessions.complete({ sessionId, completion: { outcome: 'finished', finishedOn: '2026-03-04', finishedPrecision: 'day', fractionCompleted: null } })
    await expect(api.progress.add({ sessionId, today: '2026-03-05', kind: 'page', value: 2 })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This read has already ended — refresh to see the latest.',
    })
  })

  it('refuses a page past the end of the 300-page edition as BAD_REQUEST with a plain message, on add and update', async () => {
    const { api, sessionId } = await readingToday()
    const pastEnd = { code: 'BAD_REQUEST', message: 'This edition has 300 pages. If yours has more, update the page count on the book page.' }
    await expect(api.progress.add({ sessionId, today: '2026-03-04', kind: 'page', value: 1200 })).rejects.toMatchObject(pastEnd)
    const pointId = await api.progress.add({ sessionId, today: '2026-03-04', kind: 'page', value: 300 })
    await expect(api.progress.update({ pointId, today: '2026-03-04', on: '2026-03-04', kind: 'page', value: 1200 })).rejects.toMatchObject(pastEnd)
    expect(await api.progress.list({ sessionId })).toMatchObject([{ value: 300, fraction: 1 }])
  })

  it("enforces the server clock: a client's today more than two days off is BAD_REQUEST", async () => {
    const { api, sessionId } = await readingToday()
    const bad = { code: 'BAD_REQUEST', message: "Your device's date looks wrong. Check its date and try again" }
    await expect(api.progress.add({ sessionId, today: '2026-03-07', kind: 'page', value: 1 })).rejects.toMatchObject(bad)
    await expect(api.progress.add({ sessionId, today: '2026-03-02', on: '2026-03-01', kind: 'page', value: 1 })).resolves.toEqual(expect.any(String))
    const pointId = await api.progress.add({ sessionId, today: '2026-03-06', kind: 'page', value: 2 })
    await expect(api.progress.update({ pointId, today: '2026-03-07', on: '2026-03-06', kind: 'page', value: 3 })).rejects.toMatchObject(bad)
    await expect(api.progress.update({ pointId, today: '2026-02-28', on: '2026-03-01', kind: 'page', value: 3 })).rejects.toMatchObject(bad)
  })

  it('maps a wrong kind and a same-day clash to typed errors with plain messages', async () => {
    const { api, sessionId } = await readingToday()
    // the session resolves to the work's printed edition, so progress is a page number
    await expect(api.progress.add({ sessionId, today: '2026-03-04', kind: 'percent', value: 5 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Progress in a printed book is a page number',
    })
    const a = await api.progress.add({ sessionId, today: '2026-03-04', on: '2026-03-02', kind: 'page', value: 10 })
    await api.progress.add({ sessionId, today: '2026-03-04', on: '2026-03-03', kind: 'page', value: 20 })
    await expect(api.progress.update({ pointId: a, today: '2026-03-04', on: '2026-03-03', kind: 'page', value: 15 })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'There is already an update on that day — edit that one instead',
    })
  })

  it('never lets another user list, add to, update or remove a session or point', async () => {
    const { api, sessionId } = await readingToday()
    const pointId = await api.progress.add({ sessionId, today: '2026-03-04', kind: 'page', value: 40 })
    const other = await h.asNewUser()
    await expect(other.api.progress.list({ sessionId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(other.api.progress.add({ sessionId, today: '2026-03-04', kind: 'page', value: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(other.api.progress.update({ pointId, today: '2026-03-04', on: '2026-03-04', kind: 'page', value: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(other.api.progress.remove({ pointId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await other.api.progress.current()).toEqual([])
    // and the owner's point is untouched
    expect(await api.progress.list({ sessionId })).toMatchObject([{ id: pointId, value: 40 }])
  })

  it('answers NOT_FOUND for a missing point', async () => {
    const { api } = await readingToday()
    const missing = '7b0f3c2e-5d4a-4f6b-8a1c-2e9d8f7a6b5c'
    await expect(api.progress.remove({ pointId: missing })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(api.progress.update({ pointId: missing, today: '2026-03-04', on: '2026-03-04', kind: 'page', value: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("a hidden book's progress never appears, and cannot be changed", async () => {
    const admin = await h.asNewUser('admin')
    const kid = await h.asNewUser()
    const { workId } = await admin.api.catalog.create({ work: book('Hidden', 300) })
    const sessionId = (await kid.api.sessions.start({ workId, editionId: null, mode: 'read', startedOn: '2026-03-01', startedPrecision: 'day' })).sessionId
    const pointId = await kid.api.progress.add({ sessionId, today: '2026-03-04', kind: 'page', value: 40 })
    await admin.api.admin.users.hideWork({ userId: kid.user.id, workId })
    expect(await kid.api.progress.current()).toEqual([])
    await expect(kid.api.progress.list({ sessionId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(kid.api.progress.add({ sessionId, today: '2026-03-04', on: '2026-03-03', kind: 'page', value: 50 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(kid.api.progress.update({ pointId, today: '2026-03-04', on: '2026-03-04', kind: 'page', value: 50 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(kid.api.progress.remove({ pointId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('an unexpected failure is a generic 500 that carries no SQL or internal detail', async () => {
    const { user, sessionId } = await readingToday()
    const secret = 'Failed query: insert into "reading_progress" (secret_column) params: hunter2'
    const broken = new Proxy(h.db, {
      get(target, prop) {
        if (prop === 'transaction') return () => Promise.reject(new Error(secret))
        const value: unknown = Reflect.get(target, prop, target)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    const { api } = h.call(user, null, { db: broken })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const pointId = '7b0f3c2e-5d4a-4f6b-8a1c-2e9d8f7a6b5c'
      const calls = {
        add: () => api.progress.add({ sessionId, today: '2026-03-04', kind: 'page', value: 1 }),
        update: () => api.progress.update({ pointId, today: '2026-03-04', on: '2026-03-04', kind: 'page', value: 1 }),
      }
      for (const [name, run] of Object.entries(calls)) {
        logged.mockClear()
        const error: unknown = await run().catch((e: unknown) => e)
        expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong. Please try again.' })
        expect(JSON.stringify({ name: (error as Error).name, message: (error as Error).message })).not.toMatch(/reading_progress|hunter2|Failed query/)
        // the real error is logged server-side once, on one line naming the procedure
        expect(logged).toHaveBeenCalledTimes(1)
        const [line, detail] = logged.mock.calls[0] as [string, string]
        expect(line).toBe(`[trpc] progress.${name} failed:`)
        expect(detail).toContain('Failed query')
        expect(detail).not.toContain('hunter2')
        expect(detail).not.toContain('\n')
      }
    } finally {
      logged.mockRestore()
    }
  })

  it('does not log a typed error', async () => {
    const { api, sessionId } = await readingToday()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // a normal typed error never touches the log
      await expect(api.progress.add({ sessionId, today: '2026-03-04', kind: 'percent', value: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})
