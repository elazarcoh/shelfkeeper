import { describe, expect, it } from 'vitest'
import { LibraryQuery, type LibraryEntry } from '@mylib/domain'
import type { Db } from '../client'
import { userHiddenWorks } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork } from './catalog'
import { listLibrary } from './library'
import { loadUserScope, type UserScope } from './scope'
import { addWorkToSet, createSet, getDefaultPersonalSetId } from './sets'
import { setStatus } from './tracking'

/** An entry as one short string: "work:Title" or "series:Name 3 (1 read) [cover, cover]". */
function label(e: LibraryEntry): string {
  if (e.kind === 'work') return `work:${e.work.title}`
  const s = e.series
  return `series:${s.name} ${s.bookCount} (${s.readCount} read) [${s.covers.map((c) => c.title).join(', ')}]`
}

async function seedShelf(db: Db) {
  const book = (title: string, series: { name: string; position: number | null }[], format: 'physical' | 'audiobook' = 'physical') =>
    createWork(db, workInput({ title, authors: ['Someone'], series, editions: [{ format }] }))
  // added out of order: a series card shows its books by position, not by when they came in
  const sagaThree = await book('Saga Three', [{ name: 'The Saga', position: 3 }], 'audiobook')
  const sagaOne = await book('Saga One', [{ name: 'The Saga', position: 1 }])
  const sagaTwo = await book('Saga Two', [{ name: 'The Saga', position: 2 }])
  // in two series: grouped once, under its first (Alpha)
  const crossover = await book('Crossover', [
    { name: 'Alpha', position: 5 },
    { name: 'Beta', position: 1 },
  ])
  const betaOne = await book('Beta Start', [{ name: 'Beta', position: 2 }])
  const zebra = await book('Zebra', [])
  const apple = await book('Apple', [])
  return { sagaOne, sagaTwo, sagaThree, crossover, betaOne, zebra, apple }
}

