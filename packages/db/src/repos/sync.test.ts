import { and, eq, isNull, sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { ExternalItem, ok, type ItemError, type Result } from '@mylib/domain'
import { editionHoldingEvents, editions, proposals, sourceItems, sources, works } from '../schema'
import { useTestDb, workInput } from '../testing'
import { createWork } from './catalog'
import * as sourceCatalog from './source-catalog'
import { createWorkFromItem } from './source-catalog'
import { syncSource } from './sync'

const book = (over: Record<string, unknown> = {}) =>
  ExternalItem.parse({ externalId: 'li_1', format: 'audiobook', title: 'The Final Empire', authors: ['Brandon Sanderson'], durationSec: 88_000, ...over })
const other = book({ externalId: 'li_2', title: 'The Well of Ascension', durationSec: 99_000 })

async function* feed(...results: Result<ExternalItem, ItemError>[]): AsyncIterable<Result<ExternalItem, ItemError>> {
  await Promise.resolve()
  for (const r of results) yield r
}
async function* failingAfter(...results: Result<ExternalItem, ItemError>[]): AsyncIterable<Result<ExternalItem, ItemError>> {
  await Promise.resolve()
  for (const r of results) yield r
  throw new Error('Audiobookshelf stopped responding')
}

describe('syncSource', () => {
  const t = useTestDb()

  async function source() {
    const [s] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!s) throw new Error('no source')
    return s.id
  }
  async function pending() {
    return t.db.select().from(proposals).where(eq(proposals.status, 'pending'))
  }
  /** what accepting "create new book" in the Inbox does (Task 10), without the Inbox */
  async function link(sourceId: string, externalId: string) {
    const [si] = await t.db.select().from(sourceItems).where(eq(sourceItems.externalId, externalId))
    if (!si) throw new Error('no item')
    const { workId, editionId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, si.normalized, null))
    await t.db.update(sourceItems).set({ state: 'linked', editionId, workId }).where(eq(sourceItems.id, si.id))
    await t.db.update(proposals).set({ status: 'accepted' }).where(eq(proposals.sourceItemId, si.id))
    return { workId, editionId }
  }
  async function edition(editionId: string) {
    const [e] = await t.db.select().from(editions).where(eq(editions.id, editionId))
    return e
  }

  it('turns new items into pending proposals with ranked candidates', async () => {
    const sourceId = await source()
    const existing = await createWork(t.db, workInput({ title: 'The Final Empire', series: [] }))
    const outcome = await syncSource(t.db, sourceId, feed(ok(book()), ok(other)))
    expect(outcome).toMatchObject({ complete: true, error: null, stats: { seen: 2, created: 2, proposals: 2, removed: 0 } })
    const open = await pending()
    expect(open).toHaveLength(2)
    const forBook = open.find((p) => (p.payload as { item: { externalId: string } }).item.externalId === 'li_1')
    expect(forBook?.candidates[0]).toMatchObject({ workId: existing, basis: 'title_author' })
  })

  it('is idempotent: re-running changes nothing', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book()), ok(other)))
    const again = await syncSource(t.db, sourceId, feed(ok(book()), ok(other)))
    expect(again.stats).toMatchObject({ seen: 2, created: 0, changed: 0, unchanged: 2, proposals: 0, removed: 0 })
    expect(await pending()).toHaveLength(2)
    expect(await t.db.select().from(sourceItems)).toHaveLength(2)
  })

  it('replaces the pending proposal when a pending item changes', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book())))
    await syncSource(t.db, sourceId, feed(ok(book({ durationSec: 88_600 }))))
    const all = await t.db.select({ status: proposals.status }).from(proposals)
    expect(all.map((p) => p.status).sort()).toEqual(['pending', 'superseded'])
  })

  it('applies changes of a linked item to its edition', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book())))
    const { editionId } = await link(sourceId, 'li_1')
    const outcome = await syncSource(t.db, sourceId, feed(ok(book({ durationSec: 88_600 }))))
    expect(outcome.stats).toMatchObject({ changed: 1, proposals: 0 })
    expect((await edition(editionId))?.durationSec).toBe(88_600)
  })

  it('marks a copy gone only after a complete fetch, and brings it back when it returns', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book()), ok(other)))
    const { editionId } = await link(sourceId, 'li_1')

    const broken = await syncSource(t.db, sourceId, failingAfter(ok(other)))
    expect(broken).toMatchObject({ complete: false, error: 'Audiobookshelf stopped responding' })
    expect((await edition(editionId))?.inPossession).toBe(true)

    const gone = await syncSource(t.db, sourceId, feed(ok(other)))
    expect(gone.stats.removed).toBe(1)
    expect((await edition(editionId))?.inPossession).toBe(false)
    const events = await t.db
      .select({ type: editionHoldingEvents.type, origin: editionHoldingEvents.origin })
      .from(editionHoldingEvents)
      .where(and(eq(editionHoldingEvents.editionId, editionId), eq(editionHoldingEvents.type, 'removed')))
    expect(events).toEqual([{ type: 'removed', origin: 'sync' }])

    const back = await syncSource(t.db, sourceId, feed(ok(book()), ok(other)))
    expect(back.stats.restored).toBe(1)
    expect((await edition(editionId))?.inPossession).toBe(true)
  })

  it('offers the formerly owned copy first when it returns under a new id', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book())))
    const { editionId } = await link(sourceId, 'li_1')
    await syncSource(t.db, sourceId, feed(ok(other)))
    await syncSource(t.db, sourceId, feed(ok(book({ externalId: 'li_new' }))))
    const [proposal] = await pending()
    expect(proposal?.candidates[0]).toMatchObject({ editionId, basis: 'restore' })
  })

  it('does not mark every copy gone when the source suddenly lists nothing', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book())))
    const { editionId } = await link(sourceId, 'li_1')
    const outcome = await syncSource(t.db, sourceId, feed())
    expect(outcome).toMatchObject({ complete: true, stats: { removed: 0 } })
    expect(outcome.error).toMatch(/nothing was marked as gone/)
    expect((await edition(editionId))?.inPossession).toBe(true)
  })

  it('skips the removal pass entirely when an item could not be identified at all', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book())))
    const { editionId } = await link(sourceId, 'li_1')
    // an error with no externalId could be any of this source's items — we can't tell which one is
    // still there, so nothing gets marked gone even though li_1 was not seen in this fetch
    const outcome = await syncSource(t.db, sourceId, feed({ ok: false, error: { externalId: null, message: 'Completely unreadable record' } }))
    expect(outcome).toMatchObject({ complete: true, stats: { removed: 0 } })
    expect(outcome.error).toMatch(/could not be identified/)
    expect((await edition(editionId))?.inPossession).toBe(true)
  })

  it('returns complete:false, without rejecting, when the removal pass itself throws', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book()), ok(other)))
    await link(sourceId, 'li_1')
    const spy = vi.spyOn(sourceCatalog, 'removeEditionForSource').mockRejectedValue(new Error('disk on fire'))
    try {
      // li_1 is not in this feed, so the removal pass runs and tries to remove its (mocked) edition
      const outcome = await syncSource(t.db, sourceId, feed(ok(other)))
      expect(outcome).toMatchObject({ complete: false, error: 'disk on fire' })
    } finally {
      spy.mockRestore()
    }
  })

  it('records invalid items and keeps going', async () => {
    const sourceId = await source()
    const broken = { externalId: 'bad', format: 'audiobook', title: '' } as unknown as ExternalItem
    const outcome = await syncSource(t.db, sourceId, feed(ok(broken), { ok: false, error: { externalId: 'worse', message: 'Unreadable item' } }, ok(book())))
    expect(outcome.stats).toMatchObject({ invalid: 2, created: 1 })
    expect(outcome.stats.errors.map((e) => e.externalId)).toEqual(['bad', 'worse'])
  })

  it('records a non-object item as invalid instead of throwing', async () => {
    const sourceId = await source()
    const outcome = await syncSource(t.db, sourceId, feed(ok(null as unknown as ExternalItem), ok(book())))
    expect(outcome.stats).toMatchObject({ invalid: 1, created: 1 })
    expect(outcome.stats.errors).toHaveLength(1)
    expect(outcome.stats.errors[0]?.externalId).toBeNull()
    expect(typeof outcome.stats.errors[0]?.message).toBe('string')
  })

  it('does not treat an item it could not read this time as gone', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book()), ok(book({ externalId: 'li_1:ebook', format: 'ebook' }))))
    const { editionId } = await link(sourceId, 'li_1')
    const outcome = await syncSource(t.db, sourceId, feed({ ok: false, error: { externalId: 'li_1', message: 'Unreadable item' } }))
    expect(outcome.stats.removed).toBe(0)
    expect((await edition(editionId))?.inPossession).toBe(true)
    expect(await t.db.select().from(sourceItems).where(isNull(sourceItems.removedAt))).toHaveLength(2)
  })

  it('re-proposes a pending item that disappears and then returns', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book()), ok(other)))
    const gone = await syncSource(t.db, sourceId, feed(ok(other)))
    expect(gone.stats.removed).toBe(1)
    expect((await pending()).map((p) => (p.payload as { item: { externalId: string } }).item.externalId)).toEqual(['li_2'])

    const back = await syncSource(t.db, sourceId, feed(ok(book()), ok(other)))
    expect(back.stats).toMatchObject({ created: 0, proposals: 1 })
    const open = (await pending()).map((p) => (p.payload as { item: { externalId: string } }).item.externalId).sort()
    expect(open).toEqual(['li_1', 'li_2'])
    const [item] = await t.db.select().from(sourceItems).where(eq(sourceItems.externalId, 'li_1'))
    expect(item).toMatchObject({ state: 'pending', removedAt: null })
  })

  it('keeps a copy in possession while another item still backs it', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book()), ok(book({ externalId: 'li_1_copy' }))))
    const { editionId, workId } = await link(sourceId, 'li_1')
    // the person linked the second file to the same copy
    await t.db.update(sourceItems).set({ state: 'linked', editionId, workId }).where(eq(sourceItems.externalId, 'li_1_copy'))
    await t.db.update(proposals).set({ status: 'accepted' })

    const outcome = await syncSource(t.db, sourceId, feed(ok(book({ externalId: 'li_1_copy' }))))
    expect(outcome.stats.removed).toBe(1)
    expect((await edition(editionId))?.inPossession).toBe(true)
  })

  it('keeps an ignored item ignored when only its cover URL moves (the server URL changed)', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book({ coverUrl: 'http://abs.local:13378/api/items/li_1/cover' }))))
    await t.db.update(sourceItems).set({ state: 'ignored' })
    await t.db.update(proposals).set({ status: 'rejected' })
    const outcome = await syncSource(t.db, sourceId, feed(ok(book({ coverUrl: 'https://abs.example.com/api/items/li_1/cover' }))))
    expect(outcome.stats).toMatchObject({ unchanged: 1, proposals: 0 })
    const [item] = await t.db.select().from(sourceItems)
    expect(item?.state).toBe('ignored')
    expect(item?.normalized.coverUrl).toBe('https://abs.example.com/api/items/li_1/cover')
    expect(await pending()).toHaveLength(0)
  })

  it('keeps an ignored item ignored when only the whitespace of its description changes (an upgrade that cleans descriptions)', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book({ description: 'For a thousand years\n\n  the ash fell.' }))))
    await t.db.update(sourceItems).set({ state: 'ignored' })
    await t.db.update(proposals).set({ status: 'rejected' })
    const outcome = await syncSource(t.db, sourceId, feed(ok(book({ description: 'For a thousand years the ash fell.' }))))
    expect(outcome.stats).toMatchObject({ changed: 1, proposals: 0 })
    const [item] = await t.db.select().from(sourceItems)
    expect(item?.state).toBe('ignored')
    expect(item?.normalized.description).toBe('For a thousand years the ash fell.')
    expect(await pending()).toHaveLength(0)

    // a real change still deserves another look
    await syncSource(t.db, sourceId, feed(ok(book({ description: 'For a thousand years the ash fell, and no flowers bloomed.' }))))
    expect((await t.db.select().from(sourceItems))[0]?.state).toBe('pending')
    expect(await pending()).toHaveLength(1)
  })

  it('re-matches a linked item whose edition and work were deleted instead of crashing', async () => {
    const sourceId = await source()
    await syncSource(t.db, sourceId, feed(ok(book())))
    const { workId } = await link(sourceId, 'li_1')
    // deleting the work cascades to its editions; source_item.edition_id and work_id both become
    // NULL (ON DELETE SET NULL) but the item's state stays 'linked'
    await t.db.delete(works).where(eq(works.id, workId))

    const outcome = await syncSource(t.db, sourceId, feed(ok(book({ durationSec: 88_600 }))))
    expect(outcome.stats.proposals).toBe(1)
    const open = await pending()
    expect(open).toHaveLength(1)
    expect((open[0]?.payload as { item: { externalId: string } }).item.externalId).toBe('li_1')
    const [item] = await t.db.select().from(sourceItems).where(eq(sourceItems.externalId, 'li_1'))
    expect(item).toMatchObject({ state: 'pending', editionId: null, workId: null })
  })
})

