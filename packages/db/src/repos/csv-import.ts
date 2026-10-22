import { createHash } from 'node:crypto'
import { and, asc, count, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  CsvRowPayload,
  DomainError,
  ExternalItem,
  MatchCandidate,
  editionFormatsForMode,
  externalItemFingerprint,
  mapCsvRow,
  normalizeText,
  notFound,
  pastReadDates,
  type CsvImportInput,
  type CsvOwnership,
  type CsvRead,
  type CsvResolution,
  type CsvShelf,
  type CsvSourceConfig,
  type ItemVolume,
  type PhotoExtras,
  type PhotoLink,
  type ReadingStatus,
} from '@mylib/domain'
import type { Db } from '../client'
import { editions, proposals, readingSessions, sourceItems, sources, userWorks, works } from '../schema'
import { lockWorkEditions } from './catalog'
import { BULK_CHUNK, hydrateCandidates, topVisibleBasis, type InboxCandidate } from './inbox'
import { linkHardcoverFromItem } from './hardcover'
import { findCandidates } from './match'
import { insertPastRead } from './reading-sessions'
import { assertVisibleWork, visibleWorkIds, type UserScope } from './scope'
import { addWorkToSet, getDefaultPersonalSetId } from './sets'
import { addEditionFromForm, addEditionFromItem, createWantedWork, createWorkFromItem, CSV_IMPORT_NOTE, csvHolding, formHolding, importHolding, SHELF_PHOTO_NOTE } from './source-catalog'
import { rebuildDailyStats } from './stats'
import { setRating, setStatus } from './tracking'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const STORED_CANDIDATES = 10

export interface CsvImportResult {
  sourceId: string
  proposals: number
  invalid: { row: number; message: string }[]
  /** this import (same owner, same importId) had already run: nothing new was created */
  alreadyImported: boolean
}

export interface ImportCsvOptions {
  /**
   * Tests only (same pattern as restore's `hooks`, ops/restore.ts): called after each row's inserts,
   * still inside the one import transaction — never committed yet. The crash test uses this to force
   * a deterministic mid-transaction kill instead of racing a real SIGKILL against how far a fast
   * machine gets before it lands.
   */
  hooks?: {
    afterRow?: (rowsWritten: number) => Promise<void>
  }
}

/**
 * Spec §5 CSV: every mapped row becomes a physical ExternalItem and a user-scoped `new_work`
 * proposal for the importer (plan deviations 7–9). Ruling R15 (data integrity): the source insert
 * and every row's sourceItem+proposal inserts run in one transaction, so a failure partway through
 * the file leaves no source and no proposals — never a half-imported CSV the importer can't retry
 * cleanly. A per-row *validation* error (bad mapping, blank title) is not such a failure: it's
 * recorded in `invalid` and simply skipped, same as before.
 *
 * An import runs once: the client names each file pick with an `importId`, and a second request with
 * the same id from the same person (a retry after a timeout, a double submit) answers with the first
 * import's source instead of creating another. The check and the insert are serialised on an advisory
 * lock for (owner, importId), so two concurrent requests still create exactly one source.
 */
