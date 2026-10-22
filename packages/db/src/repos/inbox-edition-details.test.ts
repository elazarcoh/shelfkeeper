import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { CsvImportInput, EditionInput, ExternalItem, ok, type ItemError, type Result } from '@mylib/domain'
import { editionHoldingEvents, editions, proposals, sources } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail } from './catalog'
import { importCsv, listMyProposals, resolveMyProposal } from './csv-import'
import { listInbox, resolveSourceMatch } from './inbox'
import { loadUserScope } from './scope'
import { syncSource } from './sync'

const audiobook = (over: Record<string, unknown> = {}) =>
  ExternalItem.parse({ externalId: 'li_1', format: 'audiobook', title: 'The Final Empire', authors: ['Brandon Sanderson'], narrators: ['Michael Kramer'], publisher: 'Macmillan', durationSec: 88_000, ...over })

async function* feed(...items: ExternalItem[]): AsyncIterable<Result<ExternalItem, ItemError>> {
  await Promise.resolve()
  for (const i of items) yield ok(i)
}

const csv = (rows: string[][], over: Record<string, unknown> = {}) =>
  CsvImportInput.parse({ fileName: 'x.csv', header: ['Title', 'Author'], rows, mapping: { columns: { title: 0, authors: 1 } }, ownership: 'owned', importId: randomUUID(), ...over })

const form = (over: Partial<EditionInput> = {}): EditionInput => EditionInput.parse({ format: 'physical', ...over })