describe('sync: wanted items and quiet sightings', () => {
  const t = useTestDb()
  const wanted = (over: Record<string, unknown> = {}) =>
    ExternalItem.parse({ externalId: 'book:11', format: 'ebook', title: 'Project Hail Mary', authors: ['Andy Weir'], wantedOnly: true, identifiers: { others: { readarrBookId: '11' } }, ...over })

  async function readarrSource() {
    const [source] = await t.db.insert(sources).values({ kind: 'readarr', name: 'Readarr', config: { kind: 'readarr' } }).returning()
    if (!source) throw new Error('no source')
    return source.id
  }

  it('files a monitored-but-missing book as a create_wanted proposal', async () => {
    const sourceId = await readarrSource()
    await syncSource(t.db, sourceId, feed(ok(wanted())))
    expect(await t.db.select({ kind: proposals.kind, scope: proposals.scope, status: proposals.status }).from(proposals)).toEqual([
      { kind: 'create_wanted', scope: 'catalog', status: 'pending' },
    ])
  })

  it('leaves a wanted placeholder linked to its book, without re-proposing it', async () => {
    const sourceId = await readarrSource()
    await syncSource(t.db, sourceId, feed(ok(wanted())))
    const [work] = await t.db.insert(works).values({ title: 'Project Hail Mary', sortTitle: 'project hail mary' }).returning({ id: works.id })
    await t.db.update(proposals).set({ status: 'accepted' })
    await t.db.update(sourceItems).set({ state: 'linked', workId: work?.id ?? null, editionId: null })
    const outcome = await syncSource(t.db, sourceId, feed(ok(wanted({ description: 'changed' }))))
    expect(outcome.stats.proposals).toBe(0)
    expect(await t.db.select({ state: sourceItems.state, workId: sourceItems.workId }).from(sourceItems)).toEqual([{ state: 'linked', workId: work?.id }])
  })

  it('re-proposes a wanted placeholder whose book was deleted', async () => {
    const sourceId = await readarrSource()
    await syncSource(t.db, sourceId, feed(ok(wanted())))
    await t.db.update(proposals).set({ status: 'accepted' })
    await t.db.update(sourceItems).set({ state: 'linked', workId: null, editionId: null })
    expect((await syncSource(t.db, sourceId, feed(ok(wanted())))).stats.proposals).toBe(1)
  })

  it('does not rewrite the stored record for an unchanged sighting, but does when the cover moves', async () => {
    const sourceId = await readarrSource()
    const item = wanted({ coverUrl: 'http://readarr/MediaCover/Books/11/cover.jpg?lastWrite=1' })
    await syncSource(t.db, sourceId, feed(ok(item)))
    await t.db.execute(sql`update source_item set raw = '{"marker": true}'::jsonb`)
    await syncSource(t.db, sourceId, feed(ok(item)))
    expect((await t.db.select({ raw: sourceItems.raw }).from(sourceItems))[0]?.raw).toEqual({ marker: true })
    await syncSource(t.db, sourceId, feed(ok({ ...item, coverUrl: 'http://readarr/MediaCover/Books/11/cover.jpg?lastWrite=2' })))
    const [row] = await t.db.select({ raw: sourceItems.raw, normalized: sourceItems.normalized }).from(sourceItems)
    expect(row?.raw).not.toEqual({ marker: true })
    expect(row?.normalized.coverUrl).toBe('http://readarr/MediaCover/Books/11/cover.jpg?lastWrite=2')
  })
})

