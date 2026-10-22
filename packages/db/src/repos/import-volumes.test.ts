import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CsvImportInput, ExternalItem, PageCapture } from '@mylib/domain'
import { sourceItems, sources } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail } from './catalog'
import { addEditionFromItem } from './source-catalog'
import { acceptMineExact, createMineUnmatched, importCsv, listMyProposals, resolveMyProposal } from './csv-import'
import { loadUserScope } from './scope'
import { attachPage, importShelf, previewShelf, setMyProposalVolume } from './shelf'

const translated: unknown = JSON.parse(readFileSync(new URL('../../../domain/src/providers/fixtures/simania-translated-series.json', import.meta.url), 'utf8'))
// the Simania capture with another title on its Book node
const simaniaCaptureWithTitle = (name: string): PageCapture => {
  const copy = structuredClone(translated) as { ld: Record<string, unknown>[] }
  const book = copy.ld.find((n) => n['@type'] === 'Book')
  if (book === undefined) throw new Error('no Book node')
  book['name'] = name
  return PageCapture.parse(copy)
}

const volumesCsv = (rows: string[][], over = {}) =>
  CsvImportInput.parse({ fileName: 'vols.csv', header: ['Title', 'Author'], rows, mapping: { columns: { title: 0, authors: 1 } }, ownership: 'owned', importId: randomUUID(), ...over })