export async function importCsv(db: Db, scope: UserScope, input: CsvImportInput, options: ImportCsvOptions = {}): Promise<CsvImportResult> {
  // file line numbers: the client's real ones (blank lines and multi-line cells counted), else header = line 1 and one line per row
  const lineOf = (i: number) => input.lines?.[i] ?? i + 2
  const mapped = input.rows.map((cells, i) => ({ row: lineOf(i), cells, result: mapCsvRow(cells, lineOf(i), input.mapping) }))
  const invalid = mapped.flatMap((m) => (m.result.ok ? [] : [{ row: m.row, message: m.result.error }]))
  const valid = mapped.flatMap((m) => (m.result.ok ? [{ ...m, value: m.result.value }] : []))
  if (valid.length === 0) throw new DomainError('INVALID', 'No row has a title — check the column mapping')

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.userId} || ':csv:' || ${input.importId}))`)
    const [previous] = await tx
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.kind, 'csv'), sql`${sources.config}->>'ownerUserId' = ${scope.userId}`, sql`${sources.config}->>'importId' = ${input.importId}`))
      .limit(1)
    if (previous) {
      const [counted] = await tx.select({ n: count() }).from(proposals).innerJoin(sourceItems, eq(sourceItems.id, proposals.sourceItemId)).where(eq(sourceItems.sourceId, previous.id))
      return { sourceId: previous.id, proposals: counted?.n ?? 0, invalid: [], alreadyImported: true }
    }
    const config: CsvSourceConfig = { kind: 'csv', ownerUserId: scope.userId, fileName: input.fileName, importId: input.importId }
    const [source] = await tx.insert(sources).values({ kind: 'csv', name: `CSV: ${input.fileName}`, config, schedule: null }).returning({ id: sources.id })
    if (!source) throw new Error('source insert failed')

    for (const [index, row] of valid.entries()) {
      const { item, read, rating, shelf } = row.value
      const raw = Object.fromEntries(input.header.map((h, i) => [h, row.cells[i] ?? '']))
      const [sourceItem] = await tx
        .insert(sourceItems)
        .values({ sourceId: source.id, externalId: item.externalId, raw, normalized: item, contentHash: sha256(externalItemFingerprint(item)) })
        .returning({ id: sourceItems.id })
      if (!sourceItem) throw new Error('source item insert failed')
      const payload: CsvRowPayload = { sourceId: source.id, sourceItemId: sourceItem.id, item, read, rating, shelf, linked: null, ownership: input.ownership }
      // findCandidates is catalog-wide; this proposal has a single, fixed viewer (the importer), so
      // (unlike catalog-scope sync proposals, whose viewer varies by which admin opens the Inbox and
      // so are filtered by scope.visible at read time — see inbox.ts) it's filtered once here, before
      // storing: a work hidden from this importer must never surface as their candidate (plan deviation).
      const rawCandidates = await findCandidates(tx, source.id, item, STORED_CANDIDATES)
      const visible = await visibleWorkIds(tx, scope, rawCandidates.map((c) => c.workId))
      await tx.insert(proposals).values({
        kind: 'new_work',
        payload,
        candidates: rawCandidates.filter((c) => visible.has(c.workId)),
        scope: 'user',
        userId: scope.userId,
        createdBy: 'csv',
        sourceItemId: sourceItem.id,
      })
      await options.hooks?.afterRow?.(index + 1)
    }
    return { sourceId: source.id, proposals: valid.length, invalid, alreadyImported: false }
  })
}

export interface MyProposal {
  id: string
  createdAt: Date
  /** the CSV import or shelf batch it came from */
  sourceId: string
  /** the import's source name, e.g. "CSV: goodreads.csv" */
  fileName: string
  item: ExternalItem
  read: CsvRead | null
  rating: number | null
  shelf: CsvShelf | null
  ownership: CsvOwnership
  /** which kind of import filed it: a CSV file or a shelf-photo batch */
  sourceKind: 'csv' | 'shelf'
  /** the shelf row's extras; null on CSV rows */
  photo: PhotoExtras | null
  /** a CSV row's link to a book page (shelf rows keep theirs in `photo.link`) */
  linked: { original: ExternalItem; link: PhotoLink } | null
  /** the person's own volume for it; absent until they correct it, null for "not a volume" */
  volumeOverride?: ItemVolume | null
  /** #161: the cover photo taken for it in the Inbox */
  coverAssetId: string | null
  candidates: InboxCandidate[]
}

/** A shelf batch with books still waiting: how many of them are linked to a book page. */
export interface ShelfBatch {
  sourceId: string
  label: string
  total: number
  linked: number
}

// needs proposals joined to sourceItems and sources: only CSV imports and shelf batches — both use
// `<kind>:<n>` ids — so nothing else filed for this person can ever reach the cast below
const mine = (scope: UserScope) =>
  and(eq(proposals.status, 'pending'), eq(proposals.scope, 'user'), eq(proposals.userId, scope.userId), eq(proposals.kind, 'new_work'), inArray(sources.kind, ['csv', 'shelf']))

// Every proposal this lists is CSV- or shelf-created (mine() pins the source kind), whose
// sourceItems.externalId is always `row:<n>` (mapCsvRow, the file's line number) or `photo:<n>`. Postgres's
// now() (the createdAt default) is fixed for the whole importCsv transaction, so a file's rows
// can share one createdAt; tiebreaking on the row number (before the id) keeps listMyProposals
// in file order regardless, without needing a synthetic per-row timestamp.
const fileRow = sql<number>`split_part(${sourceItems.externalId}, ':', 2)::int`

type MineFilter = 'all' | 'exact' | 'unmatched'

const mineWhere = (scope: UserScope, filter: MineFilter) =>
  filter === 'exact'
    ? and(mine(scope), sql`${topVisibleBasis(scope)} = 'identifier'`)
    : filter === 'unmatched'
      ? and(mine(scope), sql`${topVisibleBasis(scope)} is null`)
      : mine(scope)

async function fetchMine(db: Db, scope: UserScope, limit: number, filter: MineFilter = 'all', skip: readonly string[] = [], sourceId: string | null = null): Promise<MyProposal[]> {
  const rows = await db
    .select({ id: proposals.id, createdAt: proposals.createdAt, payload: proposals.payload, candidates: proposals.candidates, sourceName: sources.name, sourceKind: sources.kind })
    .from(proposals)
    .innerJoin(sourceItems, eq(sourceItems.id, proposals.sourceItemId))
    .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
    .where(and(mineWhere(scope, filter), skip.length > 0 ? notInArray(proposals.id, [...skip]) : undefined, sourceId !== null ? eq(sources.id, sourceId) : undefined))
    .orderBy(asc(proposals.createdAt), asc(fileRow), asc(proposals.id))
    .limit(limit)
  const parsed = rows.map((r) => ({ ...r, payload: CsvRowPayload.parse(r.payload), candidates: z.array(MatchCandidate).parse(r.candidates) }))
  const candidates = await hydrateCandidates(db, scope, parsed.map((p) => p.candidates))
  return parsed.map((p, i) => ({
    id: p.id,
    createdAt: p.createdAt,
    sourceId: p.payload.sourceId,
    fileName: p.sourceName,
    item: p.payload.item,
    read: p.payload.read,
    rating: p.payload.rating,
    shelf: p.payload.shelf,
    ownership: p.payload.ownership,
    sourceKind: p.sourceKind === 'shelf' ? 'shelf' : 'csv',
    photo: p.payload.photo ?? null,
    linked: p.payload.linked,
    ...(p.payload.volumeOverride !== undefined ? { volumeOverride: p.payload.volumeOverride } : {}),
    coverAssetId: p.payload.coverAssetId ?? null,
    candidates: candidates[i] ?? [],
  }))
}

/** Across every pending proposal of mine: what the two bulk actions would handle (same visibility rule as the list). */
async function mineCounts(db: Db, scope: UserScope): Promise<{ total: number; exactMatches: number; unmatched: number }> {
  const [row] = await db
    .select({
      total: count(),
      exactMatches: sql<number>`count(*) filter (where ${topVisibleBasis(scope)} = 'identifier')`.mapWith(Number),
      unmatched: sql<number>`count(*) filter (where ${topVisibleBasis(scope)} is null)`.mapWith(Number),
    })
    .from(proposals)
    .innerJoin(sourceItems, eq(sourceItems.id, proposals.sourceItemId))
    .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
    .where(mine(scope))
  return { total: row?.total ?? 0, exactMatches: row?.exactMatches ?? 0, unmatched: row?.unmatched ?? 0 }
}

/** The importer's own pending CSV proposals (plan deviation 9) — nobody else's, candidates filtered to what they can see. */
/** My pending shelf batches, oldest first, each with how many of its books are linked to a page. */
async function shelfBatches(db: Db, scope: UserScope): Promise<ShelfBatch[]> {
  return db
    .select({
      sourceId: sources.id,
      label: sources.name,
      total: count(),
      linked: sql<number>`count(*) filter (where jsonb_typeof(${proposals.payload} #> '{photo,link}') = 'object')`.mapWith(Number),
    })
    .from(proposals)
    .innerJoin(sourceItems, eq(sourceItems.id, proposals.sourceItemId))
    .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
    .where(and(mine(scope), eq(sources.kind, 'shelf')))
    .groupBy(sources.id, sources.name, sources.createdAt)
    .orderBy(asc(sources.createdAt), asc(sources.id))
}