describe('syncSource: the same files from two sources (#104)', () => {
  const t = useTestDb()
  const PATH = 'Brandon Sanderson/Mistborn/The Final Empire'
  const abs = (over: Record<string, unknown> = {}, path: string | null = PATH) =>
    book({ identifiers: { others: path === null ? { audiobookshelfId: 'li_1' } : { audiobookshelfId: 'li_1', libraryPath: path } }, ...over })
  // Chaptarr's own title for the same files, so only the path can tell
  const chaptarr = (over: Record<string, unknown> = {}, path: string | null = PATH) =>
    book({ externalId: 'book:7:audiobook', title: 'Mistborn: The Final Empire', identifiers: { others: path === null ? { chaptarrBookId: '7' } : { chaptarrBookId: '7', libraryPath: path } }, ...over })

  async function source(kind: 'audiobookshelf' | 'chaptarr') {
    const [s] = await t.db.insert(sources).values({ kind, name: kind, config: { kind } }).returning()
    if (!s) throw new Error('no source')
    return s.id
  }
  /** what creating a new book from the Inbox does, for an item already synced */
  async function linkNew(sourceId: string, externalId: string) {
    const [si] = await t.db.select().from(sourceItems).where(and(eq(sourceItems.sourceId, sourceId), eq(sourceItems.externalId, externalId)))
    if (!si) throw new Error('no item')
    const { workId, editionId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, si.normalized, null))
    await t.db.update(sourceItems).set({ state: 'linked', editionId, workId }).where(eq(sourceItems.id, si.id))
    await t.db.update(proposals).set({ status: 'accepted' }).where(eq(proposals.sourceItemId, si.id))
    return { workId, editionId }
  }
  async function itemOf(sourceId: string) {
    const [si] = await t.db.select().from(sourceItems).where(eq(sourceItems.sourceId, sourceId))
    return si
  }
  async function proposalsOf(sourceItemId: string | undefined) {
    if (sourceItemId === undefined) return []
    return t.db.select({ status: proposals.status, createdBy: proposals.createdBy, resolution: proposals.resolution }).from(proposals).where(eq(proposals.sourceItemId, sourceItemId))
  }

  it('links a new item to the copy another source already has for the same files, with no Inbox step', async () => {
    const absId = await source('audiobookshelf')
    const chId = await source('chaptarr')
    await syncSource(t.db, absId, feed(ok(abs())))
    const { workId, editionId } = await linkNew(absId, 'li_1')

    const outcome = await syncSource(t.db, chId, feed(ok(chaptarr())))
    expect(outcome.stats).toMatchObject({ created: 1, proposals: 0, linked: 1 })
    const item = await itemOf(chId)
    expect(item).toMatchObject({ state: 'linked', workId, editionId })
    expect(await proposalsOf(item?.id)).toEqual([{ status: 'accepted', createdBy: 'sync', resolution: { action: 'link_edition', editionId } }])
    expect(await t.db.select().from(editions)).toHaveLength(1)

    // and it stays that way: the next sync is quiet
    expect((await syncSource(t.db, chId, feed(ok(chaptarr())))).stats).toMatchObject({ unchanged: 1, proposals: 0, linked: 0 })
  })

  it('links a pending item once the other source has linked the same files, though the item itself did not change', async () => {
    const absId = await source('audiobookshelf')
    const chId = await source('chaptarr')
    await syncSource(t.db, chId, feed(ok(chaptarr())))
    expect((await itemOf(chId))?.state).toBe('pending')

    await syncSource(t.db, absId, feed(ok(abs())))
    const { editionId } = await linkNew(absId, 'li_1')
    const outcome = await syncSource(t.db, chId, feed(ok(chaptarr())))
    expect(outcome.stats).toMatchObject({ unchanged: 1, linked: 1, proposals: 0 })
    const item = await itemOf(chId)
    expect(item).toMatchObject({ state: 'linked', editionId })
    expect((await proposalsOf(item?.id)).map((p) => p.status).sort()).toEqual(['accepted', 'superseded'])
  })

  it('works the other way round: a new Audiobookshelf book joins the copy Chaptarr brought in', async () => {
    const absId = await source('audiobookshelf')
    const chId = await source('chaptarr')
    await syncSource(t.db, chId, feed(ok(chaptarr())))
    const { editionId } = await linkNew(chId, 'book:7:audiobook')
    expect((await syncSource(t.db, absId, feed(ok(abs())))).stats).toMatchObject({ linked: 1, proposals: 0 })
    expect(await itemOf(absId)).toMatchObject({ state: 'linked', editionId })
  })

  it('leaves it to a person without a path, for another format, for a copy that is gone, or when two copies share the path', async () => {
    const absId = await source('audiobookshelf')
    const chId = await source('chaptarr')
    await syncSource(t.db, absId, feed(ok(abs())))
    await linkNew(absId, 'li_1')

    // no path, or the ebook in the same folder
    await syncSource(t.db, chId, feed(ok(chaptarr({}, null)), ok(chaptarr({ externalId: 'book:7:ebook', format: 'ebook', durationSec: null }))))
    const pendingNow = await t.db.select().from(sourceItems).where(and(eq(sourceItems.sourceId, chId), eq(sourceItems.state, 'pending')))
    expect(pendingNow).toHaveLength(2)

    // a second copy at the same path: which one is meant is a person's call
    await syncSource(t.db, absId, feed(ok(abs()), ok(abs({ externalId: 'li_9', title: 'Another' }))))
    await linkNew(absId, 'li_9')
    const two = await source('chaptarr')
    expect((await syncSource(t.db, two, feed(ok(chaptarr())))).stats).toMatchObject({ linked: 0, proposals: 1 })

    // the only other copy's item is gone from its source
    await t.db.update(sourceItems).set({ removedAt: new Date() }).where(eq(sourceItems.sourceId, absId))
    const three = await source('chaptarr')
    expect((await syncSource(t.db, three, feed(ok(chaptarr())))).stats).toMatchObject({ linked: 0, proposals: 1 })
  })
})