describe('volumes from imports', () => {
  const t = useTestDb()

  it('two volume rows of one book, created in bulk, are one book with two volumes, in either order', async () => {
    // a different book per order: the second import must not match the first one's book
    for (const [title, order] of [['The Way of Kings', ['1', '2']], ['Words of Radiance', ['2', '1']]] as const) {
      const scope = await loadUserScope(t.db, await seedUser(t.db))
      await importCsv(t.db, scope, volumesCsv(order.map((v) => [`${title}, Part ${v} of 2`, 'Brandon Sanderson'])))
      const { created } = await createMineUnmatched(t.db, scope, '2026-10-14')
      expect(created).toBe(2)
      const linked = await t.db.select({ workId: sourceItems.workId }).from(sourceItems).innerJoin(sources, eq(sources.id, sourceItems.sourceId)).where(sql`${sources.config}->>'ownerUserId' = ${scope.userId}`)
      const workIds = [...new Set(linked.map((l) => l.workId))]
      expect(workIds).toHaveLength(1)
      const detail = await getWorkDetail(t.db, scope, workIds[0] ?? '')
      expect(detail.title).toBe(title)
      expect(detail.editions.map((e) => [e.volume, e.volumeCount]).sort()).toEqual([[1, 2], [2, 2]])
    }
  })

  it('"Create new book" on a second volume row joins the book the first one made', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await importCsv(t.db, scope, volumesCsv([["דרך המלכים כרך א'", 'סנדרסון'], ["דרך המלכים כרך ב'", 'סנדרסון']]))
    const { items } = await listMyProposals(t.db, scope)
    const first = await resolveMyProposal(t.db, scope, items[0]?.id ?? '', { action: 'create_work' }, '2026-10-14')
    const second = await resolveMyProposal(t.db, scope, items[1]?.id ?? '', { action: 'create_work' }, '2026-10-14')
    expect(second.workId).toBe(first.workId)
  })

  it('a later import of volume 2 is a new-volume candidate of the book with volume 1, never its copy', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'דרך המלכים', authors: ['סנדרסון'], series: [], editions: [{ format: 'physical', language: 'he', volume: 1, volumeCount: 2 }] }))
    await importCsv(t.db, scope, volumesCsv([["דרך המלכים כרך ב'", 'סנדרסון', 'he']], { header: ['Title', 'Author', 'Language'], mapping: { columns: { title: 0, authors: 1, language: 2 } } }))
    const [entry] = (await listMyProposals(t.db, scope)).items
    expect(entry?.candidates[0]).toMatchObject({ workId, editionId: null, volume: { number: 2, have: [1], size: 2 } })
  })

  it('adding a volume without a language joins the set; a count below the set is dropped, not refused', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Saga', series: [], editions: [{ format: 'physical', language: 'he', volume: 3, volumeCount: 3 }] }))
    await importCsv(t.db, scope, volumesCsv([['Saga, Part 2 of 2', 'X']]))
    const [entry] = (await listMyProposals(t.db, scope)).items
    await resolveMyProposal(t.db, scope, entry?.id ?? '', { action: 'link_new_edition', workId }, '2026-10-14')
    const detail = await getWorkDetail(t.db, scope, workId)
    expect(detail.editions.find((e) => e.volume === 2)).toMatchObject({ language: 'he', volumeCount: 3 })
  })

  it('"Accept all exact matches" adds an identified new volume as a new edition', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Saga', series: [], editions: [{ format: 'physical', volume: 1, isbn13: '9780306406157' }] }))
    // the row carries volume 1's ISBN but says volume 2 (a data slip): still a new edition, never volume 1's copy
    await importCsv(t.db, scope, CsvImportInput.parse({ fileName: 'x.csv', header: ['Title', 'ISBN'], rows: [['Saga, Part 2', '9780306406157']], mapping: { columns: { title: 0, isbn: 1 } }, ownership: 'owned', importId: randomUUID() }))
    await acceptMineExact(t.db, scope, '2026-10-14')
    const detail = await getWorkDetail(t.db, scope, workId)
    expect(detail.editions.map((e) => e.volume).sort()).toEqual([1, 2])
  })

  it('the shelf preview says new_volume for a volume the set lacks, and two volumes in one batch are not repeats', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await createWork(t.db, workInput({ title: 'דרך המלכים', authors: ['סנדרסון'], series: [], editions: [{ format: 'physical', language: 'he', volume: 1, volumeCount: 2 }] }))
    const row = { title: 'דרך המלכים', subtitle: null, authors: ['סנדרסון'], translators: [], publisher: null, series: null, seriesNumber: null, language: 'he', spineText: null, originalTitle: null, confidence: 'high' as const, notes: null, volumeCount: null, volumeSet: false, capture: null }
    const { statuses } = await previewShelf(t.db, scope, { rows: [{ ...row, volume: 2 }, { ...row, title: 'ספר אחר', volume: 1 }, { ...row, title: 'ספר אחר', volume: 2 }] })
    expect(statuses[0]).toMatchObject({ kind: 'new_volume', volume: { number: 2, have: [1] } })
    expect(statuses[2]?.kind).not.toBe('repeat')
  })

  it('a count the import carries never overwrites the established count of the set', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Saga', series: [], editions: [{ format: 'physical', language: 'he', volume: 1, volumeCount: 3 }] }))
    await importCsv(t.db, scope, volumesCsv([['Saga, Part 2 of 2', 'X']]))
    const [entry] = (await listMyProposals(t.db, scope)).items
    await resolveMyProposal(t.db, scope, entry?.id ?? '', { action: 'link_new_edition', workId }, '2026-10-14')
    const detail = await getWorkDetail(t.db, scope, workId)
    expect(detail.editions.map((e) => [e.volume, e.volumeCount]).sort()).toEqual([[1, 3], [2, 3]])
  })

  it('a pending row can be told its volume, or that it is not one, and a linked page does not undo it', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await importCsv(t.db, scope, volumesCsv([['Saga, Part 1', 'X']]))
    const [entry] = (await listMyProposals(t.db, scope)).items
    await setMyProposalVolume(t.db, scope, entry?.id ?? '', { number: 3, count: 4 })
    expect((await listMyProposals(t.db, scope)).items[0]).toMatchObject({ item: { volume: { number: 3, count: 4 } }, volumeOverride: { number: 3, count: 4 } })
    await setMyProposalVolume(t.db, scope, entry?.id ?? '', null)
    const none = (await listMyProposals(t.db, scope)).items[0]
    expect(none?.item.volume).toBeNull()
    expect(none?.volumeOverride).toBeNull()
    // linking a page whose title says "כרך ב'" keeps the person's "not a volume"
    await attachPage(t.db, scope, entry?.id ?? '', simaniaCaptureWithTitle("ספר - כרך ב'"))
    expect((await listMyProposals(t.db, scope)).items[0]?.item.volume).toBeNull()
  })

  it('"not a volume" on a shelf proposal brings back the title as printed, and a volume cleans it again', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const row = { title: 'Henry IV, Part 1', subtitle: null, authors: ['Shakespeare'], translators: [], publisher: null, series: null, seriesNumber: null, language: 'en', spineText: null, originalTitle: null, confidence: 'high' as const, notes: null, volume: null, volumeCount: null, volumeSet: false }
    await importShelf(t.db, scope, { batchId: randomUUID(), label: 'Shelf', ownership: 'owned', borrowedFrom: null, rows: [{ row, preset: null, capture: null }] })
    const [entry] = (await listMyProposals(t.db, scope)).items
    expect(entry?.item).toMatchObject({ title: 'Henry IV', volume: { number: 1, count: null } })
    await setMyProposalVolume(t.db, scope, entry?.id ?? '', null)
    expect((await listMyProposals(t.db, scope)).items[0]?.item).toMatchObject({ title: 'Henry IV, Part 1', volume: null })
    await setMyProposalVolume(t.db, scope, entry?.id ?? '', { number: 1, count: null })
    expect((await listMyProposals(t.db, scope)).items[0]?.item).toMatchObject({ title: 'Henry IV', volume: { number: 1, count: null } })
  })

  it('a linked page whose title has a marker keeps it when the person said "not a volume"', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const row = { title: 'x', subtitle: null, authors: [], translators: [], publisher: null, series: null, seriesNumber: null, language: 'en', spineText: null, originalTitle: null, confidence: 'high' as const, notes: null, volume: null, volumeCount: null, volumeSet: true }
    const capture = simaniaCaptureWithTitle('Henry IV, Part 1')
    await importShelf(t.db, scope, { batchId: randomUUID(), label: 'Shelf', ownership: 'owned', borrowedFrom: null, rows: [{ row, preset: null, capture }] })
    const [entry] = (await listMyProposals(t.db, scope)).items
    expect(entry?.item).toMatchObject({ title: 'Henry IV, Part 1', volume: null })
    // and the same through a page linked after the choice
    await importCsv(t.db, scope, volumesCsv([['Other', 'X']]))
    const other = (await listMyProposals(t.db, scope)).items.find((i) => i.item.title === 'Other')
    await setMyProposalVolume(t.db, scope, other?.id ?? '', null)
    await attachPage(t.db, scope, other?.id ?? '', capture)
    expect((await listMyProposals(t.db, scope)).items.find((i) => i.id === other?.id)?.item).toMatchObject({ title: 'Henry IV, Part 1', volume: null })
    await setMyProposalVolume(t.db, scope, other?.id ?? '', { number: 1, count: null })
    expect((await listMyProposals(t.db, scope)).items.find((i) => i.id === other?.id)?.item).toMatchObject({ title: 'Henry IV', volume: { number: 1, count: null } })
  })

  it("someone else's row, or one already handled, cannot be changed", async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const other = await loadUserScope(t.db, await seedUser(t.db))
    await importCsv(t.db, scope, volumesCsv([['Saga, Part 1', 'X']]))
    const [entry] = (await listMyProposals(t.db, scope)).items
    await expect(setMyProposalVolume(t.db, other, entry?.id ?? '', { number: 2, count: null })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await resolveMyProposal(t.db, scope, entry?.id ?? '', { action: 'create_work' }, '2026-10-14')
    await expect(setMyProposalVolume(t.db, scope, entry?.id ?? '', { number: 2, count: null })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('a shelf row the person set to "not a volume" previews and imports without one', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    await createWork(t.db, workInput({ title: 'דרך המלכים', authors: ['סנדרסון'], series: [], editions: [{ format: 'physical', language: 'he', volume: 1, volumeCount: 2 }] }))
    const row = { title: "דרך המלכים כרך ב'", subtitle: null, authors: ['סנדרסון'], translators: [], publisher: null, series: null, seriesNumber: null, language: 'he', spineText: null, originalTitle: null, confidence: 'high' as const, notes: null, volume: null, volumeCount: null, volumeSet: true }
    // the marker alone would make this a new volume of the book; the person said it is not one
    const { statuses } = await previewShelf(t.db, scope, { rows: [{ ...row, capture: null }] })
    expect(statuses[0]?.kind).not.toBe('new_volume')
    await importShelf(t.db, scope, { batchId: randomUUID(), label: 'Shelf', ownership: 'owned', borrowedFrom: null, rows: [{ row, preset: null, capture: null }] })
    const [entry] = (await listMyProposals(t.db, scope)).items
    expect(entry?.item).toMatchObject({ title: "דרך המלכים כרך ב'", volume: null })
  })

  it('a volume joins the set matching showed, taking its language (null set, "he" item)', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Saga', authors: ['X'], series: [], editions: [{ format: 'physical', language: null, volume: 1, volumeCount: null }] }))
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    const volumeItem = ExternalItem.parse({ externalId: 'v2', format: 'physical', title: 'Saga', authors: ['X'], language: 'he', volume: { number: 2, count: null } })
    await t.db.transaction((tx) => addEditionFromItem(tx, source?.id ?? '', workId, volumeItem, null))
    const eds = (await getWorkDetail(t.db, scope, workId)).editions.map((e) => [e.volume, e.language])
    expect(eds.sort()).toEqual([[1, null], [2, null]])
  })

  it('an imported volume above the set count clears the count of the whole set; one within it keeps it', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    const counts = async (workId: string) => (await getWorkDetail(t.db, scope, workId)).editions.map((e) => [e.volume, e.volumeCount]).sort()
    const add = (workId: string, number: number) =>
      t.db.transaction((tx) => addEditionFromItem(tx, source?.id ?? '', workId, ExternalItem.parse({ externalId: `v${number}-${workId}`, format: 'physical', title: 'Saga', authors: ['X'], language: 'he', volume: { number, count: null } }), null))
    const two = await createWork(t.db, workInput({ title: 'Saga', authors: ['X'], series: [], editions: [1, 2].map((volume) => ({ format: 'physical' as const, language: 'he', volume, volumeCount: 2 })) }))
    await add(two, 3)
    expect(await counts(two)).toEqual([[1, null], [2, null], [3, null]])
    const three = await createWork(t.db, workInput({ title: 'Saga', authors: ['X'], series: [], editions: [{ format: 'physical', language: 'he', volume: 1, volumeCount: 3 }] }))
    await add(three, 2)
    expect(await counts(three)).toEqual([[1, 3], [2, 3]])
  })

  it('a volume corrected in the shelf review survives linking a page later', async () => {
    for (const volume of [null, 3]) {
      const scope = await loadUserScope(t.db, await seedUser(t.db))
      const row = { title: 'דרך המלכים', subtitle: null, authors: ['סנדרסון'], translators: [], publisher: null, series: null, seriesNumber: null, language: 'he', spineText: null, originalTitle: null, confidence: 'high' as const, notes: null, volume, volumeCount: null, volumeSet: true }
      await importShelf(t.db, scope, { batchId: randomUUID(), label: 'Shelf', ownership: 'owned', borrowedFrom: null, rows: [{ row, preset: null, capture: null }] })
      const [entry] = (await listMyProposals(t.db, scope)).items
      const before = entry?.item.volume
      await attachPage(t.db, scope, entry?.id ?? '', simaniaCaptureWithTitle("ספר - כרך ב'"))
      expect((await listMyProposals(t.db, scope)).items[0]?.item.volume).toEqual(before)
    }
  })
})
