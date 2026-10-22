import { describe, expect, it } from 'vitest'
import { useServerHarness } from '../testing/harness'

const input = {
  fileName: 'goodreads.csv',
  header: ['Title', 'Author', 'My Rating', 'Date Read'],
  rows: [['Project Hail Mary', 'Andy Weir', '4', '2023/05/14']],
  mapping: { columns: { title: 0, authors: 1, rating: 2, finishedOn: 3 } },
  ownership: 'owned' as const,
  importId: '66666666-6666-4666-8666-666666666666',
}

describe('csv import through the API', () => {
  const h = useServerHarness()

  it('a member imports a file, accepts a row, and gets the book, the read and the rating', async () => {
    const { api } = await h.asNewUser()
    const first = await api.csv.import(input)
    expect(first).toMatchObject({ proposals: 1, invalid: [], alreadyImported: false })
    // a retry of the same file pick imports nothing new
    expect(await api.csv.import(input)).toEqual({ sourceId: first.sourceId, proposals: 1, invalid: [], alreadyImported: true })
    expect(await api.inbox.count()).toBe(1)
    const { items } = await api.inbox.mine()
    const { workId } = await api.inbox.resolveMine({ proposalId: items[0]?.id ?? '', resolution: { action: 'create_work' }, today: '2026-01-05' })
    const book = await api.catalog.get({ workId: workId ?? '' })
    expect(book.me).toMatchObject({ status: 'read', rating: 4 })
    expect(await api.sessions.listForWork({ workId: workId ?? '' })).toMatchObject([{ outcome: 'finished', finishedOn: '2023-05-14' }])
    expect(await api.inbox.count()).toBe(0)
  })

  it('keeps imports private to the importer', async () => {
    const { api } = await h.asNewUser()
    await api.csv.import(input)
    const { api: other } = await h.asNewUser()
    expect((await other.inbox.mine()).items).toEqual([])
    const { items } = await api.inbox.mine()
    await expect(other.inbox.resolveMine({ proposalId: items[0]?.id ?? '', resolution: { action: 'create_work' }, today: '2026-01-05' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('files my imports in bulk, for me only', async () => {
    const { api } = await h.asNewUser()
    await api.csv.import({ ...input, rows: [input.rows[0] ?? [], ['The Martian', 'Andy Weir', '', '']] })
    const { api: other } = await h.asNewUser()
    await other.csv.import(input)
    expect(await api.inbox.mine()).toMatchObject({ total: 2, exactMatches: 0, unmatched: 2 })
    expect(await api.inbox.acceptMineExact({ today: '2026-01-05' })).toEqual({ accepted: 0, remaining: 0 })
    expect(await api.inbox.createMineUnmatched({ today: '2026-01-05' })).toEqual({ created: 2, skipped: 0, remaining: 0 })
    expect(await api.inbox.count()).toBe(0)
    expect((await other.inbox.mine()).total).toBe(1)
    await expect(api.inbox.createMineUnmatched({ today: 'yesterday' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(h.call().api.inbox.acceptMineExact({ today: '2026-01-05' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('lists my imports up to the limit asked for, counting them all', async () => {
    const { api } = await h.asNewUser()
    await api.csv.import({ ...input, rows: [input.rows[0] ?? [], ['The Martian', 'Andy Weir', '', '']] })
    const first = await api.inbox.mine({ limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.total).toBe(2)
    expect((await api.inbox.mine({ limit: 2 })).items.map((e) => e.id)[0]).toBe(first.items[0]?.id)
    await expect(api.inbox.mine({ limit: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('requires sign-in and rejects oversized files', async () => {
    await expect(h.call().api.csv.import(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    const { api } = await h.asNewUser()
    await expect(api.csv.import({ ...input, rows: Array.from({ length: 2001 }, () => input.rows[0] ?? []) })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