describe('syncSource: an item that starts reporting its library path (#104)', () => {
  const t = useTestDb()

  it('stores the path without re-applying the item to its copy or reopening an ignored item', async () => {
    const [s] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!s) throw new Error('no source')
    const before = book({ identifiers: { others: { audiobookshelfId: 'li_1' } } })
    const ignored = other
    await syncSource(t.db, s.id, feed(ok(before), ok(ignored)))
    const [si] = await t.db.select().from(sourceItems).where(eq(sourceItems.externalId, 'li_1'))
    if (!si) throw new Error('no item')
    const { editionId } = await t.db.transaction((tx) => createWorkFromItem(tx, s.id, si.normalized, null))
    await t.db.update(sourceItems).set({ state: 'linked', editionId }).where(eq(sourceItems.id, si.id))
    await t.db.update(sourceItems).set({ state: 'ignored' }).where(eq(sourceItems.externalId, 'li_2'))
    await t.db.update(proposals).set({ status: 'accepted' })
    // someone cleared the duration on the copy; a re-reading of the same item must not put it back
    await t.db.update(editions).set({ durationSec: null }).where(eq(editions.id, editionId))
    const apply = vi.spyOn(sourceCatalog, 'applyItemToEdition')

    const withPath = (item: ExternalItem, path: string) => ({ ...item, identifiers: { ...item.identifiers, others: { ...item.identifiers.others, libraryPath: path } } })
    const outcome = await syncSource(t.db, s.id, feed(ok(withPath(before, 'A/One')), ok(withPath(ignored, 'A/Two'))))
    expect(outcome.stats).toMatchObject({ changed: 2, proposals: 0 })
    expect(apply).not.toHaveBeenCalled()
    apply.mockRestore()
    const rows = await t.db.select({ externalId: sourceItems.externalId, state: sourceItems.state, path: sql<string>`${sourceItems.normalized}->'identifiers'->'others'->>'libraryPath'` }).from(sourceItems)
    expect(rows.sort((a, b) => a.externalId.localeCompare(b.externalId))).toEqual([
      { externalId: 'li_1', state: 'linked', path: 'A/One' },
      { externalId: 'li_2', state: 'ignored', path: 'A/Two' },
    ])
    const [e] = await t.db.select({ durationSec: editions.durationSec }).from(editions).where(eq(editions.id, editionId))
    expect(e?.durationSec).toBeNull()
  })
})
