import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { DomainError, pairKey, type SqlHealthCheck } from '@mylib/domain'
import { editions, loans, series, sourceItems, sources } from '../schema'
import { seedCover, seedUser, seedWork, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail, updateWork } from './catalog'
import { createLoan } from './loans'
import { loadUserScope } from './scope'
import { deleteEmptySeries, dismissKindSuggestion, healthCounts, ignoreHealth, listHealth, unignoreHealth } from './health'

const TODAY = '2026-10-18'

describe('data health checks', () => {
  const t = useTestDb()
  const list = async (check: SqlHealthCheck, showIgnored = false) => (await listHealth(t.db, { check, today: TODAY, limit: 50, showIgnored })).items
  const keys = async (check: SqlHealthCheck, showIgnored = false) => (await list(check, showIgnored)).map((i) => i.key)
  const editionsOf = async (workId: string) => t.db.select().from(editions).where(eq(editions.workId, workId))

  it('no_cover: a book whose editions have no cover, not one with a cover or with no editions', async () => {
    const bare = await createWork(t.db, workInput({ title: 'Bare', series: [] }))
    const covered = await createWork(t.db, workInput({ title: 'Covered', series: [] }))
    await seedCover(t.db, (await editionsOf(covered))[0]?.id ?? '', { path: 'c.jpg', sha256: 'a'.repeat(64), mime: 'image/jpeg' })
    await seedWork(t.db, { title: 'Wanted', noEditions: true })
    expect(await keys('no_cover')).toEqual([bare])
    expect(await list('no_cover')).toEqual([{ check: 'no_cover', key: bare, work: { id: bare, title: 'Bare' } }])
  })

  it('no_isbn: a printed or ebook edition without one; audiobook-only books are exempt', async () => {
    const plain = await createWork(t.db, workInput({ title: 'Plain', series: [] }))
    await createWork(t.db, workInput({ title: 'With ISBN', series: [], editions: [{ format: 'physical', isbn13: '9780765311788' }] }))
    await createWork(t.db, workInput({ title: 'Listen only', series: [], editions: [{ format: 'audiobook' }] }))
    const mixed = await createWork(t.db, workInput({ title: 'Mixed', series: [], editions: [{ format: 'audiobook' }, { format: 'ebook' }] }))
    await seedWork(t.db, { title: 'Wanted', noEditions: true })
    expect((await keys('no_isbn')).sort()).toEqual([mixed, plain].sort())
  })

  it('no_author: a book with no author link', async () => {
    await createWork(t.db, workInput({ title: 'Authored', series: [] }))
    const orphan = await seedWork(t.db, { title: 'Anonymous', authors: [] })
    expect(await keys('no_author')).toEqual([orphan.workId])
  })

  it('no_length: per edition, pages for print and ebook, duration for audio', async () => {
    const work = await createWork(t.db, workInput({
      title: 'Lengths', series: [],
      editions: [{ format: 'physical', pageCount: 300 }, { format: 'ebook' }, { format: 'audiobook', durationSec: 3600 }, { format: 'audiobook' }],
    }))
    const rows = await editionsOf(work)
    const flagged = rows.filter((e) => (e.format === 'ebook' && e.pageCount === null) || (e.format === 'audiobook' && e.durationSec === null)).map((e) => e.id)
    expect((await keys('no_length')).sort()).toEqual(flagged.sort())
    const items = await list('no_length')
    expect(items[0]).toMatchObject({ check: 'no_length', work: { id: work, title: 'Lengths' }, edition: { volume: null } })
  })

  it('orders rows by sort title and pages with more', async () => {
    const b = await createWork(t.db, workInput({ title: 'The Beta', series: [] }))
    const a = await createWork(t.db, workInput({ title: 'Alpha', series: [] }))
    expect(await keys('no_isbn')).toEqual([a, b])
    expect(await listHealth(t.db, { check: 'no_isbn', today: TODAY, limit: 1, showIgnored: false })).toMatchObject({ more: true, items: [{ key: a }] })
  })

  it('ignore hides a row from the list and the count; showIgnored lists only ignored rows; unignore brings it back', async () => {
    const admin = await seedUser(t.db, { role: 'admin' })
    const one = await createWork(t.db, workInput({ title: 'One', series: [] }))
    const two = await createWork(t.db, workInput({ title: 'Two', series: [] }))
    expect((await healthCounts(t.db, { today: TODAY })).no_isbn).toBe(2)
    await ignoreHealth(t.db, admin.id, { check: 'no_isbn', subjectKey: one })
    await ignoreHealth(t.db, admin.id, { check: 'no_isbn', subjectKey: one }) // twice is fine
    expect(await keys('no_isbn')).toEqual([two])
    expect(await keys('no_isbn', true)).toEqual([one])
    expect((await healthCounts(t.db, { today: TODAY })).no_isbn).toBe(1)
    // an ignore belongs to one check only
    expect((await keys('no_cover')).sort()).toEqual([one, two].sort())
    await unignoreHealth(t.db, { check: 'no_isbn', subjectKey: one })
    expect((await keys('no_isbn')).sort()).toEqual([one, two].sort())
  })

  it('counts every check, zero when nothing is wrong', async () => {
    const counts = await healthCounts(t.db, { today: TODAY })
    expect(counts).toEqual({ no_cover: 0, no_isbn: 0, no_author: 0, no_length: 0, duplicates: 0, empty_series: 0, series_gaps: 0, long_loans: 0, kind_suggestions: 0, abs_out_of_sync: 0 })
    expect(await list('no_cover')).toEqual([])
  })

  it('kind_suggestions: unlocked books that look like fanfiction or a web serial, fanfiction signals first', async () => {
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    const describeWork = async (workId: string, description: string, externalId: string) => {
      const [edition] = await editionsOf(workId)
      await t.db.insert(sourceItems).values({
        sourceId: source?.id ?? '', externalId, editionId: edition?.id ?? null, contentHash: externalId,
        normalized: { externalId, format: 'ebook', title: 'x', authors: [], description, tags: [] } as never,
      })
    }
    const tts = await createWork(t.db, workInput({ title: 'Tts', series: [] }))
    await describeWork(tts, 'Narrated with epub2tts-vibevoice', 'a')
    const hog = await createWork(t.db, workInput({ title: 'Losing Hogwarts', authors: ['Some Fan'], series: [] }))
    const rr = await createWork(t.db, workInput({ title: 'Serial', series: [] }))
    await describeWork(rr, 'originally published on Royal Road', 'b')
    const ao3 = await createWork(t.db, workInput({ title: 'Linked', series: [] }))
    await describeWork(ao3, 'Text found here: http://archiveofourown.org/works/189189/', 'd')
    const both = await createWork(t.db, workInput({ title: 'Both', series: [] }))
    await describeWork(both, 'epub2tts, from Royal Road', 'c')
    await createWork(t.db, workInput({ title: 'Harry Potter and the Goblet of Fire', authors: ['J.K. Rowling'], series: [] }))
    await createWork(t.db, workInput({ title: 'Plain', series: [] }))
    await createWork(t.db, workInput({ title: 'Already', kind: 'fanfiction', description: 'epub2tts', series: [] }))
    const locked = await createWork(t.db, workInput({ title: 'Locked Hogwarts', series: [] }))
    await updateWork(t.db, admin, locked, { kind: 'book' })
    const bySeries = await createWork(t.db, workInput({ title: 'Plain Title', series: [{ name: 'Hogwarts Legacy', position: 1 }] }))
    await createWork(t.db, workInput({ title: 'Draconic Rising', series: [] }))
    const draco = await createWork(t.db, workInput({ title: 'Draco in Winter', series: [] }))
    const items = await list('kind_suggestions')
    expect(items.map((i) => [i.key, 'suggested' in i ? i.suggested : null])).toEqual([
      [both, 'fanfiction'], [draco, 'fanfiction'], [ao3, 'fanfiction'], [hog, 'fanfiction'], [bySeries, 'fanfiction'], [rr, 'web_serial'], [tts, 'fanfiction'],
    ])
    expect(items.find((i) => i.key === hog)).toEqual({ check: 'kind_suggestions', key: hog, work: { id: hog, title: 'Losing Hogwarts' }, suggested: 'fanfiction' })
    expect((await healthCounts(t.db, { today: TODAY })).kind_suggestions).toBe(7)
  })

  it('dismissKindSuggestion locks the book as Book and drops the row', async () => {
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const id = await createWork(t.db, workInput({ title: 'Founding Hogwarts', series: [] }))
    await createWork(t.db, workInput({ title: 'Losing Hogwarts', series: [] }))
    expect((await healthCounts(t.db, { today: TODAY })).kind_suggestions).toBe(2)
    await dismissKindSuggestion(t.db, admin, id)
    const detail = await getWorkDetail(t.db, admin, id)
    expect(detail.kind).toBe('book')
    expect(detail.provenance.kind?.locked).toBe(true)
    expect(await keys('kind_suggestions')).not.toContain(id)
    expect((await healthCounts(t.db, { today: TODAY })).kind_suggestions).toBe(1)
  })
})