/**
 * My pending imports (`sourceId`: only that CSV file's or shelf batch's). The bulk actions' counts are always across
 * everything, as those actions are.
 */
export async function listMyProposals(
  db: Db,
  scope: UserScope,
  { limit = 100, sourceId = null }: { limit?: number; sourceId?: string | null } = {},
): Promise<{ items: MyProposal[]; total: number; exactMatches: number; unmatched: number; shelfBatches: ShelfBatch[] }> {
  const [items, counts, batches] = await Promise.all([fetchMine(db, scope, limit, 'all', [], sourceId), mineCounts(db, scope), shelfBatches(db, scope)])
  return { items, ...counts, shelfBatches: batches }
}

const shelfStatus: Record<CsvShelf, ReadingStatus> = { read: 'read', reading: 'reading', want: 'want_to_read' }

/**
 * Records the importer's read (a finished session inside the file's date precision — plan deviation 10)
 * and rating. Same lock key as startSession/deleteReadingSession, so one person's sessions on one
 * book never interleave; an identical finished read already there is not recorded again.
 *
 * Ruling R16: a person's own tracking is never silently overwritten, and timestamps stay truthful.
 * A rating already on the work is left alone (a CSV row never overwrites a rating the person gave
 * themselves). A session's isReread reflects the file's own chronology — true only when the person
 * has an earlier-dated *finished* session — not merely "any prior session, in whatever order rows
 * happen to import in"; an older historical row imported after a newer one is correctly not a reread,
 * and neither this call nor any other rewrites an already-recorded session's isReread.
 * A row with no read date but a shelf (Goodreads' "Exclusive Shelf") only sets the matching status,
 * and only when the person has no status on the book yet — never a session.
 */
