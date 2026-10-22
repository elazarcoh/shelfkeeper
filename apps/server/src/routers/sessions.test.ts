import { describe, expect, it } from 'vitest'
import { useServerHarness } from '../testing/harness'

const book = (title: string) => ({ title, authors: ['Someone'], editions: [{ format: 'physical' as const }] })

describe('sessions router', () => {
  const h = useServerHarness()

  it('starts and completes a session through the API, updating status', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: book('A') })
    const sessionId = (await api.sessions.start({
      workId,
      editionId: null,
      mode: 'read',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
    })).sessionId
    expect((await api.catalog.get({ workId })).me.status).toBe('reading')
    await api.sessions.complete({
      sessionId,
      completion: { outcome: 'finished', finishedOn: '2026-01-02', finishedPrecision: 'day', fractionCompleted: null },
    })
    expect((await api.catalog.get({ workId })).me.status).toBe('read')
  })

  it('marks a book read long ago in one call: status read, finished on an unknown date, and this year\'s stats unchanged', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: book('Long ago') })
    const year = { from: '2026-01-01', to: '2026-12-31' }
    const before = await api.stats.summary(year)

    const sessionId = await api.sessions.markFinished({ workId, mode: 'read', finishedOn: '2026-10-07', finishedPrecision: 'unknown' })

    expect((await api.catalog.get({ workId })).me.status).toBe('read')
    expect(await api.sessions.listForWork({ workId })).toMatchObject([
      { id: sessionId, outcome: 'finished', finishedPrecision: 'unknown', startedPrecision: 'unknown' },
    ])
    expect(await api.stats.summary(year)).toEqual(before)
    expect(await api.stats.books(year)).toEqual([])
    expect(await api.stats.daily(year)).toEqual([])
  })

  it('marks a book read with its rating in one call, and refuses a finish in the future', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: book('Rated') })
    await api.sessions.markFinished({ workId, mode: 'read', finishedOn: '2019-01-01', finishedPrecision: 'year', rating: 3.5 })
    expect((await api.catalog.get({ workId })).me.rating).toBe(3.5)
    await expect(api.sessions.markFinished({ workId, mode: 'read', finishedOn: '2999-01-01', finishedPrecision: 'year' })).rejects.toMatchObject({
      message: 'That date is in the future',
    })
  })

  it('refuses a mark-as-read with a bad precision or a missing book', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: book('A') })
    await expect(
      api.sessions.markFinished({ workId, mode: 'read', finishedOn: '2019-01-01', finishedPrecision: 'decade' as 'year' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      api.sessions.markFinished({ workId: '6f0e8d7c-1b2a-4c3d-9e8f-7a6b5c4d3e2f', mode: 'read', finishedOn: '2019-01-01', finishedPrecision: 'year' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("blocks another user from completing someone else's session", async () => {
    const owner = await h.asNewUser()
    const { workId } = await owner.api.catalog.create({ work: book('A') })
    const sessionId = (await owner.api.sessions.start({
      workId,
      editionId: null,
      mode: 'read',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
    })).sessionId
    const { api: otherApi } = await h.asNewUser()
    await expect(
      otherApi.sessions.complete({
        sessionId,
        completion: { outcome: 'finished', finishedOn: '2026-01-02', finishedPrecision: 'day', fractionCompleted: null },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reports check-in as due, then not due after dismissal, and honors a snooze', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: book('A') })
    const sessionId = (await api.sessions.start({
      workId,
      editionId: null,
      mode: 'listen',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
    })).sessionId
    expect((await api.sessions.checkinState({ today: '2026-03-01' })).dueToday).toBe(true)
    await api.sessions.dismissCheckin({ today: '2026-03-01' })
    expect((await api.sessions.checkinState({ today: '2026-03-01' })).dueToday).toBe(false)
    expect((await api.sessions.checkinState({ today: '2026-03-01' })).inProgress.map((s) => s.id)).toEqual([sessionId])

    await api.sessions.snooze({ sessionId, until: '2026-03-01' })
    expect((await api.sessions.checkinState({ today: '2026-03-01' })).inProgress).toEqual([])
    expect((await api.sessions.checkinState({ today: '2026-03-02' })).inProgress.map((s) => s.id)).toEqual([sessionId])
    expect((await api.sessions.checkinState({ today: '2026-03-02' })).dueToday).toBe(true)
  })

  it('a "Still going" leaves the book out of the next automatic check-in (#45)', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: book('A') })
    const sessionId = (await api.sessions.start({ workId, editionId: null, mode: 'read', startedOn: '2026-01-01', startedPrecision: 'day' })).sessionId
    await api.sessions.checkedIn({ sessionId })
    expect(await api.sessions.checkinState({ today: '2026-03-01' })).toMatchObject({ dueToday: false, recentlyCheckedIn: [sessionId] })
    expect((await api.sessions.checkinState({ today: '2026-03-01' })).inProgress.map((s) => s.id)).toEqual([sessionId])
    const { api: other } = await h.asNewUser()
    await expect(other.sessions.checkedIn({ sessionId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('deletes only your own session, and a hidden or missing one answers NOT_FOUND', async () => {
    const owner = await h.asNewUser()
    const { workId } = await owner.api.catalog.create({ work: book('A') })
    const sessionId = (await owner.api.sessions.start({
      workId,
      editionId: null,
      mode: 'read',
      startedOn: '2026-01-01',
      startedPrecision: 'day',
    })).sessionId
    const other = await h.asNewUser()
    await expect(other.api.sessions.delete({ sessionId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await owner.api.sessions.delete({ sessionId })
    expect(await owner.api.sessions.listForWork({ workId })).toEqual([])
    await expect(owner.api.sessions.delete({ sessionId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects completing with a finish date before the start date', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: book('A') })
    const sessionId = (await api.sessions.start({ workId, editionId: null, mode: 'read', startedOn: '2026-03-10', startedPrecision: 'day' })).sessionId
    await expect(
      api.sessions.complete({
        sessionId,
        completion: { outcome: 'finished', finishedOn: '2026-03-01', finishedPrecision: 'day', fractionCompleted: null },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
