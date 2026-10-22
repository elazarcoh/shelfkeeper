import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { CsvImportInput, ExternalItem, PageCapture, providerById, type ShelfRow } from '@mylib/domain'
import { editions, proposals, sourceItems, sources, userHiddenWorks, works } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail } from './catalog'
import { acceptMineExact, createMineUnmatched, importCsv, listMyProposals, resolveMyProposal } from './csv-import'
import { loadUserScope, type UserScope } from './scope'
import { addOneShelf, attachPage, cachedCapture, importShelf, loadSourceKind, previewShelf, unlinkPage } from './shelf'

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../domain/src/providers/fixtures/${name}.json`, import.meta.url), 'utf8'))
const translatorPrefix = fixture('simania-translator-prefix')
const authorPage = fixture('simania-author-page')
const only = (ids: string[]): string => ids[0] ?? ''

const row = (over: Partial<ShelfRow> = {}): ShelfRow => ({
  title: 'המושבה האבודה', subtitle: null, authors: ['אואן קולפר'], translators: [], publisher: 'כנרת', series: 'ארטמיס פאול', seriesNumber: null,
  language: 'he', spineText: null, originalTitle: 'Artemis Fowl and the Lost Colony', confidence: 'high', notes: null, volume: null, volumeCount: null, volumeSet: false, ...over,
})
const batch = (rows: { row: ShelfRow; preset?: { workId: string } | null; capture?: unknown }[], over = {}) => ({
  batchId: randomUUID(), label: 'Shelf · 12 Oct', ownership: 'owned' as const, borrowedFrom: null,
  rows: rows.map((r) => ({ row: r.row, preset: r.preset ?? null, capture: r.capture === undefined ? null : PageCapture.parse(r.capture) })), ...over,
})

describe('previewShelf', () => {
  const t = useTestDb()
  it('marks repeats, books already in my Inbox, copies I have, copies of other formats, weak matches and new books', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const physical = await createWork(t.db, workInput({ title: 'שם הרוח', authors: ['פטריק רותפס'], series: [], editions: [{ format: 'physical' }] }))
    const audio = await createWork(t.db, workInput({ title: 'Good Omens', authors: ['Neil Gaiman'], series: [], editions: [{ format: 'audiobook' }] }))
    await importShelf(t.db, scope, batch([{ row: row({ title: 'צופן הנצח', originalTitle: 'The Eternity Code' }) }]))
    const { statuses } = await previewShelf(t.db, scope, {
      rows: [
        { ...row({ title: 'שם הרוח', authors: ['פטריק רותפס'], series: null, originalTitle: 'The Name of the Wind' }), capture: null },
        { ...row({ title: 'בשורות טובות', authors: ['ניל גיימן'], series: null, originalTitle: 'Good Omens' }), capture: null },
        { ...row({ title: 'צופן הנצח', originalTitle: 'The Eternity Code' }), capture: null },
        { ...row({ title: 'שם הרוח!', authors: ['פטריק רותפס'], series: null, originalTitle: 'The Name of the Wind' }), capture: null },
        { ...row({ title: 'ספר שאין בכלל', originalTitle: null, series: null }), capture: null },
      ],
    })
    expect(statuses).toEqual([
      { kind: 'have', workId: physical, title: 'שם הרוח' },
      { kind: 'copy_of', workId: audio, title: 'Good Omens' },
      expect.objectContaining({ kind: 'in_inbox', title: 'צופן הנצח' }),
      { kind: 'repeat', of: 0 },
      { kind: 'new' },
    ])
  })
  it('never offers a book hidden from me', async () => {
    const member = await seedUser(t.db)
    const hidden = await createWork(t.db, workInput({ title: 'Hidden Book', authors: ['Some Author'], series: [], editions: [{ format: 'physical' }] }))
    await t.db.insert(userHiddenWorks).values({ userId: member.id, workId: hidden })
    const scope = await loadUserScope(t.db, member)
    const { statuses } = await previewShelf(t.db, scope, { rows: [{ ...row({ title: 'Hidden Book', authors: ['Some Author'], series: null, originalTitle: null }), capture: null }] })
    expect(statuses).toEqual([{ kind: 'new' }])
  })
  describe('volumes', () => {
    const vol = (over: Partial<ShelfRow>) => ({ ...row({ title: 'דרך המלכים', authors: ['ברנדון סנדרסון'], series: null, originalTitle: null, ...over }), capture: null })
    it('a row matches its own Inbox volume, by row volume or by a marker on the title, and no other volume', async () => {
      const scope = await loadUserScope(t.db, await seedUser(t.db))
      await importShelf(t.db, scope, batch([{ row: vol({ volume: 1 }) }]))
      const { statuses } = await previewShelf(t.db, scope, { rows: [vol({ volume: 1 }), vol({ title: "דרך המלכים כרך ב'" })] })
      expect(statuses[0]).toMatchObject({ kind: 'in_inbox' })
      expect(statuses[1]).not.toMatchObject({ kind: 'in_inbox' })
      const marked = await previewShelf(t.db, scope, { rows: [vol({ title: "דרך המלכים כרך א'" })] })
      expect(marked.statuses[0]).toMatchObject({ kind: 'in_inbox' })
      await importShelf(t.db, scope, batch([{ row: vol({ title: "דרך המלכים כרך ב'" }) }]))
      const again = await previewShelf(t.db, scope, { rows: [vol({ title: "דרך המלכים כרך ב'" })] })
      expect(again.statuses[0]).toMatchObject({ kind: 'in_inbox' })
    })
    it('two volumes of one book in a batch, one by marker and one by field, are not repeats', async () => {
      const scope = await loadUserScope(t.db, await seedUser(t.db))
      const { statuses } = await previewShelf(t.db, scope, { rows: [vol({ title: "דרך המלכים כרך א'" }), vol({ volume: 2 })] })
      expect(statuses.map((s) => s.kind)).not.toContain('repeat')
    })
  })
})

describe('importShelf', () => {
  const t = useTestDb()
  it('creates one shelf source, one source item and one private proposal per row, once per batch id', async () => {
    const member = await seedUser(t.db)
    const scope = await loadUserScope(t.db, member)
    const input = batch([{ row: row() }, { row: row({ title: 'צופן הנצח', seriesNumber: "כרך ג'" }) }])
    const first = await importShelf(t.db, scope, input)
    expect(first).toMatchObject({ alreadyImported: false, proposalIds: [expect.any(String), expect.any(String)] })
    expect(await importShelf(t.db, scope, input)).toEqual({ ...first, alreadyImported: true })
    const [source] = await t.db.select().from(sources).where(eq(sources.id, first.sourceId))
    expect(source).toMatchObject({ kind: 'shelf', name: 'Shelf · 12 Oct', config: { kind: 'shelf', ownerUserId: member.id, batchId: input.batchId } })
    expect((await t.db.select({ e: sourceItems.externalId }).from(sourceItems)).map((r) => r.e)).toEqual(['photo:1', 'photo:2'])
    const rows = await t.db.select().from(proposals)
    expect(rows.map((p) => [p.kind, p.scope, p.userId, p.createdBy])).toEqual([['new_work', 'user', member.id, 'photo'], ['new_work', 'user', member.id, 'photo']])
    const mine = await listMyProposals(t.db, scope)
    expect(mine.items.map((i) => [i.sourceKind, i.item.title, i.item.series[0]?.position, i.photo?.ai.originalTitle])).toEqual([
      ['shelf', 'המושבה האבודה', null, 'Artemis Fowl and the Lost Colony'],
      ['shelf', 'צופן הנצח', 3, 'Artemis Fowl and the Lost Colony'],
    ])
  })
  it('two concurrent imports of one batch create one source', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const input = batch([{ row: row() }])
    const [a, b] = await Promise.all([importShelf(t.db, scope, input), importShelf(t.db, scope, input)])
    expect(a.sourceId).toBe(b.sourceId)
    expect(await t.db.select().from(sources).where(eq(sources.kind, 'shelf'))).toHaveLength(1)
  })
  it('a row sent with its page is linked at once; a non-book page is refused', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const { proposalIds } = await importShelf(t.db, scope, batch([{ row: row({ title: 'ארטימס פאול - המושדה האבודה' }), capture: translatorPrefix }]))
    const [p] = await t.db.select().from(proposals).where(eq(proposals.id, only(proposalIds)))
    expect(p?.payload).toMatchObject({ item: { title: 'המושבה האבודה', translators: ['עפרה אביגד'], identifiers: { others: { simania: '690482' } } }, photo: { link: { providerId: '690482' }, original: { title: 'ארטימס פאול - המושדה האבודה' } } })
    await expect(importShelf(t.db, scope, batch([{ row: row(), capture: authorPage }]))).rejects.toMatchObject({ code: 'INVALID' })
  })
  it('accepting a borrowed row records a borrowed copy in hand, with whom; translators land', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const { proposalIds } = await importShelf(t.db, scope, batch([{ row: row({ translators: ['עפרה אביגד'] }) }], { ownership: 'borrowed', borrowedFrom: 'דנה' }))
    const { workId } = await resolveMyProposal(t.db, scope, only(proposalIds), { action: 'create_work' }, '2026-10-12')
    const detail = await getWorkDetail(t.db, scope, workId ?? '')
    expect(detail.editions[0]).toMatchObject({ format: 'physical', ownership: 'borrowed', inPossession: true })
    expect(detail.editions[0]?.history[0]).toMatchObject({ type: 'borrowed', note: 'דנה', occurredOn: '2026-10-12' })
  })
})

describe('books filed from the Inbox', () => {
  const t = useTestDb()
  const inMyLibrary = async (scope: UserScope, workId: string | null) => (await t.db.select({ id: works.id }).from(works).where(and(eq(works.id, workId ?? ''), scope.inLibrary))).length === 1
  it('a shelf copy joins My library, whether it starts a book or is added to one; an ignored one does not', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const existing = await createWork(t.db, workInput({ title: 'Good Omens', authors: ['Neil Gaiman'], series: [], editions: [{ format: 'audiobook' }] }))
    const { proposalIds } = await importShelf(t.db, scope, batch([{ row: row() }, { row: row({ title: 'בשורות טובות', originalTitle: 'Good Omens' }) }, { row: row({ title: 'אחר', originalTitle: null }) }], { ownership: 'borrowed' }))
    const [created, added, ignored] = proposalIds
    expect(await inMyLibrary(scope, existing)).toBe(false)
    const one = await resolveMyProposal(t.db, scope, created ?? '', { action: 'create_work' }, '2026-10-12')
    await resolveMyProposal(t.db, scope, added ?? '', { action: 'link_new_edition', workId: existing }, '2026-10-12')
    await resolveMyProposal(t.db, scope, ignored ?? '', { action: 'ignore' }, '2026-10-12')
    expect(await inMyLibrary(scope, one.workId)).toBe(true)
    expect(await inMyLibrary(scope, existing)).toBe(true)
    // only mine: another person's library is unchanged
    expect(await inMyLibrary(await loadUserScope(t.db, await seedUser(t.db)), existing)).toBe(false)
  })
})

describe('listMyProposals for shelf batches', () => {
  const t = useTestDb()
  it('filters to one batch, and counts the linked books of each pending batch', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const first = await importShelf(t.db, scope, batch([{ row: row({ title: 'ארטימס פאול - המושדה האבודה' }), capture: translatorPrefix }, { row: row({ title: 'צופן הנצח', originalTitle: null }) }], { label: 'Shelf A' }))
    const second = await importShelf(t.db, scope, batch([{ row: row({ title: 'ספר אחר', originalTitle: null, series: null }) }], { label: 'Shelf B' }))

    const all = await listMyProposals(t.db, scope)
    expect(all.items).toHaveLength(3)
    expect(all.shelfBatches).toEqual([
      { sourceId: first.sourceId, label: 'Shelf A', total: 2, linked: 1 },
      { sourceId: second.sourceId, label: 'Shelf B', total: 1, linked: 0 },
    ])
    const one = await listMyProposals(t.db, scope, { sourceId: second.sourceId })
    expect(one.items.map((i) => [i.item.title, i.sourceId])).toEqual([['ספר אחר', second.sourceId]])
    // the bulk actions act on everything, so their counts do too
    expect(one.total).toBe(3)

    await resolveMyProposal(t.db, scope, only(second.proposalIds), { action: 'ignore' }, '2026-10-12')
    expect((await listMyProposals(t.db, scope)).shelfBatches.map((b) => b.label)).toEqual(['Shelf A'])
    const other = await loadUserScope(t.db, await seedUser(t.db))
    expect(await listMyProposals(t.db, other, { sourceId: first.sourceId })).toMatchObject({ items: [], shelfBatches: [] })
  })
})

describe('attachPage / unlinkPage', () => {
  const t = useTestDb()
  it('links a page (twice is harmless), re-runs the candidates, and unlinks back to the AI reading', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const { proposalIds } = await importShelf(t.db, scope, batch([{ row: row({ title: 'ארטימס פאול - המושדה האבודה' }) }]))
    const id = only(proposalIds)
    const capture = PageCapture.parse(translatorPrefix)
    expect(await attachPage(t.db, scope, id, capture)).toEqual({ title: 'המושבה האבודה' })
    expect(await attachPage(t.db, scope, id, capture)).toEqual({ title: 'המושבה האבודה' })
    expect(await t.db.select().from(sourceItems)).toHaveLength(1)
    await unlinkPage(t.db, scope, id)
    const mine = await listMyProposals(t.db, scope)
    expect(mine.items[0]).toMatchObject({ item: { title: 'ארטימס פאול - המושדה האבודה' }, photo: { link: null } })
  })
  it('refuses another person, a handled book, and a non-book page', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const other = await loadUserScope(t.db, await seedUser(t.db))
    const { proposalIds } = await importShelf(t.db, scope, batch([{ row: row() }]))
    const id = only(proposalIds)
    await expect(attachPage(t.db, other, id, PageCapture.parse(translatorPrefix))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(attachPage(t.db, scope, id, PageCapture.parse(authorPage))).rejects.toMatchObject({ code: 'INVALID', message: "That isn't a book page — open the book itself and send it again" })
    await resolveMyProposal(t.db, scope, id, { action: 'ignore' }, '2026-10-12')
    await expect(attachPage(t.db, scope, id, PageCapture.parse(translatorPrefix))).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('two items linked to the same Simania page match by identifier', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const first = await importShelf(t.db, scope, batch([{ row: row(), capture: translatorPrefix }]))
    await resolveMyProposal(t.db, scope, only(first.proposalIds), { action: 'create_work' }, '2026-10-12')
    const second = await importShelf(t.db, scope, batch([{ row: row({ title: 'משהו אחר לגמרי' }), capture: translatorPrefix }]))
    const [p] = await t.db.select().from(proposals).where(eq(proposals.id, only(second.proposalIds)))
    expect(p?.candidates.map((c) => [c.basis, c.reasons.includes('Same Simania book')])).toEqual([['identifier', true]])
  })
})

describe('attachPage / unlinkPage on a CSV row', () => {
  const t = useTestDb()
  const csv = () =>
    CsvImportInput.parse({
      fileName: 'goodreads.csv',
      header: ['Title', 'Author', 'Series'],
      rows: [['Artemis Fowl: The Lost Colony', 'Eoin Colfer', 'Artemis Fowl']],
      mapping: { columns: { title: 0, authors: 1, series: 2 } },
      ownership: 'owned',
      importId: randomUUID(),
    })

  it('links a page to a CSV row, keeps its reading, and unlinks back to the row as imported', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const { proposals: count } = await importCsv(t.db, scope, csv())
    expect(count).toBe(1)
    const id = (await listMyProposals(t.db, scope)).items[0]?.id ?? ''
    expect(await attachPage(t.db, scope, id, PageCapture.parse(translatorPrefix))).toEqual({ title: 'המושבה האבודה' })
    const linked = (await listMyProposals(t.db, scope)).items[0]
    expect(linked).toMatchObject({
      sourceKind: 'csv',
      photo: null,
      item: { title: 'המושבה האבודה', translators: ['עפרה אביגד'], identifiers: { others: { simania: '690482' } } },
      linked: { original: { title: 'Artemis Fowl: The Lost Colony' }, link: { provider: 'simania', providerId: '690482' } },
    })
    // a second link starts again from the row as imported, not from the first page
    await attachPage(t.db, scope, id, PageCapture.parse(translatorPrefix))
    expect((await listMyProposals(t.db, scope)).items[0]?.linked?.original.title).toBe('Artemis Fowl: The Lost Colony')
    expect(await cachedCapture(t.db, 'simania', '690482')).toEqual(PageCapture.parse(translatorPrefix))

    await unlinkPage(t.db, scope, id)
    expect((await listMyProposals(t.db, scope)).items[0]).toMatchObject({ item: { title: 'Artemis Fowl: The Lost Colony', authors: ['Eoin Colfer'] }, linked: null })
  })

  it('files a linked CSV row with the page’s details', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await importCsv(t.db, scope, csv())
    const id = (await listMyProposals(t.db, scope)).items[0]?.id ?? ''
    await attachPage(t.db, scope, id, PageCapture.parse(translatorPrefix))
    const { workId } = await resolveMyProposal(t.db, scope, id, { action: 'create_work' }, '2026-10-12')
    const work = await getWorkDetail(t.db, scope, workId ?? '')
    expect(work.title).toBe('המושבה האבודה')
    expect(work.editions[0]?.translators.map((p) => p.name)).toEqual(['עפרה אביגד'])
  })

  it('refuses another person, a handled row, and a source that is neither a CSV import nor a shelf batch', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const other = await loadUserScope(t.db, await seedUser(t.db))
    await importCsv(t.db, scope, csv())
    const id = (await listMyProposals(t.db, scope)).items[0]?.id ?? ''
    await expect(attachPage(t.db, other, id, PageCapture.parse(translatorPrefix))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(unlinkPage(t.db, other, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // the same proposal moved under a synced source is not a linkable import
    const [sourceItem] = await t.db.select({ sourceId: sourceItems.sourceId }).from(sourceItems)
    await t.db.update(sources).set({ kind: 'audiobookshelf' }).where(eq(sources.id, sourceItem?.sourceId ?? ''))
    await expect(attachPage(t.db, scope, id, PageCapture.parse(translatorPrefix))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await t.db.update(sources).set({ kind: 'csv' }).where(eq(sources.id, sourceItem?.sourceId ?? ''))
    await resolveMyProposal(t.db, scope, id, { action: 'ignore' }, '2026-10-12')
    await expect(attachPage(t.db, scope, id, PageCapture.parse(translatorPrefix))).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('addOneShelf', () => {
  const t = useTestDb()
  it('adds a single book from a page straight to the library, once', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const input = { batchId: randomUUID(), label: 'Simania · 12 Oct', ownership: 'owned' as const, borrowedFrom: null, row: null, capture: PageCapture.parse(translatorPrefix), target: { action: 'create_work' as const }, today: '2026-10-12' }
    const { workId } = await addOneShelf(t.db, scope, input)
    expect((await getWorkDetail(t.db, scope, workId)).title).toBe('המושבה האבודה')
    expect((await addOneShelf(t.db, scope, input)).workId).toBe(workId)
    expect((await listMyProposals(t.db, scope)).items).toEqual([])
  })
  it('adds a second physical copy to an existing book when asked', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const existing = await createWork(t.db, workInput({ title: 'המושבה האבודה', series: [], editions: [{ format: 'physical' }] }))
    await addOneShelf(t.db, scope, { batchId: randomUUID(), label: 'x', ownership: 'owned', borrowedFrom: null, row: row(), capture: null, target: { action: 'link_new_edition', workId: existing }, today: '2026-10-12' })
    expect((await getWorkDetail(t.db, scope, existing)).editions.filter((e) => e.format === 'physical')).toHaveLength(2)
  })
})

describe('unlinkPage refusals', () => {
  const t = useTestDb()
  it('refuses another person and a handled book', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const other = await loadUserScope(t.db, await seedUser(t.db))
    const id = only((await importShelf(t.db, scope, batch([{ row: row() }]))).proposalIds)
    await expect(unlinkPage(t.db, other, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await resolveMyProposal(t.db, scope, id, { action: 'ignore' }, '2026-10-12')
    await expect(unlinkPage(t.db, scope, id)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('importShelf borrowedFrom', () => {
  const t = useTestDb()
  it('stores a blank "borrowed from" as null', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await importShelf(t.db, scope, batch([{ row: row() }], { ownership: 'borrowed', borrowedFrom: '   ' }))
    expect((await listMyProposals(t.db, scope)).items[0]?.photo?.borrowedFrom).toBeNull()
  })
})

describe('loadSourceKind', () => {
  const t = useTestDb()
  it('names the kind of a source, null for an unknown id', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const { sourceId } = await importShelf(t.db, scope, batch([{ row: row() }]))
    const [csv] = await t.db.insert(sources).values({ kind: 'csv', name: 'CSV: x.csv', config: { kind: 'csv' }, schedule: null }).returning({ id: sources.id })
    expect(await loadSourceKind(t.db, sourceId)).toBe('shelf')
    expect(await loadSourceKind(t.db, csv?.id ?? '')).toBe('csv')
    expect(await loadSourceKind(t.db, randomUUID())).toBeNull()
  })
})

describe('cachedCapture', () => {
  const t = useTestDb()
  const item = ExternalItem.parse({ externalId: 'x:1', format: 'physical', title: 'x', identifiers: { others: { simania: '690482' } } })
  async function storeRaw(kind: 'csv' | 'shelf', raw: unknown): Promise<void> {
    const [source] = await t.db.insert(sources).values({ kind, name: 's', config: { kind }, schedule: null }).returning({ id: sources.id })
    await t.db.insert(sourceItems).values({ sourceId: source?.id ?? '', externalId: 'x:1', raw, normalized: item, contentHash: 'h' })
  }
  it('returns nothing when no capture is stored', async () => {
    expect(await cachedCapture(t.db, 'simania', '690482')).toBeNull()
  })
  it('returns the stored page of that book', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await importShelf(t.db, scope, batch([{ row: row(), capture: translatorPrefix }]))
    expect(await cachedCapture(t.db, 'simania', '690482')).toEqual(PageCapture.parse(translatorPrefix))
    expect(await cachedCapture(t.db, 'simania', '1')).toBeNull()
  })
  it('reuses a page stored on a linked CSV row too', async () => {
    await storeRaw('csv', { capture: translatorPrefix })
    expect(await cachedCapture(t.db, 'simania', '690482')).toEqual(PageCapture.parse(translatorPrefix))
  })
  it('ignores a capture on another kind of source, a null one, a malformed one and one of another book', async () => {
    const [source] = await t.db.insert(sources).values({ kind: 'manual', name: 's', config: { kind: 'manual' }, schedule: null }).returning({ id: sources.id })
    await t.db.insert(sourceItems).values({ sourceId: source?.id ?? '', externalId: 'x:2', raw: { capture: translatorPrefix }, normalized: item, contentHash: 'h' })
    await storeRaw('shelf', { capture: null })
    await storeRaw('shelf', { capture: { url: 5 } })
    await storeRaw('shelf', { capture: fixture('simania-year-parens') })
    expect(await cachedCapture(t.db, 'simania', '690482')).toBeNull()
  })
  it("a work link never reuses a stored edition of that work (it carries the edition's cover and ISBNs, #102)", async () => {
    const ol = providerById('openlibrary')
    const edition = ol.fetch.capture(JSON.stringify(fixture('openlibrary-edition')), ol.canonicalUrl('OL7353617M'))
    const olItem = ExternalItem.parse({ externalId: 'x:3', format: 'physical', title: 'x', identifiers: { others: { openlibrary: 'OL45804W' } } })
    const [source] = await t.db.insert(sources).values({ kind: 'shelf', name: 's', config: { kind: 'shelf' }, schedule: null }).returning({ id: sources.id })
    await t.db.insert(sourceItems).values({ sourceId: source?.id ?? '', externalId: 'x:3', raw: { capture: edition }, normalized: olItem, contentHash: 'h' })
    expect(edition).not.toBeNull()
    expect(await cachedCapture(t.db, 'openlibrary', 'OL45804W')).toBeNull()
  })
})

describe('bulk actions on shelf rows', () => {
  const t = useTestDb()
  it('accept-all-exact files a copy: the same format links to it, another format adds an edition', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const first = await importShelf(t.db, scope, batch([{ row: row(), capture: translatorPrefix }]))
    const { workId } = await resolveMyProposal(t.db, scope, only(first.proposalIds), { action: 'create_work' }, '2026-10-12')
    const physical = await importShelf(t.db, scope, batch([{ row: row({ title: 'משהו אחר' }), capture: translatorPrefix }]))
    expect(await acceptMineExact(t.db, scope, '2026-10-12')).toMatchObject({ accepted: 1, remaining: 0 })
    expect((await getWorkDetail(t.db, scope, workId ?? '')).editions).toHaveLength(1)
    expect(physical.proposalIds).toHaveLength(1)

    await t.db.update(editions).set({ format: 'audiobook' }).where(eq(editions.workId, workId ?? ''))
    await importShelf(t.db, scope, batch([{ row: row({ title: 'ועוד אחד' }), capture: translatorPrefix }]))
    expect(await acceptMineExact(t.db, scope, '2026-10-12')).toMatchObject({ accepted: 1, remaining: 0 })
    const formats = (await getWorkDetail(t.db, scope, workId ?? '')).editions.map((e) => e.format).sort()
    expect(formats).toEqual(['audiobook', 'physical'])
  })
  it('accept-all-exact adds a second copy on the preset work when the row was ticked on purpose', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const first = await importShelf(t.db, scope, batch([{ row: row(), capture: translatorPrefix }]))
    const { workId } = await resolveMyProposal(t.db, scope, only(first.proposalIds), { action: 'create_work' }, '2026-10-12')
    await importShelf(t.db, scope, batch([{ row: row({ title: 'ועוד עותק' }), preset: { workId: workId ?? '' }, capture: translatorPrefix }]))
    expect(await acceptMineExact(t.db, scope, '2026-10-12')).toMatchObject({ accepted: 1, remaining: 0 })
    const formats = (await getWorkDetail(t.db, scope, workId ?? '')).editions.map((e) => e.format)
    expect(formats).toEqual(['physical', 'physical'])
  })
  it('create-all-unmatched files a preset row on its work instead of making a new one', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const work = await createWork(t.db, workInput({ title: 'Some Book', authors: ['Some Author'], series: [], editions: [{ format: 'physical' }] }))
    await importShelf(t.db, scope, batch([{ row: row({ title: 'ספר שאין בכלל', originalTitle: null, series: null }), preset: { workId: work } }]))
    expect(await createMineUnmatched(t.db, scope, '2026-10-12')).toMatchObject({ created: 1, skipped: 0, remaining: 0 })
    expect((await getWorkDetail(t.db, scope, work)).editions).toHaveLength(2)
    expect(await t.db.select().from(works)).toHaveLength(1)
  })
  it('create-all-unmatched makes new books of unmatched shelf rows', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await importShelf(t.db, scope, batch([{ row: row({ title: 'ספר שאין בכלל', originalTitle: null, series: null }) }]))
    expect(await createMineUnmatched(t.db, scope, '2026-10-12')).toMatchObject({ created: 1, skipped: 0, remaining: 0 })
  })
})
