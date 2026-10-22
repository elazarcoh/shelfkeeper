import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { CSV_MAX_ROWS, CsvImportInput, DomainError, ExternalItem } from '@mylib/domain'
import { dailyStats, editions, proposals, readingSessions, sourceItems, sources, userHiddenWorks, userWorks } from '../schema'
import { seedSession, seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail } from './catalog'
import { acceptMineExact, createMineUnmatched, importCsv, listMyProposals, resolveMyProposal } from './csv-import'
import { countInbox, listInbox } from './inbox'
import * as match from './match'
import { listSessionsForWork } from './reading-sessions'
import { loadUserScope } from './scope'
import * as stats from './stats'
import { rebuildDailyStats } from './stats'
import * as tracking from './tracking'
import { setRating, setStatus } from './tracking'

const csvInput = (over: Partial<Record<string, unknown>> = {}) =>
  CsvImportInput.parse({
    fileName: 'goodreads.csv',
    header: ['Title', 'Author', 'ISBN13', 'My Rating', 'Date Read'],
    rows: [
      ['Project Hail Mary', 'Andy Weir', '="9780593135204"', '5', '2023/05/14'],
      ['', 'Nobody', '', '', ''],
      ['The Martian', 'Andy Weir', '', '4', ''],
    ],
    mapping: { columns: { title: 0, authors: 1, isbn: 2, rating: 3, finishedOn: 4 } },
    ownership: 'owned',
    // a fresh file pick each time, unless a test says otherwise
    importId: randomUUID(),
    ...over,
  })

