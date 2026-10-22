import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { ExternalItem, markManual } from '@mylib/domain'
import { editionHoldingEvents, editions, sources, works } from '../schema'
import { seedUser, useTestDb } from '../testing'
import { changeHolding, getWorkDetail } from './catalog'
import { loadUserScope } from './scope'
import {
  addEditionFromItem,
  applyItemToEdition,
  createWorkFromItem,
  importHolding,
  removeEditionForSource,
  restoreEditionForSource,
  UNKNOWN_AUTHOR,
} from './source-catalog'

const item = (over: Record<string, unknown> = {}) =>
  ExternalItem.parse({
    externalId: 'li_1',
    format: 'audiobook',
    title: 'The Final Empire',
    subtitle: 'Mistborn Book One',
    authors: ['Brandon Sanderson'],
    narrators: ['Michael Kramer'],
    series: [{ name: 'Mistborn', position: 1 }],
    identifiers: { asin: 'B002UZMLXM' },
    durationSec: 88_000,
    description: 'Ash falls.',
    tags: ['Fantasy'],
    ...over,
  })

describe('catalog writes from a source item', () => {
  const t = useTestDb()

  async function setup() {
    const user = await seedUser(t.db, { role: 'admin' })
    const scope = await loadUserScope(t.db, user)
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!source) throw new Error('no source')
    return { user, scope, sourceId: source.id }
  }

  it('creates a book whose fields come from the source, unlocked', async () => {
    const { user, scope, sourceId } = await setup()
    const { workId, editionId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, item(), user.id))
    const detail = await getWorkDetail(t.db, scope, workId)
    expect(detail).toMatchObject({ title: 'The Final Empire', subtitle: 'Mistborn Book One', authors: [{ name: 'Brandon Sanderson' }], series: [{ name: 'Mistborn', position: 1 }] })
    expect(detail.provenance.title).toMatchObject({ origin: 'source', sourceId, locked: false })
    const edition = detail.editions.find((e) => e.id === editionId)
    expect(edition).toMatchObject({ format: 'audiobook', asin: 'B002UZMLXM', durationSec: 88_000, narrators: [{ name: 'Michael Kramer' }] })
    expect(edition?.provenance.durationSec).toMatchObject({ origin: 'source', locked: false })
    expect(edition?.history).toMatchObject([{ type: 'acquired', origin: 'sync' }])
  })

  it('uses "Unknown author" when the source has none', async () => {
    const { user, scope, sourceId } = await setup()
    const { workId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, item({ authors: [] }), user.id))
    expect((await getWorkDetail(t.db, scope, workId)).authors.map((a) => a.name)).toEqual([UNKNOWN_AUTHOR])
  })

  it('adds an edition to an existing book', async () => {
    const { user, scope, sourceId } = await setup()
    const { workId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, item(), user.id))
    await t.db.transaction((tx) => addEditionFromItem(tx, sourceId, workId, item({ externalId: 'li_1:ebook', format: 'ebook', narrators: [] }), user.id))
    expect((await getWorkDetail(t.db, scope, workId)).editions.map((e) => e.format).sort()).toEqual(['audiobook', 'ebook'])
  })

  it('applies unlocked changes, skips locked ones, and never renames the book', async () => {
    const { user, scope, sourceId } = await setup()
    const { workId, editionId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, item(), user.id))
    // a person corrected the publisher by hand: it is locked now
    await t.db.update(editions).set({ publisher: 'Macmillan Audio', provenance: markManual({}, ['publisher'], new Date()) }).where(eq(editions.id, editionId))

    const changed = await t.db.transaction((tx) =>
      applyItemToEdition(tx, sourceId, editionId, item({ title: 'Renamed In ABS', durationSec: 88_500, publisher: 'Other', description: 'Ash falls. Again.' })),
    )
    expect(changed.sort()).toEqual(['durationSec', 'work.description'])
    const detail = await getWorkDetail(t.db, scope, workId)
    expect(detail.title).toBe('The Final Empire')
    expect(detail.description).toBe('Ash falls. Again.')
    expect(detail.editions[0]).toMatchObject({ durationSec: 88_500, publisher: 'Macmillan Audio' })
  })

  it('a sequence that becomes a range updates the series, unless a person locked it (#122)', async () => {
    const { user, scope, sourceId } = await setup()
    const { workId, editionId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, item(), user.id))
    const ranged = item({ series: [{ name: 'Mistborn', position: 1, positionEnd: 2 }] })
    expect(await t.db.transaction((tx) => applyItemToEdition(tx, sourceId, editionId, ranged))).toContain('work.series')
    expect((await getWorkDetail(t.db, scope, workId)).series).toMatchObject([{ name: 'Mistborn', position: 1, positionEnd: 2 }])

    const other = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, item({ externalId: 'li_2', title: 'Other' }), user.id))
    await t.db.update(works).set({ provenance: markManual({}, ['series'], new Date()) }).where(eq(works.id, other.workId))
    expect(await t.db.transaction((tx) => applyItemToEdition(tx, sourceId, other.editionId, ranged))).not.toContain('work.series')
    expect((await getWorkDetail(t.db, scope, other.workId)).series).toMatchObject([{ position: 1, positionEnd: null }])
  })

  it('leaves unchanged narrators alone when the edition also has a translator', async () => {
    const { user, sourceId } = await setup()
    const translated = item({ translators: ['Tal Ron'] })
    const { editionId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, translated, user.id))
    expect(await t.db.transaction((tx) => applyItemToEdition(tx, sourceId, editionId, translated))).toEqual([])
  })

  it('marks a copy gone and back with sync-origin events, only when that applies', async () => {
    const { user, sourceId } = await setup()
    const { editionId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, item(), user.id))
    const at = new Date('2026-09-27T12:00:00Z')
    expect(await t.db.transaction((tx) => removeEditionForSource(tx, editionId, at))).toBe(true)
    expect(await t.db.transaction((tx) => removeEditionForSource(tx, editionId, at))).toBe(false)
    expect(await t.db.transaction((tx) => restoreEditionForSource(tx, editionId, at, null, { onlyUndoSync: true }))).toBe(true)
    const events = await t.db.select().from(editionHoldingEvents).where(eq(editionHoldingEvents.editionId, editionId))
    expect(events.map((e) => [e.type, e.origin]).sort()).toEqual([
      ['acquired', 'sync'],
      ['removed', 'sync'],
      ['restored', 'sync'],
    ])
  })

  it('never overrides a person’s "No longer have it" when the item comes back', async () => {
    const { user, scope, sourceId } = await setup()
    const { editionId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, item(), user.id))
    await changeHolding(t.db, scope, editionId, { action: 'no_longer_have', on: '2026-09-20', note: null })
    expect(await t.db.transaction((tx) => restoreEditionForSource(tx, editionId, new Date(), null, { onlyUndoSync: true }))).toBe(false)
    const [edition] = await t.db.select().from(editions).where(eq(editions.id, editionId))
    expect(edition?.inPossession).toBe(false)
  })

  it('restores an owned copy that is not in possession when told not to only-undo-sync, regardless of why it was removed', async () => {
    const { user, scope, sourceId } = await setup()
    const { editionId } = await t.db.transaction((tx) => createWorkFromItem(tx, sourceId, item(), user.id))
    await changeHolding(t.db, scope, editionId, { action: 'no_longer_have', on: '2026-09-20', note: null })
    expect(await t.db.transaction((tx) => restoreEditionForSource(tx, editionId, new Date(), scope.userId, { onlyUndoSync: false }))).toBe(true)
    const [edition] = await t.db.select().from(editions).where(eq(editions.id, editionId))
    expect(edition?.inPossession).toBe(true)
    const events = await t.db.select().from(editionHoldingEvents).where(eq(editionHoldingEvents.editionId, editionId))
    const restored = events.find((e) => e.type === 'restored')
    expect(restored).toMatchObject({ origin: 'manual', actorUserId: scope.userId })
  })
})