describe('data health: duplicates, series, loans', () => {
  const t = useTestDb()
  const list = async (check: SqlHealthCheck) => (await listHealth(t.db, { check, today: TODAY, limit: 50, showIgnored: false })).items

  it('duplicates: equal titles always; similar titles only with a shared author; each pair once', async () => {
    // a and b: similar titles ("the way of kings" / "way of kings"), same default author (Brandon Sanderson)
    const a = await createWork(t.db, workInput({ title: 'The Way of Kings', series: [] }))
    const b = await createWork(t.db, workInput({ title: 'Way of Kings', series: [] }))
    // similar to both but by someone else, and not an exact match ("way of kings the"): no pair
    await createWork(t.db, workInput({ title: 'Way of Kings, The', authors: ['Someone Else'], series: [] }))
    const items = await list('duplicates')
    expect(items.map((i) => i.key)).toEqual([pairKey(a, b)])
    const [first, second] = [a, b].sort()
    expect(items[0]).toMatchObject({ check: 'duplicates', works: [{ id: first }, { id: second }] })
    // ignoring the pair sticks, whichever way round it was found
    const admin = await seedUser(t.db, { role: 'admin' })
    await ignoreHealth(t.db, admin.id, { check: 'duplicates', subjectKey: pairKey(b, a) })
    expect(await list('duplicates')).toEqual([])
  })

  it('duplicates: the same title by different authors still pairs; different titles by different authors do not', async () => {
    const x = await createWork(t.db, workInput({ title: 'Emma', authors: ['Jane Austen'], series: [] }))
    const y = await createWork(t.db, workInput({ title: 'Emma', authors: ['Someone Else'], series: [] }))
    await createWork(t.db, workInput({ title: 'Persuasion', authors: ['Third Writer'], series: [] }))
    expect((await list('duplicates')).map((i) => i.key)).toEqual([pairKey(x, y)])
  })

  it('duplicates: similar titles in one series, or with different numbers, are not pairs (#114)', async () => {
    await createWork(t.db, workInput({ title: 'Blood of Liscor', series: [{ name: 'The Wandering Inn', position: 2 }] }))
    await createWork(t.db, workInput({ title: 'Rains of Liscor', series: [{ name: 'The Wandering Inn', position: 3 }] }))
    await createWork(t.db, workInput({ title: 'Beware of Chicken 2', series: [] }))
    await createWork(t.db, workInput({ title: 'Beware of Chicken 3', series: [] }))
    expect(await list('duplicates')).toEqual([])
    // the same title in one series is still a pair
    const x = await createWork(t.db, workInput({ title: 'Rains of Liscor', series: [{ name: 'The Wandering Inn', position: 4 }] }))
    expect((await list('duplicates')).map((i) => i.key)).toHaveLength(1)
    expect((await list('duplicates'))[0]?.key).toContain(x)
  })

  it('empty_series lists a series with no books; deleteEmptySeries deletes it, refuses one with books', async () => {
    const [lonely] = await t.db.insert(series).values({ name: 'Lonely', normalizedName: 'lonely' }).returning()
    await createWork(t.db, workInput({ title: 'In a series', series: [{ name: 'Busy', position: 1 }] }))
    const busy = (await t.db.select().from(series).where(eq(series.normalizedName, 'busy')))[0]
    expect(await list('empty_series')).toEqual([{ check: 'empty_series', key: lonely?.id, series: { id: lonely?.id, name: 'Lonely' } }])
    await expect(deleteEmptySeries(t.db, busy?.id ?? '')).rejects.toMatchObject({ code: 'CONFLICT' })
    await deleteEmptySeries(t.db, lonely?.id ?? '')
    expect(await list('empty_series')).toEqual([])
    await expect(deleteEmptySeries(t.db, '00000000-0000-4000-8000-000000000009')).rejects.toBeInstanceOf(DomainError)
  })

  it('series_gaps: missing whole numbers up to the highest; fractional and null positions skipped; capped at 1000', async () => {
    for (const [title, position] of [['One', 1], ['Two', 2], ['Four', 4], ['Novella', 2.5], ['Unnumbered', null]] as const) {
      await createWork(t.db, workInput({ title, series: [{ name: 'Gappy', position }] }))
    }
    await createWork(t.db, workInput({ title: 'Whole 1', series: [{ name: 'Whole', position: 1 }] }))
    await createWork(t.db, workInput({ title: 'Whole 2', series: [{ name: 'Whole', position: 2 }] }))
    await createWork(t.db, workInput({ title: 'Typo', series: [{ name: 'Typo series', position: 20001 }] }))
    const items = await list('series_gaps')
    expect(items.map((i) => (i.check === 'series_gaps' ? [i.series.name, i.missing.length, i.missing.slice(0, 3)] : null))).toEqual([
      ['Gappy', 1, [3]],
      ['Typo series', 1000, [1, 2, 3]],
    ])
  })

  it('series_gaps: a range fills its whole numbers and can be the highest (#122)', async () => {
    for (const [title, position, positionEnd] of [['Pack', 1, 2], ['Three', 3, null], ['Four', 4, null]] as const) {
      await createWork(t.db, workInput({ title, series: [{ name: 'Mage Errant', position, positionEnd }] }))
    }
    for (const [title, position, positionEnd] of [['Pack B', 1, 2], ['Four B', 4, null]] as const) {
      await createWork(t.db, workInput({ title, series: [{ name: 'Holey', position, positionEnd }] }))
    }
    await createWork(t.db, workInput({ title: 'Tail pack', series: [{ name: 'Tail', position: 1, positionEnd: 3 }] }))
    await createWork(t.db, workInput({ title: 'Half', series: [{ name: 'Halves', position: 1.5, positionEnd: 3 }] }))
    expect((await list('series_gaps')).map((i) => (i.check === 'series_gaps' ? [i.series.name, i.missing] : null))).toEqual([
      ['Halves', [1]],
      ['Holey', [3]],
    ])
  })

  it('series_gaps counts the books with no number, so the row can say why a number looks missing (#123)', async () => {
    for (const [title, position] of [['Third', 3], ['Loose A', null], ['Loose B', null]] as const) {
      await createWork(t.db, workInput({ title, series: [{ name: 'Half numbered', position }] }))
    }
    await createWork(t.db, workInput({ title: 'Only loose', series: [{ name: 'All loose', position: null }] }))
    expect(await list('series_gaps')).toMatchObject([{ series: { name: 'Half numbered' }, missing: [1, 2], unnumbered: 2 }])
  })

  it('long_loans: past due, or open over 90 days with no due date; returned loans never', async () => {
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const work = await createWork(t.db, workInput({ title: 'Lent', series: [], editions: [{ format: 'physical' }, { format: 'physical' }, { format: 'physical' }, { format: 'physical' }] }))
    const [e1, e2, e3, e4] = (await t.db.select().from(editions).where(eq(editions.workId, work))).map((e) => e.id)
    const overdue = await createLoan(t.db, admin, { editionId: e1 ?? '', borrowerUserId: null, borrowerName: 'Dana', lentOn: '2026-09-01', dueOn: '2026-10-17' })
    await createLoan(t.db, admin, { editionId: e2 ?? '', borrowerUserId: null, borrowerName: 'Eli', lentOn: '2026-09-01', dueOn: '2026-10-18' })
    const old = await createLoan(t.db, admin, { editionId: e3 ?? '', borrowerUserId: null, borrowerName: 'Fay', lentOn: '2026-07-19', dueOn: null })
    const back = await createLoan(t.db, admin, { editionId: e4 ?? '', borrowerUserId: null, borrowerName: 'Gil', lentOn: '2026-01-01', dueOn: '2026-02-01' })
    await t.db.update(loans).set({ returnedOn: '2026-02-01' }).where(eq(loans.id, back))
    const items = await list('long_loans')
    // 2026-07-19 is exactly 91 days before 2026-10-18; ordered by lent date
    expect(items.map((i) => i.key)).toEqual([old, overdue])
    expect(items[1]).toMatchObject({ check: 'long_loans', work: { id: work, title: 'Lent' }, loan: { id: overdue, borrower: 'Dana', lentOn: '2026-09-01', dueOn: '2026-10-17' } })
    // the same loans counted from an earlier "today": nothing is long yet
    expect((await healthCounts(t.db, { today: '2026-09-02' })).long_loans).toBe(0)
  })
})