describe('importCsv', () => {
  const t = useTestDb()

  it('creates a one-shot CSV source owned by the importer and one user-scoped proposal per valid row', async () => {
    const member = await seedUser(t.db)
    const scope = await loadUserScope(t.db, member)
    const result = await importCsv(t.db, scope, csvInput())
    expect(result).toMatchObject({ proposals: 2, invalid: [{ row: 3, message: 'Row 3: no title' }] })

    const [source] = await t.db.select().from(sources).where(eq(sources.id, result.sourceId))
    expect(source).toMatchObject({ kind: 'csv', name: 'CSV: goodreads.csv', schedule: null, config: { kind: 'csv', ownerUserId: member.id, fileName: 'goodreads.csv' } })
    expect(await t.db.select({ externalId: sourceItems.externalId, state: sourceItems.state }).from(sourceItems)).toEqual([
      { externalId: 'row:2', state: 'pending' },
      { externalId: 'row:4', state: 'pending' },
    ])
    const rows = await t.db.select().from(proposals)
    expect(rows.map((p) => [p.kind, p.scope, p.userId, p.createdBy, p.status])).toEqual([
      ['new_work', 'user', member.id, 'csv', 'pending'],
      ['new_work', 'user', member.id, 'csv', 'pending'],
    ])
    expect(rows[0]?.payload).toMatchObject({ read: { finishedOn: '2023-05-14', finishedPrecision: 'day' }, rating: 5, ownership: 'owned', item: { format: 'physical' } })
  })

  it('stores candidates, so a row whose ISBN is already in the catalog is an exact match', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Hail Mary', series: [], editions: [{ format: 'ebook', isbn13: '9780593135204' }] }))
    await importCsv(t.db, scope, csvInput())
    const [first] = await t.db.select({ candidates: proposals.candidates }).from(proposals).where(eq(proposals.createdBy, 'csv')).limit(1)
    expect(first?.candidates[0]).toMatchObject({ workId, basis: 'identifier' })
  })

  it('runs an import once: the same file pick sent again answers with the first result', async () => {
    const member = await seedUser(t.db)
    const scope = await loadUserScope(t.db, member)
    const input = csvInput({ importId: '44444444-4444-4444-8444-444444444444' })
    const first = await importCsv(t.db, scope, input)
    expect(first).toMatchObject({ proposals: 2, alreadyImported: false })
    const [source] = await t.db.select({ config: sources.config }).from(sources)
    expect(source?.config).toMatchObject({ importId: '44444444-4444-4444-8444-444444444444' })

    expect(await importCsv(t.db, scope, input)).toEqual({ sourceId: first.sourceId, proposals: 2, invalid: [], alreadyImported: true })
    expect(await t.db.select().from(sources)).toHaveLength(1)
    expect(await t.db.select().from(proposals)).toHaveLength(2)

    // another person's import with the same id is theirs, not mine
    const other = await loadUserScope(t.db, await seedUser(t.db))
    expect(await importCsv(t.db, other, input)).toMatchObject({ alreadyImported: false })
  })

  it('creates exactly one source when the same import arrives twice at once', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const input = csvInput({ importId: '55555555-5555-4555-8555-555555555555' })
    const results = await Promise.all([importCsv(t.db, scope, input), importCsv(t.db, scope, input)])
    expect(results.map((r) => r.alreadyImported).sort()).toEqual([false, true])
    expect(new Set(results.map((r) => r.sourceId)).size).toBe(1)
    expect(await t.db.select().from(sources)).toHaveLength(1)
    expect(await t.db.select().from(proposals)).toHaveLength(2)
  })

  it('numbers rows by their real file line when the client sends them', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const result = await importCsv(t.db, scope, csvInput({ lines: [2, 5, 9] }))
    expect(result.invalid).toEqual([{ row: 5, message: 'Row 5: no title' }])
    expect((await t.db.select({ externalId: sourceItems.externalId }).from(sourceItems)).map((r) => r.externalId).sort()).toEqual(['row:2', 'row:9'])
  })

  it('refuses a mapping that yields no book at all', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await expect(importCsv(t.db, scope, csvInput({ rows: [['', 'x', '', '', '']] }))).rejects.toMatchObject({ code: 'INVALID' })
    expect(await t.db.select().from(sources)).toEqual([])
  })

  it('never offers the importer a work hidden from them as a candidate, but still offers one they can see', async () => {
    const member = await seedUser(t.db)
    const hiddenWorkId = await createWork(t.db, workInput({ title: 'Duplicate Title', series: [], editions: [{ format: 'physical' }] }))
    const visibleWorkId = await createWork(t.db, workInput({ title: 'Duplicate Title', series: [], editions: [{ format: 'physical' }] }))
    await t.db.insert(userHiddenWorks).values({ userId: member.id, workId: hiddenWorkId })
    const scope = await loadUserScope(t.db, member)

    await importCsv(t.db, scope, csvInput({ rows: [['Duplicate Title', 'Andy Weir', '', '', '']] }))

    const [row] = await t.db.select({ candidates: proposals.candidates }).from(proposals).where(eq(proposals.createdBy, 'csv')).limit(1)
    const candidateIds = row?.candidates.map((c) => c.workId) ?? []
    expect(candidateIds).toContain(visibleWorkId)
    expect(candidateIds).not.toContain(hiddenWorkId)
  })

  it('rolls back the whole import — source, items and proposals — when a later row fails after earlier rows already succeeded', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const spy = vi
      .spyOn(match, 'findCandidates')
      .mockResolvedValueOnce([]) // row 1 (row:2) succeeds
      .mockRejectedValueOnce(new Error('boom')) // row 2 (row:3) fails
    try {
      await expect(
        importCsv(
          t.db,
          scope,
          csvInput({
            rows: [
              ['Project Hail Mary', 'Andy Weir', '', '', ''],
              ['The Martian', 'Andy Weir', '', '', ''],
            ],
          }),
        ),
      ).rejects.toThrow('boom')
    } finally {
      spy.mockRestore()
    }
    expect(await t.db.select().from(sources)).toEqual([])
    expect(await t.db.select().from(sourceItems)).toEqual([])
    expect(await t.db.select().from(proposals)).toEqual([])
  })

  it(
    `imports the maximum ${CSV_MAX_ROWS} rows as one transaction in a reasonable time`,
    async () => {
      const scope = await loadUserScope(t.db, await seedUser(t.db))
      const rows = Array.from({ length: CSV_MAX_ROWS }, (_, i) => [`Book number ${i}`, 'Author', '', '', ''])
      const start = performance.now()
      const result = await importCsv(t.db, scope, csvInput({ rows }))
      const elapsedMs = performance.now() - start
      console.log(`importCsv: ${CSV_MAX_ROWS} rows took ${elapsedMs.toFixed(0)}ms`)
      expect(result).toMatchObject({ proposals: CSV_MAX_ROWS, invalid: [] })
      expect(await t.db.select({ n: sourceItems.id }).from(sourceItems)).toHaveLength(CSV_MAX_ROWS)
    },
    120_000,
  )
})

