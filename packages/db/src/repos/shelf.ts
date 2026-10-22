import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  CsvRowPayload,
  DomainError,
  PageCapture,
  extractErrorMessage,
  extractPage,
  externalItemFingerprint,
  withVolumeOverride,
  mergeLinkedPage,
  notFound,
  providers,
  sameShelfBook,
  shelfStatus,
  toExternalItem,
  type ExternalItem,
  type ExtractedPage,
  type ItemVolume,
  type MatchCandidate,
  type PhotoExtras,
  type ShelfAddOneInput,
  type ShelfImportInput,
  type ShelfPreviewInput,
  type ShelfRow,
  type ShelfStatus,
  type SourceKind,
} from '@mylib/domain'
import type { Db } from '../client'
import { editions, proposals, sourceItems, sources } from '../schema'
import { coverAssetRow } from './catalog'
import { listMyProposals, resolveMyProposal } from './csv-import'
import { hydrateCandidates } from './inbox'
import { findCandidates } from './match'
import { visibleWorkIds, type UserScope } from './scope'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const STORED_CANDIDATES = 10
/** a source id no item belongs to: preview has no source yet, so restore/shared-id scoping matches nothing */
const NIL_SOURCE = '00000000-0000-4000-8000-000000000000'
/** how many of my pending proposals preview compares against (one read, compared in memory) */
const INBOX_WINDOW = 500
/** how many stored captures cachedCapture inspects before giving up */
const CACHE_SCAN = 20

type Built = { item: ExternalItem; original: ExternalItem; link: PhotoExtras['link']; altTitles: string[] }

function buildItem(row: ShelfRow, n: number, capture: PageCapture | null): Built {
  const original = toExternalItem(row, n)
  const altTitles = row.originalTitle === null ? [] : [row.originalTitle]
  // the person's own volume is final: it wins over what the page says
  const chosen = (item: ExternalItem): ExternalItem => (row.volumeSet ? withVolumeOverride(item, original.volume) : item)
  if (capture === null) return { item: original, original, link: null, altTitles }
  const page = extractPage(capture)
  if (!page.ok) throw new DomainError('INVALID', extractErrorMessage[page.error])
  const v = page.value
  return {
    item: chosen(mergeLinkedPage(original, v)),
    original,
    link: { provider: v.provider, providerId: v.providerId, url: v.url, year: v.year, title: v.title },
    altTitles: [...altTitles, v.title],
  }
}

/** Candidates filtered to what this person can see — stored on a proposal with one fixed viewer, so filtered before storing. */
async function visibleCandidates(db: Db, scope: UserScope, sourceId: string, item: ExternalItem, altTitles: string[], limit: number): Promise<MatchCandidate[]> {
  const raw = await findCandidates(db, sourceId, item, limit, { altTitles })
  const visible = await visibleWorkIds(db, scope, raw.map((c) => c.workId))
  return raw.filter((c) => visible.has(c.workId))
}

/** Per row: a repeat of an earlier row, already in my Inbox, or what the catalog says about it (spec: duplicate statuses). */
export async function previewShelf(db: Db, scope: UserScope, input: ShelfPreviewInput): Promise<{ statuses: ShelfStatus[] }> {
  const built = input.rows.map(({ capture, ...row }, i) => ({ row, ...buildItem(row, i + 1, capture) }))
  const mine = (await listMyProposals(db, scope, { limit: INBOX_WINDOW })).items.map((p) => ({
    proposalId: p.id,
    title: p.item.title,
    key: {
      title: p.item.title,
      originalTitle: p.photo?.ai.originalTitle ?? null,
      seriesNumber: p.photo?.ai.seriesNumber ?? (p.item.series[0]?.position != null ? String(p.item.series[0].position) : null),
      volume: p.item.volume?.number ?? null,
    },
  }))
  const lists: MatchCandidate[][] = []
  for (const b of built) lists.push(await findCandidates(db, NIL_SOURCE, b.item, 5, { altTitles: b.altTitles }))
  const hydrated = await hydrateCandidates(db, scope, lists)
  const tops = hydrated.map((list) => list[0] ?? null)
  const topIds = [...new Set(tops.flatMap((t) => (t === null ? [] : [t.workId])))]
  const inHand =
    topIds.length === 0
      ? []
      : await db
          .selectDistinct({ workId: editions.workId })
          .from(editions)
          .where(and(inArray(editions.workId, topIds), eq(editions.format, 'physical'), eq(editions.inPossession, true)))
  const haveIds = new Set(inHand.map((r) => r.workId))

  // the item already resolved the volume (row field, title marker or page) and the cleaned title, as the Inbox proposal carries them
  const keys = built.map((b) => ({ title: b.item.title, originalTitle: b.row.originalTitle, seriesNumber: b.row.seriesNumber, volume: b.item.volume?.number ?? null }))
  const statuses = keys.map((key, i): ShelfStatus => {
    const j = keys.findIndex((other, k) => k < i && sameShelfBook(other, key))
    const inbox = mine.find((p) => sameShelfBook(p.key, key))
    const top = tops[i] ?? null
    return shelfStatus({
      repeatOf: j >= 0 ? j : null,
      inInbox: inbox ? { proposalId: inbox.proposalId, title: inbox.title } : null,
      top: top ? { workId: top.workId, title: top.card.title, score: top.score, basis: top.basis, hasPhysicalInHand: haveIds.has(top.workId), volume: top.volume } : null,
    })
  })
  return { statuses }
}

