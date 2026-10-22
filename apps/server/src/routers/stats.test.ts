import { describe, expect, it } from 'vitest'
import { useServerHarness } from '../testing/harness'

const book = (title: string) => ({ title, authors: ['Someone'], editions: [{ format: 'physical' as const }] })

describe('stats router', () => {
  const h = useServerHarness()

  it('returns a summary, daily stats and a day drill-down after finishing a book', async () => {
    const { api } = await h.asNewUser()
    const { workId } = await api.catalog.create({ work: book('A') })
    const sessionId = (await api.sessions.start({
      workId,
      editionId: null,
      mode: 'read',
      startedOn: '2026-03-01',
      startedPrecision: 'day',
    })).sessionId
    await api.sessions.complete({
      sessionId,
      completion: { outcome: 'finished', finishedOn: '2026-03-01', finishedPrecision: 'day', fractionCompleted: null },
    })

    const summary = await api.stats.summary({ from: '2026-01-01', to: '2026-12-31' })
    expect(summary.booksFinished).toBe(1)
    const daily = await api.stats.daily({ from: '2026-01-01', to: '2026-12-31' })
    expect(daily.some((d) => d.date === '2026-03-01')).toBe(true)
    const onDate = await api.stats.onDate({ date: '2026-03-01' })
    expect(onDate.map((s) => s.title)).toEqual(['A'])
    const books = await api.stats.books({ from: '2026-01-01', to: '2026-12-31' })
    expect(books).toMatchObject([{ workId, title: 'A', authors: ['Someone'], format: 'physical', finishedOn: '2026-03-01' }])
    expect(await api.stats.books({ from: '2025-01-01', to: '2025-12-31' })).toEqual([])
  })
})
