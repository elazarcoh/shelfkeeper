import { describe, expect, it } from 'vitest'
import { useServerHarness } from '../testing/harness'

const book = (title: string, position: number | null, series = 'Discworld') => ({
  title,
  authors: ['Terry Pratchett'],
  series: position === null ? [] : [{ name: series, position }],
  editions: [{ format: 'physical' as const }],
})

describe('library router: browse', () => {
  const h = useServerHarness()

  it('collapses a series into one card on request, and opens it in series order', async () => {
    const { api } = await h.asNewUser()
    await api.catalog.create({ work: book('Mort', 4) })
    await api.catalog.create({ work: book('The Colour of Magic', 1) })
    await api.catalog.create({ work: book('Equal Rites', 3), addToMyBooks: false })
    await api.catalog.create({ work: book('Good Omens', null) })

    const collapsed = await api.library.browse({ collapseSeries: true })
    expect(collapsed).toMatchObject({ total: 2, books: 3 })
    expect(collapsed.items.map((e) => (e.kind === 'work' ? e.work.title : `${e.series.name} ×${e.series.bookCount}`))).toEqual([
      'Discworld ×2',
      'Good Omens',
    ])
    const [group] = collapsed.items
    const seriesId = group?.kind === 'series' ? group.series.id : ''
    expect(group?.kind === 'series' ? group.series.covers.map((c) => c.title) : []).toEqual(['The Colour of Magic', 'Mort'])

    // the whole catalog has the book left out of my library
    expect((await api.library.browse({ scope: 'catalog', collapseSeries: true })).books).toBe(4)

    // inside the series: its books one by one, #1 first, never collapsed
    const inside = await api.library.browse({ scope: 'catalog', seriesId, sort: 'series', collapseSeries: true })
    expect(inside.items.map((e) => (e.kind === 'work' ? e.work.title : e.kind))).toEqual(['The Colour of Magic', 'Equal Rites', 'Mort'])

    // search text shows matching books, not series
    const searched = await api.library.browse({ search: 'mort', collapseSeries: true })
    expect(searched.items.map((e) => e.kind)).toEqual(['work'])
  })

  it('pages from a cursor (infinite scroll), which wins over the offset', async () => {
    const { api } = await h.asNewUser()
    for (const title of ['A', 'B', 'C']) await api.catalog.create({ work: book(title, null) })
    const titles = (page: { items: { kind: string; work?: { title: string } }[] }) => page.items.map((e) => e.work?.title)
    expect(titles(await api.library.browse({ limit: 2 }))).toEqual(['A', 'B'])
    expect(titles(await api.library.browse({ limit: 2, cursor: 2, offset: 0 }))).toEqual(['C'])
    expect(titles(await api.library.browse({ limit: 2, cursor: null, offset: 1 }))).toEqual(['B', 'C'])
    await expect(api.library.browse({ cursor: -1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses a series id that is not a uuid', async () => {
    const { api } = await h.asNewUser()
    await expect(api.library.browse({ seriesId: 'discworld' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('library router: offline snapshot (#62)', () => {
  const h = useServerHarness()

  it('holds every book the person can see, past one page, compact', async () => {
    const { api } = await h.asNewUser()
    for (let i = 1; i <= 102; i++) await api.catalog.create({ work: book(`Book ${String(i).padStart(3, '0')}`, null) })
    await api.catalog.create({ work: book('Not Mine', null), addToMyBooks: false })

    const snap = await api.library.snapshot()
    expect(snap.works).toHaveLength(103)
    expect(Number.isNaN(Date.parse(snap.at))).toBe(false)
    expect(snap.works[0]).toEqual({
      id: expect.any(String) as string,
      title: 'Book 001',
      subtitle: null,
      kind: expect.any(String) as string,
      authors: ['Terry Pratchett'],
      series: null,
      formats: ['physical'],
      availability: 'owned',
      status: 'none',
      rating: null,
      coverAssetId: null,
    })
    expect(snap.works.some((w) => w.title === 'Not Mine')).toBe(true)
  })
})
