import { describe, expect, it } from 'vitest'
import { ExternalItem } from '@mylib/domain'
import { contributors, sourceItems, sources } from '../schema'
import { seedName, seedWork, useTestDb, workInput } from '../testing'
import { createWork } from './catalog'
import { findCandidates } from './match'
import { createWorkFromItem, removeEditionForSource } from './source-catalog'

const item = (over: Record<string, unknown> = {}) =>
  ExternalItem.parse({ externalId: 'li_9', format: 'audiobook', title: 'The Final Empire', authors: ['Brandon Sanderson'], ...over })

describe('findCandidates', () => {
  const t = useTestDb()

  async function source() {
    const [s] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!s) throw new Error('no source')
    return s.id
  }

  it('finds a book by a shared identifier', async () => {
    const sourceId = await source()
    const workId = await createWork(t.db, workInput({ title: 'Mistborn: The Final Empire', editions: [{ format: 'audiobook', asin: 'B002UZMLXM' }] }))
    const [top] = await findCandidates(t.db, sourceId, item({ title: 'Something Else Entirely', identifiers: { asin: 'B002UZMLXM' } }))
    expect(top).toMatchObject({ workId, basis: 'identifier', score: 1 })
  })

  it('finds a book by title and author', async () => {
    const sourceId = await source()
    const workId = await createWork(t.db, workInput({ title: 'The Final Empire', series: [] }))
    await createWork(t.db, workInput({ title: 'Cooking for One', authors: ['Someone'], series: [] }))
    const candidates = await findCandidates(t.db, sourceId, item({ title: 'Final Empire' }))
    expect(candidates.map((c) => c.workId)).toEqual([workId])
    expect(candidates[0]).toMatchObject({ basis: 'title_author' })
  })

  it('finds a Hebrew title', async () => {
    const sourceId = await source()
    const workId = await createWork(t.db, workInput({ title: 'הארי פוטר ואבן החכמים', authors: ['ג׳יי קיי רולינג'], series: [] }))
    const [top] = await findCandidates(t.db, sourceId, item({ title: 'הארי פוטר ואבן החכמים', authors: ['ג׳יי קיי רולינג'] }))
    expect(top?.workId).toBe(workId)
  })

  it('ranks the formerly owned copy from this source first', async () => {
    const sourceId = await source()
    await createWork(t.db, workInput({ title: 'The Final Empire', series: [] }))
    const old = item({ externalId: 'li_1' })
    const { workId, editionId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, old, null))
    await t.db.insert(sourceItems).values({ sourceId, externalId: 'li_1', normalized: old, contentHash: 'h', state: 'linked', editionId, workId, removedAt: new Date() })
    await t.db.transaction((tx) => removeEditionForSource(tx, editionId, new Date()))

    const [top] = await findCandidates(t.db, sourceId, item({ externalId: 'li_2' }))
    expect(top).toMatchObject({ workId, editionId, basis: 'restore' })
  })

  it('matches an author by another spelling of the same person', async () => {
    const sourceId = await source()
    const workId = await createWork(t.db, workInput({ title: 'The Way of Kings', authors: ['Brandon Sanderson'], series: [] }))
    const [person] = await t.db.select({ id: contributors.id }).from(contributors)
    if (!person) throw new Error('no contributor')
    await seedName(t.db, person.id, 'ברנדון סנדרסון', 'he')
    const [top] = await findCandidates(t.db, sourceId, item({ title: 'The Way of Kings', authors: ['ברנדון סנדרסון'] }))
    expect(top).toMatchObject({ workId, basis: 'title_author' })
    expect(top?.reasons).toContain('Same author')
  })

  it('returns nothing for an unrelated title', async () => {
    const sourceId = await source()
    await createWork(t.db, workInput({ title: 'The Final Empire', series: [] }))
    expect(await findCandidates(t.db, sourceId, item({ title: 'Zzyzx Road Atlas', authors: ['Nobody'] }))).toEqual([])
  })
})

describe('findCandidates: shared source ids', () => {
  const t = useTestDb()

  async function source(kind: 'readarr' | 'calibre') {
    const [row] = await t.db.insert(sources).values({ kind, name: kind, config: { kind } }).returning({ id: sources.id })
    if (!row) throw new Error('no source')
    return row.id
  }

  async function linkedItem(sourceId: string, externalId: string, others: Record<string, string>, link: { workId: string; editionId: string | null }) {
    const normalized = ExternalItem.parse({ externalId, format: 'ebook', title: 'Linked', identifiers: { others } })
    await t.db.insert(sourceItems).values({ sourceId, externalId, normalized, contentHash: 'x', state: 'linked', ...link })
  }

  const file = (others: Record<string, string>) => ExternalItem.parse({ externalId: 'book:11:ebook', format: 'ebook', title: 'Zzz unrelated title', identifiers: { others } })

  it('offers the wanted book as an exact match when its file arrives', async () => {
    const readarr = await source('readarr')
    const { workId } = await seedWork(t.db, { title: 'Project Hail Mary', noEditions: true })
    await linkedItem(readarr, 'book:11', { readarrBookId: '11' }, { workId, editionId: null })
    expect(await findCandidates(t.db, readarr, file({ readarrBookId: '11' }))).toEqual([
      { workId, editionId: null, volume: null, score: 1, basis: 'identifier', reasons: ['Same Readarr book'] },
    ])
  })

  it('never matches a source-local id from another source', async () => {
    const one = await source('readarr')
    const two = await source('readarr')
    const { workId } = await seedWork(t.db, { title: 'Project Hail Mary', noEditions: true })
    await linkedItem(one, 'book:11', { readarrBookId: '11' }, { workId, editionId: null })
    expect(await findCandidates(t.db, two, file({ readarrBookId: '11' }))).toEqual([])
  })

  it('matches a Goodreads id across sources and points at the same-format copy', async () => {
    const calibre = await source('calibre')
    const readarr = await source('readarr')
    const { workId, editionIds } = await seedWork(t.db, { title: 'The Final Empire', formats: ['ebook'] })
    await linkedItem(calibre, '1', { calibreId: '1', goodreads: '68428' }, { workId, editionId: editionIds[0] ?? null })
    expect(await findCandidates(t.db, readarr, file({ readarrBookId: '10', goodreads: '68428' }))).toMatchObject([
      { workId, editionId: editionIds[0], basis: 'identifier', reasons: ['Same Goodreads id'] },
    ])
  })

  it('matches a Hebrew shelf copy to an English-titled book through an alternative title', async () => {
    const NIL_SOURCE = '00000000-0000-4000-8000-000000000000'
    const workId = await createWork(t.db, workInput({ title: 'The Name of the Wind', authors: ['Patrick Rothfuss'], series: [], editions: [{ format: 'audiobook' }] }))
    const shelf = ExternalItem.parse({ externalId: 'photo:1', format: 'physical', title: 'שם הרוח', authors: ['פטריק רותפס'] })
    expect(await findCandidates(t.db, NIL_SOURCE, shelf)).toEqual([])
    const [top] = await findCandidates(t.db, NIL_SOURCE, shelf, 5, { altTitles: ['The Name of the Wind'] })
    expect(top).toMatchObject({ workId, basis: 'title_author' })
    expect(top?.score).toBeGreaterThanOrEqual(0.7)
  })
})
