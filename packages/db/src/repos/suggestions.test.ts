import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { LoanInput } from '@mylib/domain'
import { editions, workContributors, setItems, sets, userHiddenSets, userHiddenWorks } from '../schema'
import { seedName, seedUser, seedWork, useTestDb } from '../testing'
import { createLoan } from './loans'
import { loadUserScope } from './scope'
import { collapseSpellings, listSuggestions } from './suggestions'

const first = (ids: string[]): string => ids[0] ?? ''

describe('collapseSpellings', () => {
  it('keeps the most used spelling of values that normalize alike, sorted', () => {
    expect(
      collapseSpellings([
        { value: 'tor', uses: 1 },
        { value: 'Tor', uses: 3 },
        { value: 'Gollancz', uses: 1 },
        { value: 'TOR', uses: 2 },
      ]),
    ).toEqual(['Gollancz', 'Tor'])
  })

  it('adds up the same exact value from several sources before choosing, ignores blanks, breaks ties by sort order (lowercase sorts first)', () => {
    expect(
      collapseSpellings([
        { value: 'en', uses: 2 },
        { value: 'EN', uses: 3 },
        { value: 'en', uses: 2 },
        { value: '  ', uses: 9 },
        { value: 'he', uses: 1 },
        { value: 'He', uses: 1 },
      ]),
    ).toEqual(['en', 'he'])
  })
})

describe('listSuggestions', () => {
  const t = useTestDb()

  it('lists every kind of name from the books the user can see', async () => {
    const user = await seedUser(t.db)
    const w = await seedWork(t.db, {
      title: 'The Final Empire',
      authors: ['Brandon Sanderson'],
      tags: ['Fantasy'],
      series: { name: 'Mistborn', position: 1 },
      language: 'en',
      formats: ['audiobook', 'ebook'],
      narrators: ['Michael Kramer'],
    })
    await t.db
      .update(editions)
      .set({ publisher: 'Tor', shelfLocation: 'Living room', language: 'he' })
      .where(eq(editions.id, first(w.editionIds)))
    const scope = await loadUserScope(t.db, user)

    const s = await listSuggestions(t.db, scope)
    expect(s.series).toEqual([{ id: w.seriesId, name: 'Mistborn' }])
    expect(s.contributors).toEqual(['Brandon Sanderson', 'Michael Kramer'])
    expect(s.tags).toEqual(['Fantasy'])
    expect(s.languages).toEqual(['en', 'he'])
    expect(s.publishers).toEqual(['Tor'])
    expect(s.shelfLocations).toEqual(['Living room'])
    expect(s.borrowers).toEqual([])
  })

  it('offers every name of a person', async () => {
    const user = await seedUser(t.db)
    const w = await seedWork(t.db, { title: 'The Final Empire', authors: ['Brandon Sanderson'] })
    const [link] = await t.db.select().from(workContributors).where(eq(workContributors.workId, w.workId))
    await seedName(t.db, link?.contributorId ?? '', 'ברנדון סנדרסון', 'he')
    const s = await listSuggestions(t.db, await loadUserScope(t.db, user))
    expect(s.contributors).toEqual(expect.arrayContaining(['Brandon Sanderson', 'ברנדון סנדרסון']))
    expect(s.contributors).toHaveLength(2)
  })

  it('leaves out names that only a hidden book carries', async () => {
    const user = await seedUser(t.db)
    await seedWork(t.db, { title: 'Seen', authors: ['Ann Leckie'], tags: ['Space'], series: { name: 'Imperial Radch', position: 1 } })
    const hidden = await seedWork(t.db, {
      title: 'Hidden',
      authors: ['Secret Author'],
      tags: ['Secret tag'],
      series: { name: 'Secret series', position: 1 },
      language: 'fr',
      narrators: ['Secret Narrator'],
      formats: ['audiobook'],
    })
    await t.db.update(editions).set({ publisher: 'Secret Press', shelfLocation: 'Attic' }).where(eq(editions.id, first(hidden.editionIds)))
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: hidden.workId })
    const scope = await loadUserScope(t.db, user)

    const s = await listSuggestions(t.db, scope)
    expect(s.series.map((x) => x.name)).toEqual(['Imperial Radch'])
    expect(s.contributors).toEqual(['Ann Leckie'])
    expect(s.tags).toEqual(['Space'])
    expect(s.languages).toEqual([])
    expect(s.publishers).toEqual([])
    expect(s.shelfLocations).toEqual([])
  })

  it('leaves out names that only a book in a set the user hid carries', async () => {
    const user = await seedUser(t.db)
    await seedWork(t.db, { title: 'Seen', authors: ['Ann Leckie'], tags: ['Space'] })
    const inSet = await seedWork(t.db, { title: 'In hidden set', authors: ['Set Author'], tags: ['Set tag'], series: { name: 'Set series', position: 1 } })
    const [set] = await t.db.insert(sets).values({ name: 'Adults', scope: 'global', kind: 'manual' }).returning({ id: sets.id })
    if (!set) throw new Error('set insert failed')
    await t.db.insert(setItems).values({ setId: set.id, workId: inSet.workId })
    await t.db.insert(userHiddenSets).values({ userId: user.id, setId: set.id })
    const scope = await loadUserScope(t.db, user)

    const s = await listSuggestions(t.db, scope)
    expect(s.series).toEqual([])
    expect(s.contributors).toEqual(['Ann Leckie'])
    expect(s.tags).toEqual(['Space'])
  })

  it('suggests only the borrowers of loans the user made', async () => {
    const a = await seedUser(t.db)
    const b = await seedUser(t.db)
    const one = await seedWork(t.db, { title: 'One', authors: ['X'] })
    const two = await seedWork(t.db, { title: 'Two', authors: ['X'] })
    const scopeA = await loadUserScope(t.db, a)
    const scopeB = await loadUserScope(t.db, b)
    await createLoan(t.db, scopeA, LoanInput.parse({ editionId: first(one.editionIds), borrowerName: 'Dana', lentOn: '2026-10-01' }))
    await createLoan(t.db, scopeB, LoanInput.parse({ editionId: first(two.editionIds), borrowerName: 'Noa', lentOn: '2026-10-01' }))

    expect((await listSuggestions(t.db, scopeA)).borrowers).toEqual(['Dana'])
    expect((await listSuggestions(t.db, scopeB)).borrowers).toEqual(['Noa'])
  })

  it('collapses publisher spellings across editions to the most used one', async () => {
    const user = await seedUser(t.db)
    for (const [title, publisher] of [['A', 'Tor'], ['B', 'Tor'], ['C', 'TOR']] as const) {
      const w = await seedWork(t.db, { title, authors: ['X'] })
      await t.db.update(editions).set({ publisher }).where(eq(editions.id, first(w.editionIds)))
    }
    const scope = await loadUserScope(t.db, user)
    expect((await listSuggestions(t.db, scope)).publishers).toEqual(['Tor'])
  })
})