describe('my import proposals', () => {
  const t = useTestDb()
  const TODAY = '2026-01-05'

  async function importAs(role: 'member' | 'admin' = 'member', over: Record<string, unknown> = {}) {
    const user = await seedUser(t.db, { role })
    const scope = await loadUserScope(t.db, user)
    await importCsv(t.db, scope, csvInput(over))
    return { user, scope }
  }

  it('lists only my own import proposals, never in the admin Inbox', async () => {
    const { scope } = await importAs()
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    expect((await listMyProposals(t.db, scope)).items.map((p) => p.item.title)).toEqual(['Project Hail Mary', 'The Martian'])
    expect((await listMyProposals(t.db, scope)).items[0]).toMatchObject({ fileName: 'CSV: goodreads.csv', read: { finishedOn: '2023-05-14' }, rating: 5, ownership: 'owned' })
    expect((await listMyProposals(t.db, admin)).items).toEqual([])
    expect((await listInbox(t.db, admin)).total).toBe(0)
    expect(await countInbox(t.db, scope)).toBe(2)
    expect(await countInbox(t.db, admin)).toBe(0)
  })

  it('lists only CSV proposals, whatever else is filed for me', async () => {
    const { user, scope } = await importAs()
    const [other] = await t.db.insert(sources).values({ kind: 'manual', name: 'Manual', config: {}, schedule: null }).returning({ id: sources.id })
    const item = ExternalItem.parse({ externalId: 'not-a-row', format: 'physical', title: 'Elsewhere' })
    const [si] = await t.db
      .insert(sourceItems)
      .values({ sourceId: other?.id ?? '', externalId: 'not-a-row', normalized: item, contentHash: 'x' })
      .returning({ id: sourceItems.id })
    await t.db.insert(proposals).values({ kind: 'new_work', payload: {}, candidates: [], scope: 'user', userId: user.id, createdBy: 'sync', sourceItemId: si?.id ?? null })
    const listed = await listMyProposals(t.db, scope)
    expect(listed.items.map((p) => p.item.title)).toEqual(['Project Hail Mary', 'The Martian'])
    expect(listed).toMatchObject({ total: 2, unmatched: 2 })
  })

  it('never lists or resolves another user\'s proposal for an admin either — NOT_FOUND, not FORBIDDEN', async () => {
    const { scope } = await importAs()
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const [first] = (await listMyProposals(t.db, scope)).items
    expect((await listMyProposals(t.db, admin)).items).toEqual([])
    await expect(resolveMyProposal(t.db, admin, first?.id ?? '', { action: 'create_work' }, TODAY)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('excludes a candidate from listMyProposals once it becomes hidden from me, even though it was visible at import time', async () => {
    const workId = await createWork(t.db, workInput({ title: 'Project Hail Mary', series: [], editions: [{ format: 'ebook', isbn13: '9780593135204' }] }))
    const { user, scope } = await importAs()
    const before = (await listMyProposals(t.db, scope)).items.find((p) => p.item.title === 'Project Hail Mary')
    expect(before?.candidates[0]).toMatchObject({ workId })

    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId })
    const fresh = await loadUserScope(t.db, user)
    const after = (await listMyProposals(t.db, fresh)).items.find((p) => p.item.title === 'Project Hail Mary')
    expect(after?.candidates.map((c) => c.workId)).not.toContain(workId)
  })

  it('creates the book, my finished read and my rating when I accept', async () => {
    const { scope } = await importAs()
    const [first] = (await listMyProposals(t.db, scope)).items
    const { workId } = await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'create_work' }, TODAY)
    const detail = await getWorkDetail(t.db, scope, workId ?? '')
    expect(detail).toMatchObject({ title: 'Project Hail Mary', availability: 'owned', me: { status: 'read', rating: 5 } })
    expect(detail.editions[0]).toMatchObject({ format: 'physical', isbn13: '9780593135204', history: [{ type: 'acquired', occurredOn: TODAY, origin: 'manual' }] })
    const sessions = await listSessionsForWork(t.db, scope, workId ?? '')
    expect(sessions).toMatchObject([{ outcome: 'finished', mode: 'read', startedOn: '2023-05-14', finishedOn: '2023-05-14', finishedPrecision: 'day', editionId: detail.editions[0]?.id, isReread: false }])
    expect(await countInbox(t.db, scope)).toBe(1)
  })

  it('records "read, not owned" as a returned borrowed copy', async () => {
    const { scope } = await importAs('member', { ownership: 'read_not_owned' })
    const [first] = (await listMyProposals(t.db, scope)).items
    const { workId } = await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'create_work' }, TODAY)
    const detail = await getWorkDetail(t.db, scope, workId ?? '')
    expect(detail.availability).toBe('not_owned')
    expect(detail.editions[0]).toMatchObject({ ownership: 'borrowed', inPossession: false, history: [{ type: 'returned', occurredOn: TODAY }] })
  })

  it('only records my read on a book already in the catalog, at the file\'s precision', async () => {
    const { scope } = await importAs('member', { rows: [['Dune', 'Frank Herbert', '', '4', '2019-03']] })
    const workId = await createWork(t.db, workInput({ title: 'Dune', series: [], editions: [{ format: 'physical' }] }))
    const [first] = (await listMyProposals(t.db, scope)).items
    await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'track_only', workId }, TODAY)
    expect((await getWorkDetail(t.db, scope, workId)).editions).toHaveLength(1)
    expect(await listSessionsForWork(t.db, scope, workId)).toMatchObject([{ startedOn: '2019-03-01', startedPrecision: 'month', finishedOn: '2019-03-01', finishedPrecision: 'month' }])
  })

  it('never overwrites a rating I already gave myself, but does record a first rating (R16)', async () => {
    const { scope } = await importAs('member', { rows: [['Dune', 'Frank Herbert', '', '5', '2019-03']] })
    const workId = await createWork(t.db, workInput({ title: 'Dune', series: [], editions: [{ format: 'physical' }] }))
    await setRating(t.db, scope, workId, 3)
    const [before] = await t.db.select({ rating: userWorks.rating, ratedAt: userWorks.ratedAt }).from(userWorks).where(and(eq(userWorks.userId, scope.userId), eq(userWorks.workId, workId)))

    const [first] = (await listMyProposals(t.db, scope)).items
    await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'track_only', workId }, TODAY)

    const [after] = await t.db.select({ rating: userWorks.rating, ratedAt: userWorks.ratedAt }).from(userWorks).where(and(eq(userWorks.userId, scope.userId), eq(userWorks.workId, workId)))
    expect(after).toEqual({ rating: 3, ratedAt: before?.ratedAt })
  })

  it('marks a read a reread only when it truly follows an earlier finished session, not merely any prior one', async () => {
    const { scope } = await importAs('member', { rows: [['Dune', 'Frank Herbert', '', '', '2019-06-01']] })
    const workId = await createWork(t.db, workInput({ title: 'Dune', series: [], editions: [{ format: 'physical' }] }))
    // an existing session already finished in 2023 — chronologically AFTER the row being imported
    await t.db.insert(readingSessions).values({
      userId: scope.userId,
      workId,
      mode: 'read',
      startedOn: '2023-01-01',
      startedPrecision: 'day',
      finishedOn: '2023-01-10',
      finishedPrecision: 'day',
      outcome: 'finished',
      fractionCompleted: 1,
      isReread: false,
    })

    const [first] = (await listMyProposals(t.db, scope)).items
    await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'track_only', workId }, TODAY)

    const sessions = await listSessionsForWork(t.db, scope, workId)
    expect(sessions.find((s) => s.finishedOn === '2019-06-01')).toMatchObject({ isReread: false })
    // the pre-existing 2023 session is untouched — its own isReread is not retroactively rewritten
    expect(sessions.find((s) => s.finishedOn === '2023-01-10')).toMatchObject({ isReread: false })
  })

  it('does not record the same read twice when a file is imported again', async () => {
    const { scope } = await importAs()
    const [first] = (await listMyProposals(t.db, scope)).items
    const { workId } = await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'create_work' }, TODAY)
    await importCsv(t.db, scope, csvInput())
    const again = (await listMyProposals(t.db, scope)).items.find((p) => p.item.title === 'Project Hail Mary' && p.id !== first?.id)
    expect(again?.candidates[0]).toMatchObject({ workId, basis: 'identifier' })
    await resolveMyProposal(t.db, scope, again?.id ?? '', { action: 'track_only', workId: workId ?? '' }, TODAY)
    expect(await listSessionsForWork(t.db, scope, workId ?? '')).toHaveLength(1)
  })

  describe('shelves', () => {
    const shelfInput = (rows: string[][]) => ({
      header: ['Title', 'Author', 'Date Read', 'Exclusive Shelf'],
      rows,
      mapping: { columns: { title: 0, authors: 1, finishedOn: 2, shelf: 3 } },
    })
    const statusOf = async (userId: string, workId: string) =>
      (await t.db.select({ status: userWorks.status }).from(userWorks).where(and(eq(userWorks.userId, userId), eq(userWorks.workId, workId))))[0]?.status

    it('marks a read-shelf row without a date as read, with no session', async () => {
      const { scope } = await importAs('member', shelfInput([['Dune', 'Frank Herbert', '', 'read']]))
      const [first] = (await listMyProposals(t.db, scope)).items
      expect(first).toMatchObject({ shelf: 'read', read: null })
      const { workId } = await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'create_work' }, TODAY)
      expect(await statusOf(scope.userId, workId ?? '')).toBe('read')
      expect(await listSessionsForWork(t.db, scope, workId ?? '')).toEqual([])
      expect((await getWorkDetail(t.db, scope, workId ?? '')).editions).toHaveLength(1)
    })

    it('marks a currently-reading row as reading, with no session', async () => {
      const { scope } = await importAs('member', shelfInput([['Dune', 'Frank Herbert', '', 'currently-reading']]))
      const [first] = (await listMyProposals(t.db, scope)).items
      const { workId } = await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'create_work' }, TODAY)
      expect(await statusOf(scope.userId, workId ?? '')).toBe('reading')
      expect(await listSessionsForWork(t.db, scope, workId ?? '')).toEqual([])
    })

    it('adds a to-read row as a wanted book: want_to_read, no edition, no copy', async () => {
      const { scope } = await importAs('member', shelfInput([['Dune', 'Frank Herbert', '', 'to-read']]))
      const [first] = (await listMyProposals(t.db, scope)).items
      const { workId } = await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'create_work' }, TODAY)
      expect(await statusOf(scope.userId, workId ?? '')).toBe('want_to_read')
      const detail = await getWorkDetail(t.db, scope, workId ?? '')
      expect(detail.editions).toEqual([])
      expect(await t.db.select().from(editions)).toEqual([])
      expect(await t.db.select({ state: sourceItems.state, workId: sourceItems.workId, editionId: sourceItems.editionId }).from(sourceItems)).toEqual([
        { state: 'linked', workId, editionId: null },
      ])
    })

    it('never adds a copy for a to-read row linked to a book already in the catalog', async () => {
      const { scope } = await importAs('member', shelfInput([['Dune', 'Frank Herbert', '', 'to-read']]))
      const workId = await createWork(t.db, workInput({ title: 'Dune', series: [], editions: [{ format: 'physical' }] }))
      const [first] = (await listMyProposals(t.db, scope)).items
      await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'link_new_edition', workId }, TODAY)
      expect((await getWorkDetail(t.db, scope, workId)).editions).toHaveLength(1)
      expect(await statusOf(scope.userId, workId)).toBe('want_to_read')
    })

    it('never overwrites a status I already have on the book', async () => {
      const { scope } = await importAs('member', shelfInput([['Dune', 'Frank Herbert', '', 'to-read']]))
      const workId = await createWork(t.db, workInput({ title: 'Dune', series: [], editions: [{ format: 'physical' }] }))
      await setStatus(t.db, scope, workId, 'abandoned')
      const [first] = (await listMyProposals(t.db, scope)).items
      await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'track_only', workId }, TODAY)
      expect(await statusOf(scope.userId, workId)).toBe('abandoned')
    })

    it('records a dated read as before, whatever the shelf says', async () => {
      const { scope } = await importAs('member', shelfInput([['Dune', 'Frank Herbert', '2020-02-02', 'read']]))
      const [first] = (await listMyProposals(t.db, scope)).items
      const { workId } = await resolveMyProposal(t.db, scope, first?.id ?? '', { action: 'create_work' }, TODAY)
      expect(await statusOf(scope.userId, workId ?? '')).toBe('read')
      expect(await listSessionsForWork(t.db, scope, workId ?? '')).toMatchObject([{ outcome: 'finished', finishedOn: '2020-02-02' }])
    })
  })

  it('refuses another person\'s proposal, books hidden from me, and a second resolution', async () => {
    const { user, scope } = await importAs()
    const other = await loadUserScope(t.db, await seedUser(t.db))
    const [first, second] = (await listMyProposals(t.db, scope)).items
    await expect(resolveMyProposal(t.db, other, first?.id ?? '', { action: 'create_work' }, TODAY)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const hidden = await createWork(t.db, workInput({ title: 'Hidden', series: [] }))
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId: hidden })
    const fresh = await loadUserScope(t.db, user)
    await expect(resolveMyProposal(t.db, fresh, second?.id ?? '', { action: 'track_only', workId: hidden }, TODAY)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const results = await Promise.allSettled([
      resolveMyProposal(t.db, fresh, first?.id ?? '', { action: 'create_work' }, TODAY),
      resolveMyProposal(t.db, fresh, first?.id ?? '', { action: 'create_work' }, TODAY),
    ])
    expect(results.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { code: 'CONFLICT' } }])
    const fulfilled = results.find((r): r is PromiseFulfilledResult<{ workId: string | null; sourceId: string }> => r.status === 'fulfilled')
    expect(await listSessionsForWork(t.db, fresh, fulfilled?.value.workId ?? '')).toHaveLength(1)
  })
})