async function recordCsvTracking(db: Db, scope: UserScope, workId: string, editionId: string | null, payload: CsvRowPayload, deferStats: boolean): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.userId} || ':' || ${workId}))`)
  if (payload.read !== null) {
    const read = payload.read
    const prior = await db
      .select({ outcome: readingSessions.outcome, finishedOn: readingSessions.finishedOn, finishedPrecision: readingSessions.finishedPrecision })
      .from(readingSessions)
      .where(and(eq(readingSessions.userId, scope.userId), eq(readingSessions.workId, workId)))
    const already = prior.some((p) => p.outcome === 'finished' && p.finishedOn === read.finishedOn && p.finishedPrecision === read.finishedPrecision)
    if (!already) {
      let sessionEdition = editionId
      if (sessionEdition === null) {
        // like startSession: the only edition of a reading format, if there is exactly one
        const readable = await db
          .select({ id: editions.id })
          .from(editions)
          .where(and(eq(editions.workId, workId), inArray(editions.format, editionFormatsForMode('read'))))
        if (readable.length === 1) sessionEdition = readable[0]?.id ?? null
      }
      // the same path as "Mark as read": start = finish, then the status a finish implies
      await insertPastRead(db, scope, {
        workId,
        editionId: sessionEdition,
        mode: 'read',
        // start = finish, at the finish's precision (parseCsvDate already gives a month or a year its first day)
        dates: pastReadDates(read.finishedOn, read.finishedPrecision),
        // chronological, not "any prior finished session": a historical row imported after a later
        // one it actually predates must not be marked a reread of it
        isReread: prior.some((p) => p.outcome === 'finished' && p.finishedOn !== null && p.finishedOn < read.finishedOn),
      })
      // a bulk action rebuilds once for the whole chunk instead
      if (!deferStats) await rebuildDailyStats(db, scope, { workIds: [workId] })
    }
  } else if (payload.shelf !== null) {
    const [existing] = await db.select({ status: userWorks.status }).from(userWorks).where(and(eq(userWorks.userId, scope.userId), eq(userWorks.workId, workId)))
    // never overwrite a status the person already chose (R16)
    if (existing === undefined || existing.status === 'none') await setStatus(db, scope, workId, shelfStatus[payload.shelf])
  }
  if (payload.rating !== null) {
    const [existing] = await db.select({ rating: userWorks.rating }).from(userWorks).where(and(eq(userWorks.userId, scope.userId), eq(userWorks.workId, workId)))
    // never overwrite a rating the person already gave themselves (R16)
    if (existing?.rating == null) await setRating(db, scope, workId, payload.rating)
  }
}

/**
 * The importer resolves their own CSV proposal; `today` is their local date for the holding history.
 * `deferStats`: the caller rebuilds the daily stats itself (once per bulk chunk, not once per row).
 */
export async function resolveMyProposal(
  db: Db,
  scope: UserScope,
  proposalId: string,
  resolution: CsvResolution,
  today: string,
  options: { deferStats?: boolean } = {},
): Promise<{ workId: string | null; sourceId: string }> {
  return db.transaction(async (tx) => {
    const [target] = await tx.select({ sourceItemId: proposals.sourceItemId, scope: proposals.scope, userId: proposals.userId }).from(proposals).where(eq(proposals.id, proposalId))
    // someone else's proposal is indistinguishable from a missing one
    if (!target?.sourceItemId || target.scope !== 'user' || target.userId !== scope.userId) throw notFound('Inbox item')
    // a new edition of a known book locks that book's editions first, as mergeWorks does (a create_work sibling join
    // can only learn its book after the payload is read, so it locks editions after the item and proposal)
    if (resolution.action === 'link_new_edition') await lockWorkEditions(tx, resolution.workId)
    // lock order as everywhere else: the source item first, then its proposal
    const [sourceItem] = await tx.select({ id: sourceItems.id }).from(sourceItems).where(eq(sourceItems.id, target.sourceItemId)).for('update')
    if (!sourceItem) throw notFound('Inbox item')
    const [proposal] = await tx.select({ kind: proposals.kind, status: proposals.status, payload: proposals.payload }).from(proposals).where(eq(proposals.id, proposalId)).for('update')
    if (!proposal || proposal.kind !== 'new_work') throw notFound('Inbox item')
    if (proposal.status !== 'pending') throw new DomainError('CONFLICT', 'This item was already handled')
    const payload = CsvRowPayload.parse(proposal.payload)
    const holding = payload.photo
      ? importHolding(payload.ownership, today, { note: SHELF_PHOTO_NOTE, borrowedFrom: payload.photo.borrowedFrom })
      : csvHolding(payload.ownership, today)
    // a to-read row is a book the person wants, not a copy they own or borrowed
    const wanted = payload.shelf === 'want'

    let workId: string | null = null
    let editionId: string | null = null
    switch (resolution.action) {
      case 'ignore':
        break
      case 'create_work': {
        // a volume whose sibling volume this same import already filed joins that book (#66)
        const sibling = payload.item.volume === null ? null : await siblingVolumeWork(tx, scope, payload)
        if (sibling !== null) {
          workId = sibling
          if (!wanted) editionId = await addEditionFromItem(tx, payload.sourceId, sibling, payload.item, scope.userId, holding)
          break
        }
        if (wanted) {
          workId = await createWantedWork(tx, payload.sourceId, payload.item)
          break
        }
        const created = await createWorkFromItem(tx, payload.sourceId, payload.item, scope.userId, holding)
        workId = created.workId
        editionId = created.editionId
        break
      }
      case 'link_new_edition':
        await assertVisibleWork(tx, scope, resolution.workId)
        // a to-read row never becomes a copy, so it has no edition to describe (#121)
        if (wanted && resolution.edition !== undefined) throw new DomainError('INVALID', 'A book you want to read has no copy to describe')
        // wanted: like track_only — no copy
        if (!wanted) {
          // a read-not-owned row keeps the import's holding: the form can't say "no longer in hand"
          const formCopy = resolution.edition !== undefined && payload.ownership !== 'read_not_owned'
          editionId =
            resolution.edition === undefined
              ? await addEditionFromItem(tx, payload.sourceId, resolution.workId, payload.item, scope.userId, holding)
              : await addEditionFromForm(tx, payload.sourceId, resolution.workId, payload.item, resolution.edition, scope.userId, formCopy ? formHolding(resolution.edition, today, payload.photo ? SHELF_PHOTO_NOTE : CSV_IMPORT_NOTE) : holding)
        }
        workId = resolution.workId
        break
      case 'link_edition': {
        const [edition] = await tx
          .select({ id: editions.id, workId: editions.workId, format: editions.format })
          .from(editions)
          .innerJoin(works, eq(works.id, editions.workId))
          .where(and(eq(editions.id, resolution.editionId), scope.visible))
        if (!edition) throw notFound('Edition')
        if (edition.format !== payload.item.format) throw new DomainError('INVALID', 'That copy is a different format — add this as a new edition instead')
        workId = edition.workId
        editionId = edition.id
        break
      }
      case 'track_only':
        await assertVisibleWork(tx, scope, resolution.workId)
        workId = resolution.workId
        break
    }

    // #161: the photo taken in the Inbox is the copy's cover, unless the copy has one; the page's cover is then skipped,
    // as the cover download only fills copies without one
    const coverAssetId = payload.coverAssetId ?? null
    if (editionId !== null && coverAssetId !== null) {
      await tx
        .update(editions)
        .set({ coverAssetId })
        .where(and(eq(editions.id, editionId), isNull(editions.coverAssetId)))
    }
    if (workId !== null) await linkHardcoverFromItem(tx, workId, payload.item)
    if (workId !== null) await recordCsvTracking(tx, scope, workId, editionId, payload, options.deferStats ?? false)
    // a copy I own or have borrowed is in my hands, so it joins My books (as "Add book" does) and shows in My library
    if (workId !== null && editionId !== null && payload.ownership !== 'read_not_owned') await addWorkToSet(tx, scope, await getDefaultPersonalSetId(tx, scope.userId), workId)
    await tx
      .update(sourceItems)
      .set(resolution.action === 'ignore' ? { state: 'ignored' } : { state: 'linked', workId, editionId })
      .where(eq(sourceItems.id, sourceItem.id))
    await tx
      .update(proposals)
      .set({ status: resolution.action === 'ignore' ? 'rejected' : 'accepted', resolution, resolvedBy: scope.userId, resolvedAt: new Date() })
      .where(eq(proposals.id, proposalId))
    return { workId, sourceId: payload.sourceId }
  })
}

/**
 * Runs `resolutionOf` over my pending proposals of one kind, in file order, through resolveMyProposal
 * (so its locks and tracking rules apply). A row that fails with a DomainError stays pending and is
 * paged past — excluded from the next page of this same call — so it can never stall the rows after
 * it. Stops once `limit` rows are done. The daily stats are rebuilt once, after the chunk.
 */
async function bulkMine(
  db: Db,
  scope: UserScope,
  today: string,
  limit: number,
  filter: MineFilter,
  resolutionOf: (entry: MyProposal) => CsvResolution | null,
): Promise<{ done: number; skipped: number; sourceIds: string[] }> {
  let done = 0
  let skipped = 0
  const passed: string[] = []
  const touched = new Set<string>()
  const sourceIds = new Set<string>()
  try {
    while (done < limit) {
      const page = await fetchMine(db, scope, limit - done, filter, passed)
      if (page.length === 0) break
      for (const entry of page) {
        const resolution = resolutionOf(entry)
        if (resolution === null) {
          passed.push(entry.id)
          continue
        }
        try {
          const { workId, sourceId } = await resolveMyProposal(db, scope, entry.id, resolution, today, { deferStats: true })
          if (workId !== null) {
            touched.add(workId)
            sourceIds.add(sourceId)
          }
          done++
        } catch (error) {
          // handled meanwhile, or the book changed under us: leave it for the person
          if (!(error instanceof DomainError)) throw error
          skipped++
          passed.push(entry.id)
        }
      }
    }
  } finally {
    if (touched.size > 0) await rebuildDailyStats(db, scope, { workIds: [...touched] })
  }
  return { done, skipped, sourceIds: [...sourceIds] }
}

/**
 * The book an earlier row of this import became, when that row was another volume of the same book: the same
 * cleaned title and first author, format and language. Serialised per import so two volumes can't both create it.
 */
async function siblingVolumeWork(tx: Db, scope: UserScope, payload: CsvRowPayload): Promise<string | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${payload.sourceId} || ':volumes'))`)
  const item = payload.item
  const rows = await tx
    .select({ workId: sourceItems.workId, normalized: sourceItems.normalized })
    .from(sourceItems)
    .where(and(eq(sourceItems.sourceId, payload.sourceId), eq(sourceItems.state, 'linked'), sql`jsonb_typeof(${sourceItems.normalized}->'volume') = 'object'`))
    .orderBy(asc(sourceItems.externalId))
  const key = (i: ExternalItem) => [normalizeText(i.title), normalizeText(i.authors[0] ?? ''), i.format, (i.language ?? '').trim().toLowerCase()].join(' ')
  for (const row of rows) {
    const other = ExternalItem.safeParse(row.normalized)
    if (row.workId === null || !other.success || key(other.data) !== key(item) || other.data.volume?.number === item.volume?.number) continue
    const visible = await visibleWorkIds(tx, scope, [row.workId])
    if (visible.has(row.workId)) return row.workId
  }
  return null
}