describe('library with series collapsed', () => {
  const t = useTestDb()
  const query = (q: Partial<LibraryQuery>) => LibraryQuery.parse({ scope: 'catalog', collapseSeries: true, ...q })
  const labels = async (scope: UserScope, q: Partial<LibraryQuery>) => (await listLibrary(t.db, scope, query(q))).items.map(label)

  async function member() {
    const user = await seedUser(t.db)
    return { user, scope: await loadUserScope(t.db, user) }
  }

  it('shows each series as one card with its count, my progress and covers in series order, mixed in with standalone books by title', async () => {
    const ids = await seedShelf(t.db)
    const { scope } = await member()
    await setStatus(t.db, scope, ids.sagaOne, 'read')
    await setStatus(t.db, scope, ids.sagaTwo, 'reading')
    const page = await listLibrary(t.db, scope, query({ sort: 'title' }))
    expect(page.items.map(label)).toEqual([
      'series:Alpha 1 (0 read) [Crossover]',
      'work:Apple',
      'series:Beta 1 (0 read) [Beta Start]',
      // "The Saga" sorts as "saga", like a title
      'series:The Saga 3 (1 read) [Saga One, Saga Two, Saga Three]',
      'work:Zebra',
    ])
    expect(page.total).toBe(5)
    expect(page.books).toBe(7)
  })

  it('counts only the books that pass the filters', async () => {
    await seedShelf(t.db)
    const { scope } = await member()
    expect(await labels(scope, { filter: { op: 'format', formats: ['audiobook'] } })).toEqual(['series:The Saga 1 (0 read) [Saga Three]'])
    const page = await listLibrary(t.db, scope, query({ filter: { op: 'format', formats: ['physical'] } }))
    expect(page.items.map(label)).toContain('series:The Saga 2 (0 read) [Saga One, Saga Two]')
    expect(page.books).toBe(6)
  })

  it('never counts or shows a hidden book, and a series whose books are all hidden is gone', async () => {
    const ids = await seedShelf(t.db)
    const { user } = await member()
    await t.db.insert(userHiddenWorks).values([
      { userId: user.id, workId: ids.sagaTwo },
      { userId: user.id, workId: ids.betaOne },
    ])
    const scope = await loadUserScope(t.db, user)
    const page = await listLibrary(t.db, scope, query({}))
    expect(page.items.map(label)).toEqual(['series:Alpha 1 (0 read) [Crossover]', 'work:Apple', 'series:The Saga 2 (0 read) [Saga One, Saga Three]', 'work:Zebra'])
    expect(page.books).toBe(5)
  })

  it('groups a book in two series once, under its first', async () => {
    await seedShelf(t.db)
    const { scope } = await member()
    const all = (await labels(scope, {})).join('\n')
    expect(all.match(/Crossover/g)).toHaveLength(1)
    expect(all).toContain('series:Alpha 1 (0 read) [Crossover]')
    expect(all).toContain('series:Beta 1 (0 read) [Beta Start]')
  })

  it('pages through the cards with no card twice or missing, whatever the sort', async () => {
    await seedShelf(t.db)
    const { scope } = await member()
    for (const sort of ['title', 'added', 'author', 'rating', 'series'] as const) {
      const all = await labels(scope, { sort, limit: 100 })
      const paged: string[] = []
      for (let offset = 0; offset < all.length + 2; offset += 2) {
        const page = await listLibrary(t.db, scope, query({ sort, limit: 2, offset }))
        expect(page.total).toBe(5)
        paged.push(...page.items.map(label))
      }
      expect(paged, sort).toEqual(all)
    }
  })

  it('orders a series by its newest book under Recently added', async () => {
    const ids = await seedShelf(t.db)
    const { scope } = await member()
    // Apple was added last of all; Saga Two is the newest of its series
    expect((await labels(scope, { sort: 'added' })).slice(0, 2)).toEqual(['work:Apple', 'work:Zebra'])
    await createWork(t.db, workInput({ title: 'Saga Four', authors: ['Someone'], series: [{ name: 'The Saga', position: 4 }] }))
    expect((await labels(scope, { sort: 'added' }))[0]).toBe('series:The Saga 4 (0 read) [Saga One, Saga Two, Saga Three]')
    expect(ids.sagaOne).toBeDefined()
  })

  it('does not collapse while searching: matching books show one by one', async () => {
    await seedShelf(t.db)
    const { scope } = await member()
    const page = await listLibrary(t.db, scope, query({ search: 'saga' }))
    expect(page.items.map(label).sort()).toEqual(['work:Saga One', 'work:Saga Three', 'work:Saga Two'])
    expect(page.total).toBe(3)
    expect(page.books).toBe(3)
  })

  it('collapses only when asked', async () => {
    await seedShelf(t.db)
    const { scope } = await member()
    const page = await listLibrary(t.db, scope, query({ collapseSeries: false }))
    expect(page.items.every((e) => e.kind === 'work')).toBe(true)
    expect(page.total).toBe(7)
  })

  it('inside a series shows its books one by one, in series order', async () => {
    const ids = await seedShelf(t.db)
    const { scope } = await member()
    const [saga] = (await listLibrary(t.db, scope, query({ filter: { op: 'format', formats: ['audiobook'] } }))).items
    expect(saga?.kind).toBe('series')
    const seriesId = saga?.kind === 'series' ? saga.series.id : ''
    expect(await labels(scope, { seriesId, sort: 'series' })).toEqual(['work:Saga One', 'work:Saga Two', 'work:Saga Three'])
    // another sort still works inside it
    expect(await labels(scope, { seriesId, sort: 'title' })).toEqual(['work:Saga One', 'work:Saga Three', 'work:Saga Two'])
    expect(ids.sagaThree).toBeDefined()
  })

  it('sorts a series name among titles exactly as a title would sort: accents, punctuation and a leading article', async () => {
    const { scope } = await member()
    const book = (title: string, series: string | null) =>
      createWork(t.db, workInput({ title, authors: ['Someone'], series: series === null ? [] : [{ name: series, position: 1 }] }))
    await book('Eagle', null)
    await book('Ezra', null)
    await book('Rose', null)
    await book('Sun', null)
    await book('Tiger', null)
    // "éclat" sorts as "eclat"; "'The' Saga" as "saga" (quote dropped, then the article), as sortTitle would
    await book('Inside Éclat', 'Éclat')
    await book('Inside the Saga', "'The' Saga")
    expect(await labels(scope, { sort: 'title' })).toEqual([
      'work:Eagle',
      'series:Éclat 1 (0 read) [Inside Éclat]',
      'work:Ezra',
      'work:Rose',
      "series:'The' Saga 1 (0 read) [Inside the Saga]",
      'work:Sun',
      'work:Tiger',
    ])
    // the uncollapsed "Series order" uses the same key
    const flat = await listLibrary(t.db, scope, query({ sort: 'series', collapseSeries: false }))
    expect(flat.items.map(label).slice(0, 2)).toEqual(['work:Inside Éclat', 'work:Inside the Saga'])
  })

  it('collapses inside a set, manual or smart, counting only the set’s books', async () => {
    const ids = await seedShelf(t.db)
    const { scope } = await member()
    const manual = await createSet(t.db, scope, { kind: 'manual', scope: 'personal', name: 'Shelf' })
    for (const id of [ids.sagaOne, ids.sagaTwo, ids.zebra]) await addWorkToSet(t.db, scope, manual.id, id)
    expect(await labels(scope, { setId: manual.id })).toEqual(['series:The Saga 2 (0 read) [Saga One, Saga Two]', 'work:Zebra'])

    const smart = await createSet(t.db, scope, { kind: 'smart', scope: 'personal', name: 'Audio', filter: { op: 'format', formats: ['audiobook'] } })
    const page = await listLibrary(t.db, scope, query({ setId: smart.id }))
    expect(page.items.map(label)).toEqual(['series:The Saga 1 (0 read) [Saga Three]'])
    expect(page.books).toBe(1)
  })

  it('in my library leaves a hidden book out of its series count', async () => {
    const ids = await seedShelf(t.db)
    const { user, scope } = await member()
    const mine = await getDefaultPersonalSetId(t.db, user.id)
    for (const id of [ids.sagaOne, ids.sagaTwo, ids.sagaThree]) await addWorkToSet(t.db, scope, mine, id)
    await setStatus(t.db, scope, ids.sagaTwo, 'read')
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: ids.sagaTwo })
    const hidden = await loadUserScope(t.db, user)
    const page = await listLibrary(t.db, hidden, query({ scope: 'library' }))
    expect(page.items.map(label)).toEqual(['series:The Saga 2 (0 read) [Saga One, Saga Three]'])
    expect(page.books).toBe(2)
  })

  it('in my library groups only my own books', async () => {
    const ids = await seedShelf(t.db)
    const { user, scope } = await member()
    const mine = await getDefaultPersonalSetId(t.db, user.id)
    await addWorkToSet(t.db, scope, mine, ids.sagaThree)
    await addWorkToSet(t.db, scope, mine, ids.apple)
    const library = await listLibrary(t.db, scope, query({ scope: 'library' }))
    expect(library.items.map(label)).toEqual(['work:Apple', 'series:The Saga 1 (0 read) [Saga Three]'])
    expect(library.books).toBe(2)
    expect((await listLibrary(t.db, scope, query({ scope: 'catalog' }))).books).toBe(7)
  })
})
