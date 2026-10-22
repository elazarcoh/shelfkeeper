import { describe, expect, it } from 'vitest'
import type { FilterNode } from '@mylib/domain'
import { eq } from 'drizzle-orm'
import { editions, userWorks, workContributors, workSeries } from '../schema'
import { seedUser, seedWork, titlesWhere, useTestDb, workInput } from '../testing'
import { createWork } from './catalog'
import { compileFilter } from './filter-sql'

describe('compileFilter', () => {
  const t = useTestDb()
  const match = (node: FilterNode, userId: string) => titlesWhere(t.db, compileFilter(node, userId))

  it('matches every predicate kind', async () => {
    const user = await seedUser(t.db)
    const dune = await seedWork(t.db, {
      title: 'Dune',
      authors: ['Frank Herbert'],
      formats: ['physical', 'audiobook'],
      tags: ['sci-fi'],
      series: { name: 'Dune', position: 1 },
      language: 'en',
      narrators: ['Scott Brick'],
      createdAt: new Date('2024-03-10T10:00:00Z'),
    })
    await seedWork(t.db, {
      title: 'Emma',
      authors: ['Jane Austen'],
      formats: ['ebook'],
      language: 'fr',
      createdAt: new Date('2025-01-01T10:00:00Z'),
    })
    await seedWork(t.db, { title: 'Gone', holding: { inPossession: false } })
    await seedWork(t.db, { title: 'Loan', holding: { ownership: 'borrowed' } })
    await seedWork(t.db, { title: 'Returned', holding: { ownership: 'borrowed', inPossession: false } })
    await seedWork(t.db, { title: 'Wished', noEditions: true })
    await t.db.insert(userWorks).values({ userId: user.id, workId: dune.workId, status: 'read', rating: 4.5 })
    const u = user.id

    expect(await match({ op: 'format', formats: ['audiobook'] }, u)).toEqual(['Dune'])
    expect(await match({ op: 'author', contributorIds: dune.authorIds }, u)).toEqual(['Dune'])
    expect(await match({ op: 'narrator', contributorIds: dune.narratorIds }, u)).toEqual(['Dune'])
    expect(await match({ op: 'series', seriesIds: [dune.seriesId ?? ''] }, u)).toEqual(['Dune'])
    expect(await match({ op: 'tag', tagIds: dune.tagIds }, u)).toEqual(['Dune'])
    expect(await match({ op: 'language', languages: ['fr'] }, u)).toEqual(['Emma'])
    expect(await match({ op: 'status', statuses: ['read'] }, u)).toEqual(['Dune'])
    expect(await match({ op: 'status', statuses: ['none'] }, u)).toEqual(['Emma', 'Gone', 'Loan', 'Returned', 'Wished'])
    expect(await match({ op: 'rating', min: 4, max: 5 }, u)).toEqual(['Dune'])
    expect(await match({ op: 'availability', values: ['owned'] }, u)).toEqual(['Dune', 'Emma'])
    expect(await match({ op: 'availability', values: ['borrowed'] }, u)).toEqual(['Loan'])
    expect(await match({ op: 'availability', values: ['formerly_owned'] }, u)).toEqual(['Gone'])
    expect(await match({ op: 'availability', values: ['not_owned'] }, u)).toEqual(['Returned'])
    expect(await match({ op: 'availability', values: ['wanted'] }, u)).toEqual(['Wished'])
    expect(await match({ op: 'availability', values: ['owned', 'borrowed'] }, u)).toEqual(['Dune', 'Emma', 'Loan'])
    expect(await match({ op: 'addedAt', from: '2025-01-01', to: null }, u)).toEqual(['Emma', 'Gone', 'Loan', 'Returned', 'Wished'])
    expect(await match({ op: 'addedAt', from: null, to: '2024-12-31' }, u)).toEqual(['Dune'])
  })

  it('filters by kind, alone, with an author, and inside a series (#133)', async () => {
    const u = (await seedUser(t.db)).id
    const work = (title: string, kind: 'book' | 'fanfiction' | 'web_serial', authors: string[], series: string | null) =>
      createWork(t.db, workInput({ title, kind, authors, series: series === null ? [] : [{ name: series, position: null }] }))
    const book = await work('Plain', 'book', ['Ann'], 'Saga')
    const fic = await work('Fic', 'fanfiction', ['Ann'], 'Saga')
    await work('Serial', 'web_serial', ['Ann'], null)
    await work('Other', 'book', ['Bob'], null)
    const hideFic: FilterNode = { op: 'kind', kinds: ['book', 'web_serial'] }
    expect(await match({ op: 'kind', kinds: ['fanfiction'] }, u)).toEqual(['Fic'])
    expect(await match(hideFic, u)).toEqual(['Other', 'Plain', 'Serial'])
    const ann = (await t.db.select({ id: workContributors.contributorId }).from(workContributors).where(eq(workContributors.workId, book))).map((r) => r.id)
    expect(await match({ op: 'and', nodes: [hideFic, { op: 'author', contributorIds: ann }] }, u)).toEqual(['Plain', 'Serial'])
    const [saga] = await t.db.select({ id: workSeries.seriesId }).from(workSeries).where(eq(workSeries.workId, fic))
    expect(await match({ op: 'and', nodes: [hideFic, { op: 'series', seriesIds: [saga?.id ?? ''] }] }, u)).toEqual(['Plain'])
  })

  it('combines predicates with and/or/not', async () => {
    const user = await seedUser(t.db)
    await seedWork(t.db, { title: 'A', formats: ['audiobook'], language: 'en' })
    await seedWork(t.db, { title: 'B', formats: ['ebook'], language: 'en' })
    await seedWork(t.db, { title: 'C', formats: ['ebook'], language: 'de' })
    const en: FilterNode = { op: 'language', languages: ['en'] }
    const ebook: FilterNode = { op: 'format', formats: ['ebook'] }
    expect(await match({ op: 'and', nodes: [en, ebook] }, user.id)).toEqual(['B'])
    expect(await match({ op: 'or', nodes: [en, ebook] }, user.id)).toEqual(['A', 'B', 'C'])
    expect(await match({ op: 'not', node: en }, user.id)).toEqual(['C'])
  })

  it('matches a book when any edition is in the language; a book with no editions never matches (#124)', async () => {
    const u = (await seedUser(t.db)).id
    const mixed = await seedWork(t.db, { title: 'Mixed', formats: ['physical', 'ebook'], language: 'en' })
    const [first] = await t.db.select({ id: editions.id }).from(editions).where(eq(editions.workId, mixed.workId))
    await t.db.update(editions).set({ language: 'he' }).where(eq(editions.id, first?.id ?? ''))
    await seedWork(t.db, { title: 'English', language: 'en' })
    await seedWork(t.db, { title: 'Wanted', noEditions: true })
    expect(await match({ op: 'language', languages: ['he'] }, u)).toEqual(['Mixed'])
    expect(await match({ op: 'language', languages: ['en'] }, u)).toEqual(['English', 'Mixed'])
  })

  it('matches a language by any spelling of it', async () => {
    const u = (await seedUser(t.db)).id
    await seedWork(t.db, { title: 'English', language: 'en' })
    await seedWork(t.db, { title: 'French', language: 'fr' })
    expect(await match({ op: 'language', languages: ['English'] }, u)).toEqual(['English'])
  })

  it('treats a work with no language as not matching a language, so "not" matches it', async () => {
    const user = await seedUser(t.db)
    await seedWork(t.db, { title: 'French', language: 'fr' })
    await seedWork(t.db, { title: 'Unknown', language: null })
    const fr: FilterNode = { op: 'language', languages: ['fr'] }
    expect(await match(fr, user.id)).toEqual(['French'])
    expect(await match({ op: 'not', node: fr }, user.id)).toEqual(['Unknown'])
  })

  it("evaluates status for the given user only", async () => {
    const alice = await seedUser(t.db)
    const bob = await seedUser(t.db)
    const w = await seedWork(t.db, { title: 'Shared' })
    await t.db.insert(userWorks).values({ userId: alice.id, workId: w.workId, status: 'reading' })
    expect(await match({ op: 'status', statuses: ['reading'] }, alice.id)).toEqual(['Shared'])
    expect(await match({ op: 'status', statuses: ['reading'] }, bob.id)).toEqual([])
  })
})
