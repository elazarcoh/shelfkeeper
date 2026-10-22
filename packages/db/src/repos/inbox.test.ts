import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { DomainError, ExternalItem, ok, type ItemError, type Result } from '@mylib/domain'
import { editionHoldingEvents, editions, hardcoverBooks, proposals, sourceItems, sources, userHiddenWorks, works } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { changeHolding, createWork, getWorkDetail } from './catalog'
import { acceptExactMatches, countInbox, createForUnmatched, listInbox, resolveSourceMatch } from './inbox'
import { loadUserScope } from './scope'
import * as sourceCatalog from './source-catalog'
import { syncSource } from './sync'

const book = (over: Record<string, unknown> = {}) =>
  ExternalItem.parse({ externalId: 'li_1', format: 'audiobook', title: 'The Final Empire', authors: ['Brandon Sanderson'], durationSec: 88_000, ...over })

async function* feed(...items: ExternalItem[]): AsyncIterable<Result<ExternalItem, ItemError>> {
  await Promise.resolve()
  for (const i of items) yield ok(i)
}

describe('inbox repository', () => {
  const t = useTestDb()

  async function setup(...items: ExternalItem[]) {
    const admin = await seedUser(t.db, { role: 'admin' })
    const scope = await loadUserScope(t.db, admin)
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'Home ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!source) throw new Error('no source')
    return { admin, scope, sourceId: source.id, sync: () => syncSource(t.db, source.id, feed(...items)) }
  }

  it('lists pending items with ranked, visible candidates', async () => {
    const { scope, sync } = await setup(book())
    const workId = await createWork(t.db, workInput({ title: 'The Final Empire', series: [] }))
    await sync()
    const [entry] = (await listInbox(t.db, scope)).items
    expect(entry).toMatchObject({ sourceName: 'Home ABS', item: { title: 'The Final Empire' } })
    expect(entry?.candidates[0]).toMatchObject({ workId, basis: 'title_author', card: { title: 'The Final Empire' }, edition: null })
    expect(await countInbox(t.db, scope)).toBe(1)
  })

  it('creates a new book from an item, linking it with source provenance', async () => {
    const { scope, sourceId, sync } = await setup(book())
    await sync()
    const [entry] = (await listInbox(t.db, scope)).items
    const { workId } = await resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'create_work' })
    const detail = await getWorkDetail(t.db, scope, workId ?? '')
    expect(detail.editions[0]?.provenance.durationSec).toMatchObject({ origin: 'source', sourceId })
    const [item] = await t.db.select().from(sourceItems)
    expect(item).toMatchObject({ state: 'linked', workId, editionId: detail.editions[0]?.id })
    expect(await countInbox(t.db, scope)).toBe(0)
  })

  it('handles each proposal once, even when two requests race', async () => {
    const { scope, sync } = await setup(book())
    await sync()
    const [entry] = (await listInbox(t.db, scope)).items
    const results = await Promise.allSettled([
      resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'create_work' }),
      resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'create_work' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } })
    expect(await t.db.select().from(works)).toHaveLength(1)
  })

  it('never shows or links a book hidden from the reviewing admin', async () => {
    const { admin, sync } = await setup(book({ identifiers: { asin: 'B002UZMLXM' } }))
    const hidden = await createWork(t.db, workInput({ title: 'The Final Empire', series: [], editions: [{ format: 'audiobook', asin: 'B002UZMLXM' }] }))
    await sync()
    await t.db.insert(userHiddenWorks).values({ userId: admin.id, workId: hidden })
    const scope = await loadUserScope(t.db, admin)
    const [entry] = (await listInbox(t.db, scope)).items
    expect(entry?.candidates).toEqual([])
    await expect(resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'link_new_edition', workId: hidden })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await acceptExactMatches(t.db, scope)).toEqual({ accepted: 0, remaining: 0 })
  })

  it('restores a copy through an explicit Inbox link, even though a person marked it gone', async () => {
    const { admin, scope, sync } = await setup(book({ identifiers: { asin: 'B002UZMLXM' } }))
    const workId = await createWork(t.db, workInput({ title: 'Mistborn', series: [], editions: [{ format: 'audiobook', asin: 'B002UZMLXM' }] }))
    const before = await getWorkDetail(t.db, scope, workId)
    const editionId = before.editions[0]?.id ?? ''
    await changeHolding(t.db, scope, editionId, { action: 'no_longer_have', on: '2026-09-20', note: null })
    await sync()
    const [entry] = (await listInbox(t.db, scope)).items
    await resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'link_edition', editionId })
    const detail = await getWorkDetail(t.db, scope, workId)
    const edition = detail.editions.find((e) => e.id === editionId)
    expect(edition?.inPossession).toBe(true)
    const events = await t.db.select().from(editionHoldingEvents).where(eq(editionHoldingEvents.editionId, editionId))
    const restored = events.find((e) => e.type === 'restored')
    expect(restored).toMatchObject({ origin: 'manual', actorUserId: admin.id })
  })

  it('links an item to an existing copy of the same format only', async () => {
    const { scope, sync } = await setup(book({ identifiers: { asin: 'B002UZMLXM' } }))
    const workId = await createWork(t.db, workInput({ title: 'The Final Empire', series: [], editions: [{ format: 'physical' }, { format: 'audiobook', asin: 'B002UZMLXM' }] }))
    await sync()
    const [entry] = (await listInbox(t.db, scope)).items
    const physical = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.format === 'physical')
    await expect(resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'link_edition', editionId: physical?.id ?? '' })).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('bulk-accepts exact identifier matches onto the matching copy', async () => {
    const { scope, sync } = await setup(book({ identifiers: { asin: 'B002UZMLXM' } }), book({ externalId: 'li_2', title: 'Unmatched Book' }))
    const workId = await createWork(t.db, workInput({ title: 'Mistborn', series: [], editions: [{ format: 'audiobook', asin: 'B002UZMLXM' }] }))
    await sync()
    expect(await acceptExactMatches(t.db, scope)).toEqual({ accepted: 1, remaining: 0 })
    const editionsOfWork = await t.db.select().from(editions).where(eq(editions.workId, workId))
    expect(editionsOfWork).toHaveLength(1)
    const [linked] = await t.db.select().from(sourceItems).where(eq(sourceItems.externalId, 'li_1'))
    expect(linked).toMatchObject({ state: 'linked', editionId: editionsOfWork[0]?.id })
    expect(await countInbox(t.db, scope)).toBe(1)
  })

  it('ignoring an item keeps it out of the Inbox on later syncs', async () => {
    const { scope, sync } = await setup(book())
    await sync()
    const [entry] = (await listInbox(t.db, scope)).items
    await resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'ignore' })
    await sync()
    expect((await listInbox(t.db, scope)).items).toEqual([])
    expect((await t.db.select({ status: proposals.status }).from(proposals)).map((p) => p.status)).toEqual(['rejected'])
  })

  it('reopens an ignored item once its content changes, but not before', async () => {
    const { scope, sourceId, sync } = await setup(book())
    await sync()
    const [entry] = (await listInbox(t.db, scope)).items
    await resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'ignore' })

    // an unrelated resync of the exact same content must not reopen it
    await syncSource(t.db, sourceId, feed(book()))
    expect((await listInbox(t.db, scope)).items).toEqual([])

    // but a genuine content change should surface it again for review
    await syncSource(t.db, sourceId, feed(book({ title: 'The Final Empire: Author’s Cut' })))
    const reopened = (await listInbox(t.db, scope)).items
    expect(reopened).toHaveLength(1)
    expect(reopened[0]).toMatchObject({ item: { title: "The Final Empire: Author’s Cut" } })
    const [item] = await t.db.select({ state: sourceItems.state }).from(sourceItems)
    expect(item).toMatchObject({ state: 'pending' })
  })

  it('reports the total pending count when the list is truncated', async () => {
    const { scope, sync } = await setup(book(), book({ externalId: 'li_2', title: 'Another' }), book({ externalId: 'li_3', title: 'Third' }))
    await sync()
    const page = await listInbox(t.db, scope, 2)
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(3)
  })

  it('reports unmatched and exact-match counts across every pending item, not just the shown page', async () => {
    const { scope, sync } = await setup(
      book({ identifiers: { asin: 'B002UZMLXM' } }),
      book({ externalId: 'li_2', title: 'Another Unmatched' }),
      book({ externalId: 'li_3', title: 'Yet Another Unmatched' }),
    )
    await createWork(t.db, workInput({ title: 'Mistborn', series: [], editions: [{ format: 'audiobook', asin: 'B002UZMLXM' }] }))
    await sync()
    const page = await listInbox(t.db, scope, 1)
    expect(page.items).toHaveLength(1)
    expect(page.total).toBe(3)
    expect(page.unmatched).toBe(2)
    expect(page.exactMatches).toBe(1)
  })

  it('does not count an item with only-hidden candidates as unmatched', async () => {
    const { admin, sync } = await setup(book({ identifiers: { asin: 'B002UZMLXM' } }))
    const hidden = await createWork(t.db, workInput({ title: 'The Final Empire', series: [], editions: [{ format: 'audiobook', asin: 'B002UZMLXM' }] }))
    await sync()
    await t.db.insert(userHiddenWorks).values({ userId: admin.id, workId: hidden })
    const scope = await loadUserScope(t.db, admin)
    const page = await listInbox(t.db, scope)
    expect(page.unmatched).toBe(0)
  })

  it('leaves an item with only-hidden candidates for manual review instead of auto-creating a duplicate', async () => {
    const { admin, sync } = await setup(book({ identifiers: { asin: 'B002UZMLXM' } }))
    const hidden = await createWork(t.db, workInput({ title: 'The Final Empire', series: [], editions: [{ format: 'audiobook', asin: 'B002UZMLXM' }] }))
    await sync()
    await t.db.insert(userHiddenWorks).values({ userId: admin.id, workId: hidden })
    const scope = await loadUserScope(t.db, admin)
    expect(await createForUnmatched(t.db, scope)).toEqual({ created: 0, linked: 0, wanted: 0, skipped: 0, remaining: 0 })
    const [item] = await t.db.select({ state: sourceItems.state }).from(sourceItems)
    expect(item).toMatchObject({ state: 'pending' })
    expect(await t.db.select().from(works)).toHaveLength(1)
  })

  it('pairs an ebook sibling with a primary that was created earlier by hand, not just in the same batch', async () => {
    const primary = book({ externalId: 'li_hb1', title: 'Wizard and Glass', authors: ['Stephen King'] })
    const ebook = book({ externalId: 'li_hb1:ebook', format: 'ebook', title: 'Wizard and Glass', authors: ['Stephen King'], durationSec: null })
    const { scope, sync } = await setup(primary, ebook)
    await sync()
    const [primaryEntry] = (await listInbox(t.db, scope)).items.filter((i) => i.item.externalId === 'li_hb1')
    const { workId } = await resolveSourceMatch(t.db, scope, primaryEntry?.id ?? '', { action: 'create_work' })

    expect(await createForUnmatched(t.db, scope)).toEqual({ created: 0, linked: 1, wanted: 0, skipped: 0, remaining: 0 })
    const editionsOfWork = await t.db.select().from(editions).where(eq(editions.workId, workId ?? ''))
    expect(editionsOfWork.map((e) => e.format).sort()).toEqual(['audiobook', 'ebook'])
    expect(await t.db.select().from(works)).toHaveLength(1)
  })

  it('creates books for every unmatched item, putting an audiobook and its ebook on one book', async () => {
    const hp = book({ externalId: 'li_hp1', title: 'Harry Potter and the Philosopher’s Stone', authors: ['J.K. Rowling'] })
    const hpEbook = book({ externalId: 'li_hp1:ebook', format: 'ebook', title: 'Harry Potter and the Philosopher’s Stone', authors: ['J.K. Rowling'], durationSec: null })
    // the ebook sibling arrives first: the primary is still created before it
    const { scope, sync } = await setup(hpEbook, hp, book({ externalId: 'li_x', title: 'Standalone Novel', authors: ['Someone Else'] }), book({ externalId: 'li_m' }))
    const existing = await createWork(t.db, workInput({ title: 'The Final Empire', series: [] }))
    await sync()

    expect(await createForUnmatched(t.db, scope)).toEqual({ created: 2, linked: 1, wanted: 0, skipped: 0, remaining: 0 })
    const allWorks = await t.db.select().from(works)
    expect(allWorks).toHaveLength(3)
    const hpWork = allWorks.find((w) => w.title.startsWith('Harry Potter'))
    const hpEditions = await t.db.select().from(editions).where(eq(editions.workId, hpWork?.id ?? ''))
    expect(hpEditions.map((e) => e.format).sort()).toEqual(['audiobook', 'ebook'])
    // an item with a candidate is left for a person
    const left = (await listInbox(t.db, scope)).items
    expect(left.map((i) => i.item.externalId)).toEqual(['li_m'])
    expect(left[0]?.candidates[0]?.workId).toBe(existing)
    expect(await createForUnmatched(t.db, scope)).toEqual({ created: 0, linked: 0, wanted: 0, skipped: 0, remaining: 0 })
  })

  it('bulk create is admin-only', async () => {
    const member = await loadUserScope(t.db, await seedUser(t.db))
    await expect(createForUnmatched(t.db, member)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('is for admins; members see a zero count', async () => {
    const { sync } = await setup(book())
    await sync()
    const member = await loadUserScope(t.db, await seedUser(t.db))
    await expect(listInbox(t.db, member)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await countInbox(t.db, member)).toBe(0)
  })

  const wantedItem = (over: Record<string, unknown> = {}) =>
    ExternalItem.parse({ externalId: 'book:11', format: 'ebook', title: 'Project Hail Mary', authors: ['Andy Weir'], wantedOnly: true, identifiers: { others: { readarrBookId: '11' } }, ...over })

  it('creates a wanted book from a create_wanted proposal and keeps the item as its placeholder', async () => {
    const { scope, sync } = await setup(wantedItem())
    await sync()
    const [entry] = (await listInbox(t.db, scope)).items
    expect(entry).toMatchObject({ kind: 'create_wanted', item: { title: 'Project Hail Mary' } })
    const { workId } = await resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'create_wanted' })
    expect((await getWorkDetail(t.db, scope, workId ?? '')).availability).toBe('wanted')
    expect(await t.db.select({ state: sourceItems.state, workId: sourceItems.workId, editionId: sourceItems.editionId }).from(sourceItems)).toEqual([
      { state: 'linked', workId, editionId: null },
    ])
  })

  it('attaches a wanted item to a book already in the catalog, and refuses actions that do not fit', async () => {
    const { scope, sync } = await setup(wantedItem())
    const workId = await createWork(t.db, workInput({ title: 'Project Hail Mary', series: [] }))
    await sync()
    const [entry] = (await listInbox(t.db, scope)).items
    await expect(resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'create_work' })).rejects.toMatchObject({ code: 'INVALID' })
    await resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'attach_wanted', workId })
    expect((await t.db.select({ workId: sourceItems.workId, editionId: sourceItems.editionId }).from(sourceItems))[0]).toEqual({ workId, editionId: null })
  })

  it('refuses to attach a wanted item to a work hidden from the resolving admin, or to one that does not exist', async () => {
    const { admin, scope, sync } = await setup(wantedItem())
    const hidden = await createWork(t.db, workInput({ title: 'Hidden book', series: [] }))
    await t.db.insert(userHiddenWorks).values({ userId: admin.id, workId: hidden })
    await sync()
    const [entry] = (await listInbox(t.db, scope)).items
    await expect(resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'attach_wanted', workId: hidden })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'attach_wanted', workId: '22222222-2222-4222-8222-222222222222' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses attach_wanted and create_wanted on a source_match proposal', async () => {
    const { scope, sync } = await setup(book())
    const workId = await createWork(t.db, workInput({ title: 'Some other book', series: [] }))
    await sync()
    const [entry] = (await listInbox(t.db, scope)).items
    await expect(resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'attach_wanted', workId })).rejects.toMatchObject({ code: 'INVALID' })
    await expect(resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'create_wanted' })).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('files the arriving file onto the wanted book with "Accept all exact matches"', async () => {
    const admin = await seedUser(t.db, { role: 'admin' })
    const scope = await loadUserScope(t.db, admin)
    const [source] = await t.db.insert(sources).values({ kind: 'readarr', name: 'Readarr', config: { kind: 'readarr' } }).returning()
    await syncSource(t.db, source?.id ?? '', feed(wantedItem()))
    const [wanted] = (await listInbox(t.db, scope)).items
    const { workId } = await resolveSourceMatch(t.db, scope, wanted?.id ?? '', { action: 'create_wanted' })

    const fileItem = ExternalItem.parse({ externalId: 'book:11:ebook', format: 'ebook', title: 'Project Hail Mary', authors: ['Andy Weir'], identifiers: { others: { readarrBookId: '11' } } })
    await syncSource(t.db, source?.id ?? '', feed(fileItem))
    expect((await listInbox(t.db, scope)).exactMatches).toBe(1)
    expect(await acceptExactMatches(t.db, scope)).toEqual({ accepted: 1, remaining: 0 })
    const detail = await getWorkDetail(t.db, scope, workId ?? '')
    expect(detail.availability).toBe('owned')
    expect(detail.editions.map((e) => e.format)).toEqual(['ebook'])
  })

  it('counts every pending item in SQL and creates unmatched books in chunks', async () => {
    const { scope, sync } = await setup(book({ externalId: 'a', title: 'Alpha' }), book({ externalId: 'b', title: 'Beta' }), wantedItem({ externalId: 'c', title: 'Gamma' }))
    await sync()
    expect(await listInbox(t.db, scope, 1)).toMatchObject({ total: 3, unmatched: 3, exactMatches: 0 })
    expect(await createForUnmatched(t.db, scope, 2)).toEqual({ created: 2, linked: 0, wanted: 0, skipped: 0, remaining: 1 })
    expect(await createForUnmatched(t.db, scope, 2)).toEqual({ created: 0, linked: 0, wanted: 1, skipped: 0, remaining: 0 })
    expect((await listInbox(t.db, scope)).total).toBe(0)
  })

  it('counts an exact match only when its top candidate is visible to the admin', async () => {
    const { admin, sync } = await setup(book({ identifiers: { asin: 'B002UZMLXM' } }))
    const hidden = await createWork(t.db, workInput({ title: 'Other title', series: [], editions: [{ format: 'audiobook', asin: 'B002UZMLXM' }] }))
    await sync()
    expect((await listInbox(t.db, await loadUserScope(t.db, admin))).exactMatches).toBe(1)
    await t.db.insert(userHiddenWorks).values({ userId: admin.id, workId: hidden })
    expect((await listInbox(t.db, await loadUserScope(t.db, admin))).exactMatches).toBe(0)
  })

  it('pairs format siblings across chunks, including a Readarr/Chaptarr book in both formats', async () => {
    const { scope, sync } = await setup(
      book({ externalId: 'book:10:audiobook', title: 'The Final Empire' }),
      book({ externalId: 'book:10:ebook', format: 'ebook', title: 'The Final Empire', durationSec: null }),
      book({ externalId: 'li_x', title: 'Standalone Novel', authors: ['Someone Else'] }),
    )
    await sync()
    expect(await createForUnmatched(t.db, scope, 1)).toEqual({ created: 1, linked: 0, wanted: 0, skipped: 0, remaining: 2 })
    expect(await createForUnmatched(t.db, scope, 1)).toEqual({ created: 1, linked: 0, wanted: 0, skipped: 0, remaining: 1 })
    expect(await createForUnmatched(t.db, scope, 1)).toEqual({ created: 0, linked: 1, wanted: 0, skipped: 0, remaining: 0 })
    const allWorks = await t.db.select().from(works)
    expect(allWorks).toHaveLength(2)
    const empire = allWorks.find((w) => w.title === 'The Final Empire')
    const formats = (await t.db.select().from(editions).where(eq(editions.workId, empire?.id ?? ''))).map((e) => e.format).sort()
    expect(formats).toEqual(['audiobook', 'ebook'])
  })

  it('pages past an item that keeps failing, so later exact matches still get accepted', async () => {
    const { scope, sync } = await setup(
      book({ externalId: 'li_1', title: 'Fails', identifiers: { asin: 'B000000001' } }),
      book({ externalId: 'li_2', title: 'Works', identifiers: { asin: 'B000000002' } }),
    )
    const failing = await createWork(t.db, workInput({ title: 'Fails', series: [], editions: [{ format: 'audiobook', asin: 'B000000001' }] }))
    await createWork(t.db, workInput({ title: 'Works', series: [], editions: [{ format: 'audiobook', asin: 'B000000002' }] }))
    await sync()
    // the failing item comes first in the Inbox's order
    const [failingItem] = await t.db.select({ id: sourceItems.id }).from(sourceItems).where(eq(sourceItems.externalId, 'li_1'))
    await t.db.update(proposals).set({ createdAt: new Date('2020-01-01T00:00:00Z') }).where(eq(proposals.sourceItemId, failingItem?.id ?? ''))
    const [failingEdition] = await t.db.select({ id: editions.id }).from(editions).where(eq(editions.workId, failing))

    const real = sourceCatalog.applyItemToEdition
    const spy = vi
      .spyOn(sourceCatalog, 'applyItemToEdition')
      .mockImplementation((db, sourceId, editionId, item) => (editionId === failingEdition?.id ? Promise.reject(new DomainError('CONFLICT', 'busy')) : real(db, sourceId, editionId, item)))
    try {
      expect(await acceptExactMatches(t.db, scope, 1)).toEqual({ accepted: 1, remaining: 1 })
    } finally {
      spy.mockRestore()
    }
    const statuses = await t.db.select({ sourceItemId: proposals.sourceItemId, status: proposals.status }).from(proposals)
    expect(statuses.find((p) => p.sourceItemId === failingItem?.id)?.status).toBe('pending')
    expect(statuses.filter((p) => p.status === 'accepted')).toHaveLength(1)
  })

  describe('a Hardcover link on the item', () => {
    const hc = (id = '474572') => book({ externalId: `li_${id}`, identifiers: { others: { hardcover: id } } })
    const pendingId = async () => (await t.db.select({ id: proposals.id }).from(proposals))[0]?.id ?? ''

    it('links the new book as a manual match, due for a refresh', async () => {
      const { scope, sync } = await setup(hc())
      await sync()
      const { workId } = await resolveSourceMatch(t.db, scope, await pendingId(), { action: 'create_work' })
      expect(await t.db.select().from(hardcoverBooks)).toMatchObject([{ workId, hardcoverId: 474572, match: 'manual', slug: null, fetchedAt: new Date(0), nextCheckAt: null }])
    })

    it('fills a "none" row but leaves a manual or rejected one alone', async () => {
      const { scope, sync } = await setup(hc('10'), hc('20'), hc('30'))
      const kept = await createWork(t.db, workInput({ title: 'Kept' }))
      const rejected = await createWork(t.db, workInput({ title: 'Rejected' }))
      const empty = await createWork(t.db, workInput({ title: 'Empty' }))
      await t.db.insert(hardcoverBooks).values([
        { workId: kept, hardcoverId: 99, match: 'manual', slug: 'kept' },
        { workId: rejected, hardcoverId: null, match: 'rejected' },
        { workId: empty, hardcoverId: null, match: 'none' },
      ])
      await sync()
      const ids = await t.db.select({ id: proposals.id, externalId: sourceItems.externalId }).from(proposals).innerJoin(sourceItems, eq(sourceItems.id, proposals.sourceItemId)).orderBy(sourceItems.externalId)
      expect(ids.map((i) => i.externalId)).toEqual(['li_10', 'li_20', 'li_30'])
      const [a, b, c] = ids
      for (const [entry, workId] of [[a, kept], [b, rejected], [c, empty]] as const) {
        await resolveSourceMatch(t.db, scope, entry?.id ?? '', { action: 'link_new_edition', workId })
      }
      const rows = new Map((await t.db.select().from(hardcoverBooks)).map((r) => [r.workId, r]))
      expect(rows.get(kept)).toMatchObject({ hardcoverId: 99, match: 'manual', slug: 'kept' })
      expect(rows.get(rejected)).toMatchObject({ hardcoverId: null, match: 'rejected' })
      expect(rows.get(empty)).toMatchObject({ match: 'manual', fetchedAt: new Date(0) })
      expect(rows.get(empty)?.hardcoverId).not.toBeNull()
    })

    it('ignoring the item, or an id that is not a positive integer, writes nothing', async () => {
      const { scope, sync } = await setup(hc(), hc('abc'))
      await sync()
      const all = await t.db.select({ id: proposals.id, externalId: sourceItems.externalId }).from(proposals).innerJoin(sourceItems, eq(sourceItems.id, proposals.sourceItemId)).orderBy(sourceItems.externalId)
      expect(all.map((i) => i.externalId)).toEqual(['li_474572', 'li_abc'])
      await resolveSourceMatch(t.db, scope, all[0]?.id ?? '', { action: 'ignore' })
      await resolveSourceMatch(t.db, scope, all[1]?.id ?? '', { action: 'create_work' })
      expect(await t.db.select().from(hardcoverBooks)).toEqual([])
    })
  })
})