// a batch's rows in the order they were read: external ids are `photo:<n>`
const photoNumber = sql<number>`split_part(${sourceItems.externalId}, ':', 2)::int`

/**
 * The shelf batch as the person's own private Inbox proposals — the same shape as a CSV import. Runs once
 * per (owner, batchId): a retry answers with the first import, serialised on an advisory lock.
 */
export async function importShelf(db: Db, scope: UserScope, input: ShelfImportInput): Promise<{ sourceId: string; proposalIds: string[]; alreadyImported: boolean }> {
  // refuse a bad page before anything is written
  const built = input.rows.map((r, i) => ({ ...r, ...buildItem(r.row, i + 1, r.capture) }))
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.userId} || ':shelf:' || ${input.batchId}))`)
    const [previous] = await tx
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.kind, 'shelf'), sql`${sources.config}->>'ownerUserId' = ${scope.userId}`, sql`${sources.config}->>'batchId' = ${input.batchId}`))
      .limit(1)
    if (previous) {
      const rows = await tx
        .select({ id: proposals.id })
        .from(proposals)
        .innerJoin(sourceItems, eq(sourceItems.id, proposals.sourceItemId))
        .where(eq(sourceItems.sourceId, previous.id))
        .orderBy(photoNumber)
      return { sourceId: previous.id, proposalIds: rows.map((r) => r.id), alreadyImported: true }
    }
    const config = { kind: 'shelf', ownerUserId: scope.userId, batchId: input.batchId, label: input.label }
    const [source] = await tx.insert(sources).values({ kind: 'shelf', name: input.label, config, schedule: null }).returning({ id: sources.id })
    if (!source) throw new Error('source insert failed')

    const proposalIds: string[] = []
    for (const b of built) {
      const [sourceItem] = await tx
        .insert(sourceItems)
        .values({ sourceId: source.id, externalId: b.item.externalId, raw: { ai: b.row, capture: b.capture }, normalized: b.item, contentHash: sha256(externalItemFingerprint(b.item)) })
        .returning({ id: sourceItems.id })
      if (!sourceItem) throw new Error('source item insert failed')
      const photo: PhotoExtras = {
        ai: { spineText: b.row.spineText, originalTitle: b.row.originalTitle, seriesNumber: b.row.seriesNumber, confidence: b.row.confidence, notes: b.row.notes },
        borrowedFrom: input.ownership === 'borrowed' ? ((input.borrowedFrom?.trim() ?? '') || null) : null,
        original: b.original,
        link: b.link,
        preset: b.preset,
      }
      const payload: CsvRowPayload = { sourceId: source.id, sourceItemId: sourceItem.id, item: b.item, read: null, rating: null, shelf: null, linked: null, ownership: input.ownership, photo, ...(b.row.volumeSet ? { volumeOverride: b.item.volume } : {}) }
      const candidates = await visibleCandidates(tx, scope, source.id, b.item, b.altTitles, STORED_CANDIDATES)
      const [proposal] = await tx
        .insert(proposals)
        .values({ kind: 'new_work', payload, candidates, scope: 'user', userId: scope.userId, createdBy: 'photo', sourceItemId: sourceItem.id })
        .returning({ id: proposals.id })
      if (!proposal) throw new Error('proposal insert failed')
      proposalIds.push(proposal.id)
    }
    return { sourceId: source.id, proposalIds, alreadyImported: false }
  })
}

function rowFromPage(capture: PageCapture | null): ShelfRow {
  if (capture === null) throw new DomainError('INVALID', 'Send a book or a page')
  const page = extractPage(capture)
  if (!page.ok) throw new DomainError('INVALID', extractErrorMessage[page.error])
  const p = page.value
  return {
    title: p.title,
    authors: p.authors,
    translators: p.translators,
    publisher: p.publisher,
    series: p.series?.name ?? null,
    seriesNumber: p.series?.position != null ? String(p.series.position) : null,
    volume: p.volume?.number ?? null,
    volumeCount: p.volume?.count ?? null,
    volumeSet: false,
    language: p.language,
    subtitle: null,
    spineText: null,
    originalTitle: null,
    confidence: null,
    notes: null,
  }
}

/** One book (a photo row, or just a page) straight into the library: import and accept in one transaction, once per batch id. */
export async function addOneShelf(db: Db, scope: UserScope, input: ShelfAddOneInput): Promise<{ workId: string; sourceId: string }> {
  const row = input.row ?? rowFromPage(input.capture)
  return db.transaction(async (tx) => {
    const imported = await importShelf(tx, scope, {
      batchId: input.batchId,
      label: input.label,
      ownership: input.ownership,
      borrowedFrom: input.borrowedFrom,
      rows: [{ row, preset: null, capture: input.capture }],
    })
    const proposalId = imported.proposalIds[0]
    if (proposalId === undefined) throw new Error('shelf import has no proposal')
    const [state] = await tx
      .select({ status: proposals.status, workId: sourceItems.workId })
      .from(proposals)
      .innerJoin(sourceItems, eq(sourceItems.id, proposals.sourceItemId))
      .where(eq(proposals.id, proposalId))
    if (state?.status === 'accepted' && state.workId) return { workId: state.workId, sourceId: imported.sourceId }
    const { workId } = await resolveMyProposal(tx, scope, proposalId, input.target, input.today)
    if (workId === null) throw new DomainError('CONFLICT', 'This book was already handled')
    return { workId, sourceId: imported.sourceId }
  })
}

/**
 * Locks the source item then its proposal (resolveMyProposal's order) and checks it is my own pending import: a shelf
 * book or a CSV row. `original` is the book as the import read it, before any page was linked.
 */
async function lockMyLinkableProposal(tx: Db, scope: UserScope, proposalId: string) {
  const [target] = await tx.select({ sourceItemId: proposals.sourceItemId, scope: proposals.scope, userId: proposals.userId }).from(proposals).where(eq(proposals.id, proposalId))
  if (!target?.sourceItemId || target.scope !== 'user' || target.userId !== scope.userId) throw notFound('Inbox item')
  const [sourceItem] = await tx
    .select({ id: sourceItems.id, raw: sourceItems.raw, kind: sources.kind })
    .from(sourceItems)
    .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
    .where(eq(sourceItems.id, target.sourceItemId))
    .for('update', { of: sourceItems })
  if (!sourceItem || (sourceItem.kind !== 'shelf' && sourceItem.kind !== 'csv')) throw notFound('Inbox item')
  const [proposal] = await tx.select({ kind: proposals.kind, status: proposals.status, payload: proposals.payload }).from(proposals).where(eq(proposals.id, proposalId)).for('update')
  if (!proposal || proposal.kind !== 'new_work') throw notFound('Inbox item')
  const payload = CsvRowPayload.parse(proposal.payload)
  if (sourceItem.kind === 'shelf' && !payload.photo) throw notFound('Inbox item')
  if (proposal.status !== 'pending') throw new DomainError('CONFLICT', 'This book was already handled')
  const raw = sourceItem.raw !== null && typeof sourceItem.raw === 'object' ? (sourceItem.raw as Record<string, unknown>) : {}
  const original = payload.photo?.original ?? payload.linked?.original ?? payload.item
  return { sourceItemId: sourceItem.id, raw, payload, original }
}

async function storeItem(
  tx: Db,
  scope: UserScope,
  proposalId: string,
  held: Awaited<ReturnType<typeof lockMyLinkableProposal>>,
  guess: ExternalItem,
  link: PhotoExtras['link'],
  capture: PageCapture | null,
  /** a new override to store with the item (null: "not a volume") */
  change?: { volumeOverride: ItemVolume | null },
): Promise<void> {
  const volumeOverride = change === undefined ? held.payload.volumeOverride : change.volumeOverride
  // the person's volume, once given, wins over whatever a page or the import read
  const item = withVolumeOverride(guess, volumeOverride)
  const photo = held.payload.photo
  const altTitles = [photo?.ai.originalTitle ?? null, link?.title ?? null].flatMap((t) => (t === null ? [] : [t]))
  const base = volumeOverride === undefined ? held.payload : { ...held.payload, volumeOverride }
  const payload: CsvRowPayload = photo ? { ...base, item, photo: { ...photo, link } } : { ...base, item, linked: link === null ? null : { original: held.original, link } }
  const candidates = await visibleCandidates(tx, scope, held.payload.sourceId, item, altTitles, STORED_CANDIDATES)
  await tx.update(sourceItems).set({ normalized: item, raw: { ...held.raw, capture }, contentHash: sha256(externalItemFingerprint(item)) }).where(eq(sourceItems.id, held.sourceItemId))
  await tx.update(proposals).set({ payload, candidates }).where(eq(proposals.id, proposalId))
}

/** Links a book page to a pending shelf book or CSV row: the page wins what it knows, always merged from the import's own reading. */
export async function attachPage(db: Db, scope: UserScope, proposalId: string, capture: PageCapture): Promise<{ title: string }> {
  const page = extractPage(capture)
  if (!page.ok) throw new DomainError('INVALID', extractErrorMessage[page.error])
  return attachExtracted(db, scope, proposalId, page.value, capture)
}

/** Links an already extracted page (a Hardcover look-up has no captured page to store, so `capture` is null). */
export async function attachExtracted(db: Db, scope: UserScope, proposalId: string, v: ExtractedPage, capture: PageCapture | null): Promise<{ title: string }> {
  return db.transaction(async (tx) => {
    const held = await lockMyLinkableProposal(tx, scope, proposalId)
    const merged = mergeLinkedPage(held.original, v)
    await storeItem(tx, scope, proposalId, held, merged, { provider: v.provider, providerId: v.providerId, url: v.url, year: v.year, title: v.title }, capture)
    return { title: v.title }
  })
}

/** The person's volume for a pending shelf book or CSV row, or null for "not a volume": final, a page linked later does not undo it. */
export async function setMyProposalVolume(db: Db, scope: UserScope, proposalId: string, volume: ItemVolume | null): Promise<void> {
  await db.transaction(async (tx) => {
    const held = await lockMyLinkableProposal(tx, scope, proposalId)
    const link = held.payload.photo?.link ?? held.payload.linked?.link ?? null
    const stored = PageCapture.safeParse(held.raw['capture'])
    await storeItem(tx, scope, proposalId, held, held.payload.item, link, stored.success ? stored.data : null, { volumeOverride: volume })
  })
}

/** #161: a cover photo for a book waiting in my Inbox (null takes it off); on Accept it becomes the new copy's cover. */
export async function setMyProposalCover(db: Db, scope: UserScope, proposalId: string, stored: { path: string; sha256: string; mime: string } | null): Promise<void> {
  await db.transaction(async (tx) => {
    const held = await lockMyLinkableProposal(tx, scope, proposalId)
    const coverAssetId = stored === null ? null : await coverAssetRow(tx, stored)
    await tx
      .update(proposals)
      .set({ payload: { ...held.payload, coverAssetId } })
      .where(eq(proposals.id, proposalId))
  })
}

/** Back to the import's own reading (the AI's reading of the spine, or the CSV row). */
export async function unlinkPage(db: Db, scope: UserScope, proposalId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const held = await lockMyLinkableProposal(tx, scope, proposalId)
    await storeItem(tx, scope, proposalId, held, held.original, null, null)
  })
}

/** A page already captured for this book on any shelf item or CSV row: the paste-link fallback reuses it instead of fetching again. */
export async function cachedCapture(db: Db, provider: string, providerId: string): Promise<PageCapture | null> {
  const found = await db
    .select({ capture: sql<unknown>`${sourceItems.raw}->'capture'` })
    .from(sourceItems)
    .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
    .where(
      and(
        inArray(sources.kind, ['shelf', 'csv']),
        sql`${sourceItems.normalized}->'identifiers'->'others' @> ${JSON.stringify({ [provider]: providerId })}::jsonb`,
        sql`jsonb_typeof(${sourceItems.raw}->'capture') = 'object'`,
      ),
    )
    .limit(CACHE_SCAN)
  const owner = providers.find((p) => p.id === provider)
  if (owner === undefined) return null
  // stored text is checked again: it must really be a page of that book (a tampered or stale row is skipped)
  for (const { capture } of found) {
    const parsed = PageCapture.safeParse(capture)
    if (!parsed.success) continue
    const page = extractPage(parsed.data)
    // and that very page: an Open Library edition is stored under its work's id, but a work link must not get the edition's details (#102)
    if (page.ok && page.value.provider === provider && page.value.providerId === providerId && page.value.url === owner.canonicalUrl(providerId)) return parsed.data
  }
  return null
}

export async function loadSourceKind(db: Db, sourceId: string): Promise<SourceKind | null> {
  const [source] = await db.select({ kind: sources.kind }).from(sources).where(eq(sources.id, sourceId))
  return source?.kind ?? null
}
