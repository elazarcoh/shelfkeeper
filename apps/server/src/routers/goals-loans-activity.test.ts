import { describe, expect, it } from 'vitest'
import { useServerHarness } from '../testing/harness'

const book = (title: string) => ({ title, authors: ['Someone'], editions: [{ format: 'physical' as const }] })

describe('goals, loans and activity routers', () => {
  const h = useServerHarness()

  it('creates and deletes goals, scoped to the owner', async () => {
    const { api } = await h.asNewUser()
    const goal = await api.goals.create({ periodStart: '2026-01-01', periodEnd: '2026-12-31', metric: 'books', target: 12 })
    expect((await api.goals.mine())[0]).toMatchObject({ target: 12, total: 0, progress: 0 })

    const other = await h.asNewUser()
    await expect(other.api.goals.delete({ goalId: goal })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await api.goals.delete({ goalId: goal })
    expect(await api.goals.mine()).toEqual([])
  })

  it('lends and returns a physical edition; every member sees the open loans list', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: book('A') })
    const editionId = (await api.catalog.get({ workId })).editions[0]?.id ?? ''

    const loanId = await api.loans.create({ editionId, borrowerUserId: null, borrowerName: 'Dana', lentOn: '2026-01-01', dueOn: null })
    expect((await api.loans.forEdition({ editionId }))[0]).toMatchObject({ id: loanId, returnedOn: null })
    expect((await api.loans.open()).map((l) => l.borrowerName)).toEqual(['Dana'])

    const other = await h.asNewUser()
    expect((await other.api.loans.open()).map((l) => l.id)).toEqual([loanId])
    await api.loans.return({ loanId, on: '2026-01-05' })
    expect((await api.loans.forEdition({ editionId }))[0]?.returnedOn).toBe('2026-01-05')
    expect(await other.api.loans.open()).toEqual([])
    await expect(api.loans.return({ loanId, on: '2026-01-06' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it("shows another sharing user's rating in the activity feed", async () => {
    const a = await h.asNewUser()
    const { workId } = await a.api.catalog.create({ work: book('A') })
    await a.api.tracking.setRating({ workId, rating: 5 })

    const b = await h.asNewUser()
    expect((await b.api.activity.feed()).map((i) => i.kind)).toEqual(['rated'])
  })

  it('lists series entries and a continuation once the first book is read', async () => {
    const { api } = await h.asNewUser()
    const a = (
      await api.catalog.create({ work: { ...book('A'), series: [{ name: 'Mistborn', position: 1 }] } })
    ).workId
    const b = (
      await api.catalog.create({ work: { ...book('B'), series: [{ name: 'Mistborn', position: 2 }] } })
    ).workId
    expect(await api.series.continuations()).toEqual([])
    await api.tracking.setStatus({ workId: a, status: 'read' })
    const seriesId = (await api.catalog.get({ workId: a })).series[0]?.id ?? ''
    expect((await api.series.entries({ seriesId })).map((e) => e.title)).toEqual(['A', 'B'])
    expect((await api.series.continuationForWork({ workId: a })).map((c) => c.nextWorkId)).toEqual([b])
    expect((await api.series.continuations()).map((c) => c.nextWorkId)).toEqual([b])

    await api.series.setContinuationHidden({ seriesId, hidden: true })
    expect(await api.series.hiddenContinuations()).toEqual([seriesId])
    expect(await api.series.continuations()).toEqual([])
    await api.series.setContinuationHidden({ seriesId, hidden: false })
    expect((await api.series.continuations()).map((c) => c.nextWorkId)).toEqual([b])
  })
})