describe('Inbox: adding with the edition form (#121)', () => {
  const t = useTestDb()

  async function sourceSetup(item: ExternalItem) {
    const scope = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'Home ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!source) throw new Error('no source')
    await syncSource(t.db, source.id, feed(item))
    const [entry] = (await listInbox(t.db, scope)).items
    return { scope, sourceId: source.id, proposalId: entry?.id ?? '' }
  }

  it('source item: stores the form, locks what changed, keeps the rest source-provided and found-in-source', async () => {
    const { scope, sourceId, proposalId } = await sourceSetup(audiobook())
    const workId = await createWork(t.db, workInput({ title: 'The Final Empire', series: [], editions: [{ format: 'physical' }] }))
    const edition = form({ format: 'audiobook', publisher: 'Macmillan', durationSec: 90_000, narrators: ['Michael Kramer'], volume: 1, volumeCount: 3 })
    await resolveSourceMatch(t.db, scope, proposalId, { action: 'link_new_edition', workId, edition })
    const added = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.format === 'audiobook')
    expect(added).toMatchObject({ durationSec: 90_000, volume: 1, volumeCount: 3, ownership: 'owned', inPossession: true })
    expect(added?.provenance.durationSec).toMatchObject({ origin: 'manual', locked: true })
    expect(added?.provenance.volume).toMatchObject({ origin: 'manual', locked: true })
    expect(added?.provenance.publisher).toMatchObject({ origin: 'source', sourceId, locked: false })
    const [event] = await t.db.select().from(editionHoldingEvents).where(eq(editionHoldingEvents.editionId, added?.id ?? ''))
    expect(event).toMatchObject({ type: 'acquired', origin: 'sync', note: 'Found in a source' })
  })

  it('an untouched duration the form rounded to whole minutes stays exact, source-provided and unlocked', async () => {
    const { scope, sourceId, proposalId } = await sourceSetup(audiobook())
    const workId = await createWork(t.db, workInput({ title: 'The Final Empire', series: [], editions: [{ format: 'physical' }] }))
    await resolveSourceMatch(t.db, scope, proposalId, { action: 'link_new_edition', workId, edition: form({ format: 'audiobook', publisher: 'Macmillan', durationSec: 88_020, narrators: ['Michael Kramer'] }) })
    const added = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.format === 'audiobook')
    expect(added?.durationSec).toBe(88_000)
    expect(added?.provenance.durationSec).toMatchObject({ origin: 'source', sourceId, locked: false })
  })

  it('format change: an audiobook filed as physical is physical, with format locked', async () => {
    const { scope, proposalId } = await sourceSetup(audiobook())
    const workId = await createWork(t.db, workInput({ title: 'The Final Empire', series: [], editions: [{ format: 'ebook' }] }))
    await resolveSourceMatch(t.db, scope, proposalId, { action: 'link_new_edition', workId, edition: form({ format: 'physical', publisher: 'Macmillan', pageCount: 541 }) })
    const added = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.format === 'physical')
    expect(added).toMatchObject({ pageCount: 541, durationSec: null, narrators: [] })
    expect(added?.provenance.format).toMatchObject({ origin: 'manual', locked: true })
    expect(added?.provenance.durationSec).toMatchObject({ origin: 'manual', locked: true })
  })

  it('cleared field: a publisher erased in the form is stored null and locked', async () => {
    const { scope, proposalId } = await sourceSetup(audiobook())
    const workId = await createWork(t.db, workInput({ title: 'The Final Empire', series: [] }))
    await resolveSourceMatch(t.db, scope, proposalId, { action: 'link_new_edition', workId, edition: form({ format: 'audiobook', durationSec: 88_000, narrators: ['Michael Kramer'], publisher: null }) })
    const added = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.format === 'audiobook')
    expect(added?.publisher).toBeNull()
    expect(added?.provenance.publisher).toMatchObject({ origin: 'manual', locked: true })
  })

  it('CSV row: volume 2 of 3 on a book with no volume set starts the set', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Saga', authors: ['X'], series: [], editions: [{ format: 'physical' }] }))
    await importCsv(t.db, scope, csv([['Saga', 'X']]))
    const [entry] = (await listMyProposals(t.db, scope)).items
    await resolveMyProposal(t.db, scope, entry?.id ?? '', { action: 'link_new_edition', workId, edition: form({ volume: 2, volumeCount: 3 }) }, '2026-10-18')
    const detail = await getWorkDetail(t.db, scope, workId)
    expect(detail.editions.map((e) => [e.volume, e.volumeCount]).sort()).toEqual([[null, null], [2, 3]])
  })

  it('joins an existing set in another language than the item, and adopts its count', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Saga', authors: ['X'], series: [], editions: [{ format: 'physical', language: 'he', volume: 1, volumeCount: 3 }] }))
    await importCsv(t.db, scope, csv([['Saga', 'X', 'en']], { header: ['Title', 'Author', 'Language'], mapping: { columns: { title: 0, authors: 1, language: 2 } } }))
    const [entry] = (await listMyProposals(t.db, scope)).items
    await resolveMyProposal(t.db, scope, entry?.id ?? '', { action: 'link_new_edition', workId, edition: form({ language: 'he', volume: 2 }) }, '2026-10-18')
    const detail = await getWorkDetail(t.db, scope, workId)
    expect(detail.editions.find((e) => e.volume === 2)).toMatchObject({ language: 'he', volumeCount: 3 })
  })

  it('a count below an existing volume is refused and nothing is written', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Saga', authors: ['X'], series: [], editions: [{ format: 'physical', volume: 4 }] }))
    await importCsv(t.db, scope, csv([['Saga', 'X']]))
    const [entry] = (await listMyProposals(t.db, scope)).items
    await expect(resolveMyProposal(t.db, scope, entry?.id ?? '', { action: 'link_new_edition', workId, edition: form({ volume: 2, volumeCount: 3 }) }, '2026-10-18')).rejects.toMatchObject({ code: 'INVALID' })
    expect(await t.db.select().from(editions).where(eq(editions.workId, workId))).toHaveLength(1)
    const [p] = await t.db.select({ status: proposals.status }).from(proposals).where(eq(proposals.id, entry?.id ?? ''))
    expect(p?.status).toBe('pending')
  })

  it('borrowed in the form: a borrowed holding dated by the form, noted with who from', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Saga', authors: ['X'], series: [] }))
    await importCsv(t.db, scope, csv([['Saga', 'X']]))
    const [entry] = (await listMyProposals(t.db, scope)).items
    await resolveMyProposal(t.db, scope, entry?.id ?? '', { action: 'link_new_edition', workId, edition: form({ ownership: 'borrowed', holdingOn: '2026-10-01', holdingNote: 'Dana' }) }, '2026-10-18')
    const added = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.ownership === 'borrowed')
    expect(added).toMatchObject({ inPossession: true })
    const [event] = await t.db.select().from(editionHoldingEvents).where(eq(editionHoldingEvents.editionId, added?.id ?? ''))
    expect(event).toMatchObject({ type: 'borrowed', occurredOn: '2026-10-01', note: 'Dana', origin: 'manual' })
  })

  it('a borrowed CSV row filed as owned with a blank note falls back to the import note', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Saga', authors: ['X'], series: [] }))
    await importCsv(t.db, scope, csv([['Saga', 'X']], { ownership: 'borrowed' }))
    const [entry] = (await listMyProposals(t.db, scope)).items
    await resolveMyProposal(t.db, scope, entry?.id ?? '', { action: 'link_new_edition', workId, edition: form({ ownership: 'owned', pageCount: 300 }) }, '2026-10-18')
    const added = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.pageCount === 300)
    const [event] = await t.db.select().from(editionHoldingEvents).where(eq(editionHoldingEvents.editionId, added?.id ?? ''))
    expect(event).toMatchObject({ type: 'acquired', note: 'Imported from a CSV file' })
  })

  it('a read-not-owned row keeps the import holding whatever the form says', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Saga', authors: ['X'], series: [] }))
    await importCsv(t.db, scope, csv([['Saga', 'X']], { ownership: 'read_not_owned' }))
    const [entry] = (await listMyProposals(t.db, scope)).items
    await resolveMyProposal(t.db, scope, entry?.id ?? '', { action: 'link_new_edition', workId, edition: form({ pageCount: 300 }) }, '2026-10-18')
    const added = (await getWorkDetail(t.db, scope, workId)).editions.find((e) => e.pageCount === 300)
    expect(added).toMatchObject({ ownership: 'borrowed', inPossession: false })
  })

  it('a want-to-read row refuses the form', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db))
    const workId = await createWork(t.db, workInput({ title: 'Saga', authors: ['X'], series: [] }))
    await importCsv(t.db, scope, csv([['Saga', 'X', 'to-read']], { header: ['Title', 'Author', 'Exclusive Shelf'], mapping: { columns: { title: 0, authors: 1, shelf: 2 } } }))
    const [entry] = (await listMyProposals(t.db, scope)).items
    expect(entry?.shelf).toBe('want')
    await expect(resolveMyProposal(t.db, scope, entry?.id ?? '', { action: 'link_new_edition', workId, edition: form() }, '2026-10-18')).rejects.toMatchObject({ code: 'INVALID' })
  })
})