describe('shelf imports', () => {
  const t = useTestDb()

  it('writes the item translators onto the new edition', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const [source] = await t.db.insert(sources).values({ kind: 'shelf', name: 'Shelf · 12 Oct', config: { kind: 'shelf' }, schedule: null }).returning({ id: sources.id })
    const shelfItem = ExternalItem.parse({ externalId: 'photo:1', format: 'physical', title: 'הקמיע מסמרקנד', authors: ["ג'ונתן סטראוד"], translators: ['אורי בלסם'] })
    if (!source) throw new Error('source insert failed')
    const { workId } = await createWorkFromItem(t.db, source.id, shelfItem, user.id, importHolding('owned', '2026-10-12', { note: 'Added from a shelf photo' }))
    const detail = await getWorkDetail(t.db, scope, workId)
    expect(detail.editions[0]?.translators.map((p) => p.name)).toEqual(['אורי בלסם'])
  })

  it('importHolding: borrowed is a copy in hand, noted with whom', () => {
    expect(importHolding('borrowed', '2026-10-12', { note: 'Added from a shelf photo', borrowedFrom: 'דנה' })).toEqual({
      ownership: 'borrowed', inPossession: true, event: { type: 'borrowed', note: 'דנה', origin: 'manual', occurredOn: '2026-10-12' },
    })
    expect(importHolding('owned', '2026-10-12', { note: 'Imported from a CSV file' }).event.note).toBe('Imported from a CSV file')
  })
})