/** "Accept all exact matches" for my imports: the top visible candidate matched by identifier — its copy when the format matches, else just my read. */
export async function acceptMineExact(db: Db, scope: UserScope, today: string, limit = BULK_CHUNK): Promise<{ accepted: number; remaining: number; sourceIds: string[] }> {
  const { done, sourceIds } = await bulkMine(db, scope, today, limit, 'exact', (entry) => {
    const top = entry.candidates[0]
    if (!top || top.basis !== 'identifier') return null
    // a shelf row ticked on purpose against a book already held: a second copy, never the existing one
    if (entry.photo?.preset) return { action: 'link_new_edition', workId: entry.photo.preset.workId }
    // another volume of the matched book: a new edition, never volume 1's copy (#66)
    if (top.volume !== null && entry.shelf !== 'want') return { action: 'link_new_edition', workId: top.workId }
    // a to-read row never becomes (or claims) a copy
    if (entry.shelf !== 'want' && top.edition !== null && top.edition.format === entry.item.format) return { action: 'link_edition', editionId: top.edition.id }
    // a shelf row is a copy in hand, never just a read: another format's book gets this copy as a new edition
    if (entry.photo) return { action: 'link_new_edition', workId: top.workId }
    return { action: 'track_only', workId: top.workId }
  })
  return { accepted: done, remaining: (await mineCounts(db, scope)).exactMatches, sourceIds }
}

/** "Create books for all unmatched" for my imports: rows with no candidate I can see become new books (a to-read row, a wanted one). */
export async function createMineUnmatched(db: Db, scope: UserScope, today: string, limit = BULK_CHUNK): Promise<{ created: number; skipped: number; remaining: number; sourceIds: string[] }> {
  const { done, skipped, sourceIds } = await bulkMine(db, scope, today, limit, 'unmatched', (entry) => {
    if (entry.candidates.length > 0) return null
    // a row the person said is this book (a second copy, or a picked match) joins it instead of starting a duplicate
    if (entry.photo?.preset) return { action: 'link_new_edition', workId: entry.photo.preset.workId }
    return { action: 'create_work' }
  })
  return { created: done, skipped, remaining: (await mineCounts(db, scope)).unmatched, sourceIds }
}