describe('bulk actions for my imports', () => {
  const t = useTestDb()
  const TODAY = '2026-01-05'
  const HAIL_MARY = '9780593135204'
  const MARTIAN = '9780553418026'

  const bulkInput = (rows: string[][]) =>
    csvInput({ header: ['Title', 'Author', 'ISBN13', 'My Rating', 'Date Read'], rows, mapping: { columns: { title: 0, authors: 1, isbn: 2, rating: 3, finishedOn: 4 } } })

  it('links my exact matches to the matched copy — mine only, never another person\'s', async () => {
    const workId = await createWork(t.db, workInput({ title: 'Project Hail Mary', series: [], editions: [{ format: 'physical', isbn13: HAIL_MARY }] }))
    const ebookWork = await createWork(t.db, workInput({ title: 'The Martian', series: [], editions: [{ format: 'ebook', isbn13: MARTIAN }] }))
    const me = await loadUserScope(t.db, await seedUser(t.db))
    const other = await loadUserScope(t.db, await seedUser(t.db))
    const rows = [
      ['Project Hail Mary', 'Andy Weir', HAIL_MARY, '5', '2023/05/14'],
      ['The Martian', 'Andy Weir', MARTIAN, '4', ''],
      ['Unmatched Book', 'Nobody', '', '', ''],
    ]
    await importCsv(t.db, me, bulkInput(rows))
    await importCsv(t.db, other, bulkInput(rows))
    expect(await listMyProposals(t.db, me)).toMatchObject({ exactMatches: 2, unmatched: 1 })

    expect(await acceptMineExact(t.db, me, TODAY)).toMatchObject({ accepted: 2, remaining: 0 })
    const mine = await t.db.select({ status: proposals.status, resolution: proposals.resolution }).from(proposals).where(eq(proposals.userId, me.userId))
    expect(mine.filter((r) => r.status === 'accepted').map((r) => (r.resolution as { action: string } | null)?.action).sort()).toEqual(['link_edition', 'track_only'])
    // the Martian in the catalog is an ebook, a different format: my read is recorded, no copy is added
    expect((await getWorkDetail(t.db, me, ebookWork)).editions).toHaveLength(1)
    expect((await getWorkDetail(t.db, me, workId)).me).toMatchObject({ status: 'read', rating: 5 })
    expect((await listMyProposals(t.db, other)).items).toHaveLength(3)
  })

  it('never accepts a candidate that is hidden from me', async () => {
    const workId = await createWork(t.db, workInput({ title: 'Project Hail Mary', series: [], editions: [{ format: 'physical', isbn13: HAIL_MARY }] }))
    const user = await seedUser(t.db)
    await importCsv(t.db, await loadUserScope(t.db, user), bulkInput([['Project Hail Mary', 'Andy Weir', HAIL_MARY, '5', '']]))
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId })
    const scope = await loadUserScope(t.db, user)
    expect(await listMyProposals(t.db, scope)).toMatchObject({ exactMatches: 0, unmatched: 1 })
    expect(await acceptMineExact(t.db, scope, TODAY)).toMatchObject({ accepted: 0, remaining: 0 })
    expect(await t.db.select({ status: proposals.status }).from(proposals)).toEqual([{ status: 'pending' }])
  })

  it('keeps a rating I already gave myself', async () => {
    const workId = await createWork(t.db, workInput({ title: 'Project Hail Mary', series: [], editions: [{ format: 'physical', isbn13: HAIL_MARY }] }))
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await setRating(t.db, scope, workId, 2)
    await importCsv(t.db, scope, bulkInput([['Project Hail Mary', 'Andy Weir', HAIL_MARY, '5', '']]))
    expect(await acceptMineExact(t.db, scope, TODAY)).toMatchObject({ accepted: 1, remaining: 0 })
    expect((await getWorkDetail(t.db, scope, workId)).me).toMatchObject({ rating: 2 })
  })

  it('pages past a row that keeps failing, so later rows still get done', async () => {
    const bad = await createWork(t.db, workInput({ title: 'Project Hail Mary', series: [], editions: [{ format: 'physical', isbn13: HAIL_MARY }] }))
    await createWork(t.db, workInput({ title: 'The Martian', series: [], editions: [{ format: 'physical', isbn13: MARTIAN }] }))
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await importCsv(
      t.db,
      scope,
      bulkInput([
        ['Project Hail Mary', 'Andy Weir', HAIL_MARY, '5', ''],
        ['The Martian', 'Andy Weir', MARTIAN, '4', ''],
      ]),
    )
    const real = tracking.setRating
    const spy = vi.spyOn(tracking, 'setRating').mockImplementation((db, s, workId, rating) => (workId === bad ? Promise.reject(new DomainError('CONFLICT', 'busy')) : real(db, s, workId, rating)))
    try {
      expect(await acceptMineExact(t.db, scope, TODAY, 1)).toMatchObject({ accepted: 1, remaining: 1 })
      expect(await acceptMineExact(t.db, scope, TODAY, 1)).toMatchObject({ accepted: 0, remaining: 1 })
    } finally {
      spy.mockRestore()
    }
    const rows = await t.db.select({ title: sql<string>`${proposals.payload}->'item'->>'title'`, status: proposals.status }).from(proposals)
    expect(Object.fromEntries(rows.map((r) => [r.title, r.status]))).toEqual({ 'Project Hail Mary': 'pending', 'The Martian': 'accepted' })
  })

  it('creates books for my unmatched rows, a to-read row as a wanted book, and rebuilds my stats once', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await importCsv(
      t.db,
      scope,
      csvInput({
        header: ['Title', 'Author', 'Date Read', 'Exclusive Shelf'],
        rows: [
          ['Dune', 'Frank Herbert', '2020-02-02', 'read'],
          ['Emma', 'Jane Austen', '2021-03-03', 'read'],
          ['Ulysses', 'James Joyce', '', 'to-read'],
        ],
        mapping: { columns: { title: 0, authors: 1, finishedOn: 2, shelf: 3 } },
      }),
    )
    const rebuild = vi.spyOn(stats, 'rebuildDailyStats')
    try {
      expect(await createMineUnmatched(t.db, scope, TODAY)).toMatchObject({ created: 3, skipped: 0, remaining: 0 })
      expect(rebuild).toHaveBeenCalledTimes(1)
    } finally {
      rebuild.mockRestore()
    }
    const wanted = await t.db.select({ workId: sourceItems.workId, editionId: sourceItems.editionId }).from(sourceItems).where(eq(sourceItems.externalId, 'row:4'))
    expect(wanted).toMatchObject([{ editionId: null }])
    expect((await getWorkDetail(t.db, scope, wanted[0]?.workId ?? '')).me).toMatchObject({ status: 'want_to_read' })
    expect(await t.db.select().from(editions)).toHaveLength(2)
  })

  it('leaves rows with a visible candidate for me to look at', async () => {
    await createWork(t.db, workInput({ title: 'Project Hail Mary', series: [], editions: [{ format: 'physical', isbn13: HAIL_MARY }] }))
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await importCsv(t.db, scope, bulkInput([['Project Hail Mary', 'Andy Weir', HAIL_MARY, '', '']]))
    expect(await createMineUnmatched(t.db, scope, TODAY)).toMatchObject({ created: 0, skipped: 0, remaining: 0 })
    expect(await t.db.select({ status: proposals.status }).from(proposals)).toEqual([{ status: 'pending' }])
  })

  it("accepting a row rebuilds only that book's days, not the importer's whole history", async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const oldListen = await createWork(t.db, workInput({ title: 'Old Listen', series: [], editions: [{ format: 'audiobook', durationSec: 36_000 }] }))
    await seedSession(t.db, { userId: scope.userId, workId: oldListen, mode: 'listen', startedOn: '2019-06-01', outcome: 'finished', finishedOn: '2019-06-01', fractionCompleted: 1 })
    await rebuildDailyStats(t.db, scope)
    await t.db.update(dailyStats).set({ minutes: 999 }).where(eq(dailyStats.date, '2019-06-01'))

    await createWork(t.db, workInput({ title: 'Project Hail Mary', series: [], editions: [{ format: 'physical', isbn13: HAIL_MARY }] }))
    await importCsv(t.db, scope, bulkInput([['Project Hail Mary', 'Andy Weir', HAIL_MARY, '5', '2023-05-14']]))
    expect(await acceptMineExact(t.db, scope, TODAY)).toMatchObject({ accepted: 1 })

    const [old] = await t.db.select({ minutes: dailyStats.minutes }).from(dailyStats).where(eq(dailyStats.date, '2019-06-01'))
    expect(old?.minutes).toBe(999)
  })
})
