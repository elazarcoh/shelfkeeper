import { and, asc, count, eq, inArray, ne, notInArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  DomainError,
  InboxResolution,
  MatchCandidate,
  notFound,
  SourceMatchPayload,
  SourceMatchResolution,
  WantedResolution,
  type EditionFormat,
  type EditionOwnership,
  type ExternalItem,
  type WorkCard,
} from '@mylib/domain'
import type { Db } from '../client'
import { editions, proposals, sourceItems, sources, works } from '../schema'
import { lockWorkEditions } from './catalog'
import { linkHardcoverFromItem } from './hardcover'
import { getWorkCards } from './library'
import { assertVisibleWork, requireAdmin, type UserScope } from './scope'
import { addEditionFromForm, addEditionFromItem, applyItemToEdition, createWantedWork, createWorkFromItem, FOUND_IN_SOURCE, restoreEditionForSource } from './source-catalog'

export type InboxCandidate = MatchCandidate & {
  card: WorkCard
  edition: { id: string; format: EditionFormat; ownership: EditionOwnership; inPossession: boolean } | null
}

export interface InboxItem {
  id: string
  kind: 'source_match' | 'create_wanted'
  createdAt: Date
  sourceId: string
  sourceName: string
  item: ExternalItem
  candidates: InboxCandidate[]
}

export interface InboxPage {
  items: InboxItem[]
  /** every pending item, including those past `limit` */
  total: number
  /** across every pending proposal — what "Create books for all unmatched" would create (F3: stored candidates, unfiltered) */
  unmatched: number
  /** across every pending proposal — what "Accept all exact matches" would accept */
  exactMatches: number
}

const Candidates = z.array(MatchCandidate)
const VISIBLE_CANDIDATES = 5
/** each bulk request handles at most this many proposals; the client asks again while `remaining > 0` (plan deviation 15) */
export const BULK_CHUNK = 100

export async function countInbox(db: Db, scope: UserScope): Promise<number> {
  const mine = and(eq(proposals.scope, 'user'), eq(proposals.userId, scope.userId))
  const visibleToMe = scope.role === 'admin' ? or(eq(proposals.scope, 'catalog'), mine) : mine
  const [row] = await db.select({ n: count() }).from(proposals).where(and(eq(proposals.status, 'pending'), visibleToMe))
  return row?.n ?? 0
}

const pendingCatalog = and(eq(proposals.status, 'pending'), eq(proposals.scope, 'catalog'), inArray(proposals.kind, ['source_match', 'create_wanted']))
const noStoredCandidates = sql`${proposals.candidates} = '[]'::jsonb`

/** The basis of a proposal's first stored candidate whose book this viewer can see (the Inbox shows candidates in stored order). */
export const topVisibleBasis = (scope: UserScope) =>
  sql`(select c.value->>'basis' from jsonb_array_elements(${proposals.candidates}) with ordinality as c(value, n)
        join ${works} on ${works.id} = (c.value->>'workId')::uuid
        where ${scope.visible} order by c.n limit 1)`

async function pendingCounts(db: Db, scope: UserScope): Promise<{ total: number; unmatched: number; exactMatches: number }> {
  const [row] = await db
    .select({
      total: count(),
      unmatched: sql<number>`count(*) filter (where ${noStoredCandidates})`.mapWith(Number),
      exactMatches: sql<number>`count(*) filter (where ${topVisibleBasis(scope)} = 'identifier')`.mapWith(Number),
    })
    .from(proposals)
    .where(pendingCatalog)
  return { total: row?.total ?? 0, unmatched: row?.unmatched ?? 0, exactMatches: row?.exactMatches ?? 0 }
}

type PendingFilter = 'all' | 'unmatched' | 'exact'

/** Keeps only candidates whose book this viewer can see, adds their cards and copies, and trims to what the Inbox shows. */
export async function hydrateCandidates(db: Db, scope: UserScope, lists: readonly MatchCandidate[][]): Promise<InboxCandidate[][]> {
  const workIds = [...new Set(lists.flatMap((l) => l.map((c) => c.workId)))]
  const editionIds = [...new Set(lists.flatMap((l) => l.flatMap((c) => (c.editionId === null ? [] : [c.editionId]))))]
  // getWorkCards and the edition query both apply scope.visible: a hidden book is simply not a candidate
  const cards = new Map((await getWorkCards(db, scope, workIds)).map((c) => [c.id, c]))
  const editionRows =
    editionIds.length === 0
      ? []
      : await db
          .select({ id: editions.id, format: editions.format, ownership: editions.ownership, inPossession: editions.inPossession })
          .from(editions)
          .innerJoin(works, eq(works.id, editions.workId))
          .where(and(inArray(editions.id, editionIds), scope.visible))
  const editionById = new Map(editionRows.map((e) => [e.id, e]))
  return lists.map((list) =>
    list
      .flatMap((c) => {
        const card = cards.get(c.workId)
        return card ? [{ ...c, card, edition: c.editionId === null ? null : (editionById.get(c.editionId) ?? null) }] : []
      })
      .slice(0, VISIBLE_CANDIDATES),
  )
}

async function fetchPendingItems(db: Db, scope: UserScope, limit: number, filter: PendingFilter = 'all', skip: readonly string[] = []): Promise<InboxItem[]> {
  const base =
    filter === 'unmatched' ? and(pendingCatalog, noStoredCandidates) : filter === 'exact' ? and(pendingCatalog, sql`${topVisibleBasis(scope)} = 'identifier'`) : pendingCatalog
  const where = skip.length > 0 ? and(base, notInArray(proposals.id, [...skip])) : base
  const rows = await db
    .select({ id: proposals.id, kind: proposals.kind, payload: proposals.payload, candidates: proposals.candidates, createdAt: proposals.createdAt, sourceName: sources.name })
    .from(proposals)
    .innerJoin(sourceItems, eq(sourceItems.id, proposals.sourceItemId))
    .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
    .where(where)
    // bulk create takes every format sibling after every primary, across chunks too, so a sibling
    // always finds its book already filed (see `groupOf` below)
    .orderBy(...(filter === 'unmatched' ? [sql`${sourceItems.externalId} ~ ':(ebook|audiobook)$'`] : []), asc(proposals.createdAt), asc(proposals.id))
    .limit(limit)
  const parsed = rows.map((r) => ({ ...r, payload: SourceMatchPayload.parse(r.payload), candidates: Candidates.parse(r.candidates) }))

  const candidates = await hydrateCandidates(db, scope, parsed.map((p) => p.candidates))
  return parsed.map((p, i) => ({
    id: p.id,
    kind: p.kind === 'create_wanted' ? 'create_wanted' : 'source_match',
    createdAt: p.createdAt,
    sourceId: p.payload.sourceId,
    sourceName: p.sourceName,
    item: p.payload.item,
    candidates: candidates[i] ?? [],
  }))
}

export async function listInbox(db: Db, scope: UserScope, limit = 100): Promise<InboxPage> {
  requireAdmin(scope)
  const [items, counts] = await Promise.all([fetchPendingItems(db, scope, limit), pendingCounts(db, scope)])
  return { items, ...counts }
}

export async function resolveSourceMatch(
  db: Db,
  scope: UserScope,
  proposalId: string,
  resolution: InboxResolution,
  options: { onlyUndoSync?: boolean } = {},
): Promise<{ workId: string | null; sourceId: string }> {
  requireAdmin(scope)
  return db.transaction(async (tx) => {
    // the form adds a copy of a known book: its editions first, as addEdition does, before the item and proposal
    if (resolution.action === 'link_new_edition' && resolution.edition !== undefined) await lockWorkEditions(tx, resolution.workId)
    // lock order as in the sync engine: the source item first, then its proposal
    const [target] = await tx.select({ sourceItemId: proposals.sourceItemId }).from(proposals).where(eq(proposals.id, proposalId))
    if (!target?.sourceItemId) throw notFound('Inbox item')
    const [sourceItem] = await tx.select({ id: sourceItems.id }).from(sourceItems).where(eq(sourceItems.id, target.sourceItemId)).for('update')
    if (!sourceItem) throw notFound('Source item')
    const [proposal] = await tx
      .select({ id: proposals.id, kind: proposals.kind, scope: proposals.scope, status: proposals.status, payload: proposals.payload })
      .from(proposals)
      .where(eq(proposals.id, proposalId))
      .for('update')
    if (!proposal || (proposal.kind !== 'source_match' && proposal.kind !== 'create_wanted') || proposal.scope !== 'catalog') throw notFound('Inbox item')
    if (proposal.status !== 'pending') throw new DomainError('CONFLICT', 'This item was already handled')
    const fits = proposal.kind === 'create_wanted' ? WantedResolution.safeParse(resolution).success : SourceMatchResolution.safeParse(resolution).success
    if (!fits) throw new DomainError('INVALID', proposal.kind === 'create_wanted' ? 'This is a wanted book, not a copy — add it as wanted or link it to a book' : 'That action is for wanted books')
    const { sourceId, sourceItemId, item } = SourceMatchPayload.parse(proposal.payload)

    let workId: string | null = null
    let editionId: string | null = null
    switch (resolution.action) {
      case 'ignore':
        break
      case 'create_work': {
        const created = await createWorkFromItem(tx, sourceId, item, scope.userId)
        workId = created.workId
        editionId = created.editionId
        break
      }
      case 'link_new_edition':
        await assertVisibleWork(tx, scope, resolution.workId)
        editionId =
          resolution.edition === undefined
            ? await addEditionFromItem(tx, sourceId, resolution.workId, item, scope.userId)
            : await addEditionFromForm(tx, sourceId, resolution.workId, item, resolution.edition, scope.userId, FOUND_IN_SOURCE)
        workId = resolution.workId
        break
      case 'link_edition': {
        const [edition] = await tx
          .select({ id: editions.id, workId: editions.workId, format: editions.format })
          .from(editions)
          .innerJoin(works, eq(works.id, editions.workId))
          .where(and(eq(editions.id, resolution.editionId), scope.visible))
          .for('update', { of: editions })
        if (!edition) throw notFound('Edition')
        if (edition.format !== item.format) throw new DomainError('INVALID', 'That copy is a different format — add this as a new edition instead')
        await restoreEditionForSource(tx, edition.id, new Date(), scope.userId, { onlyUndoSync: options.onlyUndoSync ?? false })
        await applyItemToEdition(tx, sourceId, edition.id, item)
        workId = edition.workId
        editionId = edition.id
        break
      }
      case 'create_wanted':
        workId = await createWantedWork(tx, sourceId, item)
        break
      case 'attach_wanted':
        await assertVisibleWork(tx, scope, resolution.workId)
        workId = resolution.workId
        break
    }

    if (workId !== null) await linkHardcoverFromItem(tx, workId, item)
    await tx
      .update(sourceItems)
      .set(resolution.action === 'ignore' ? { state: 'ignored' } : { state: 'linked', workId, editionId })
      .where(eq(sourceItems.id, sourceItemId))
    await tx
      .update(proposals)
      .set({ status: resolution.action === 'ignore' ? 'rejected' : 'accepted', resolution, resolvedBy: scope.userId, resolvedAt: new Date() })
      .where(eq(proposals.id, proposalId))
    return { workId, sourceId }
  })
}

/**
 * Spec §5 step 5: "accept top candidate for all exact-identifier matches", one chunk per call (plan
 * deviation 15). An item that fails with a DomainError stays pending and is paged past within this
 * call (3b carry-over), so it never stalls the items after it. That is the same paging as the member
 * bulk actions.
 */
export async function acceptExactMatches(db: Db, scope: UserScope, limit = BULK_CHUNK): Promise<{ accepted: number; remaining: number }> {
  requireAdmin(scope)
  let accepted = 0
  const passed: string[] = []
  while (accepted < limit) {
    const page = await fetchPendingItems(db, scope, limit - accepted, 'exact', passed)
    if (page.length === 0) break
    for (const entry of page) {
      const top = entry.candidates[0]
      if (!top || top.basis !== 'identifier') {
        passed.push(entry.id)
        continue
      }
      const resolution: InboxResolution =
        entry.kind === 'create_wanted'
          ? { action: 'attach_wanted', workId: top.workId }
          : top.edition !== null && top.edition.format === entry.item.format
            ? { action: 'link_edition', editionId: top.edition.id }
            : { action: 'link_new_edition', workId: top.workId }
      try {
        // no one looked at this specific copy: never override a person's "No longer have it"
        await resolveSourceMatch(db, scope, entry.id, resolution, { onlyUndoSync: true })
        accepted++
      } catch (error) {
        // someone else handled it meanwhile, or the book changed under us: leave it for a person
        if (!(error instanceof DomainError)) throw error
        passed.push(entry.id)
      }
    }
  }
  return { accepted, remaining: (await pendingCounts(db, scope)).exactMatches }
}

/** `<id>:ebook` (Audiobookshelf) and `book:<n>:ebook` / `book:<n>:audiobook` (Readarr/Chaptarr) belong on `<id>`'s book. */
const FORMAT_SUFFIX = /:(ebook|audiobook)$/
const groupOf = (externalId: string): string => externalId.replace(FORMAT_SUFFIX, '')

/** F4: a linked item of the same group — its primary, or a sibling filed earlier (by hand or in an earlier chunk) — names the book. */
async function linkedGroupWork(db: Db, scope: UserScope, sourceId: string, externalId: string): Promise<string | null> {
  const group = groupOf(externalId)
  const [row] = await db
    .select({ workId: sourceItems.workId })
    .from(sourceItems)
    .innerJoin(works, eq(works.id, sourceItems.workId))
    .where(
      and(
        eq(sourceItems.sourceId, sourceId),
        inArray(sourceItems.externalId, [group, `${group}:ebook`, `${group}:audiobook`]),
        ne(sourceItems.externalId, externalId),
        eq(sourceItems.state, 'linked'),
        scope.visible,
      ),
    )
    .limit(1)
  return row?.workId ?? null
}

/**
 * "Create books for all unmatched": every pending item whose STORED candidate list is empty (F3 —
 * an item with only-hidden candidates is left for one-by-one review instead) becomes a new book (or,
 * for a `create_wanted` item, a wanted book). An audiobook/ebook sibling (an Audiobookshelf pair, or a
 * Readarr/Chaptarr book listed in both formats) is handled after its group's primary and paired onto
 * that same book, whether it was created in this batch or was already linked beforehand (F4). Items
 * someone handled meanwhile (a DomainError) are skipped. One chunk per call; the client repeats while
 * `remaining > 0`.
 */
export async function createForUnmatched(
  db: Db,
  scope: UserScope,
  limit = BULK_CHUNK,
): Promise<{ created: number; linked: number; wanted: number; skipped: number; remaining: number }> {
  requireAdmin(scope)
  const isSibling = (entry: InboxItem) => FORMAT_SUFFIX.test(entry.item.externalId)
  const unmatched = await fetchPendingItems(db, scope, limit, 'unmatched')
  const ordered = [...unmatched.filter((e) => !isSibling(e)), ...unmatched.filter(isSibling)]
  const key = (sourceId: string, externalId: string) => `${sourceId}
${externalId}`
  const createdWork = new Map<string, string>()
  const counts = { created: 0, linked: 0, wanted: 0, skipped: 0 }
  for (const entry of ordered) {
    if (entry.kind === 'create_wanted') {
      try {
        const { workId } = await resolveSourceMatch(db, scope, entry.id, { action: 'create_wanted' })
        counts.wanted++
        if (workId !== null) createdWork.set(key(entry.sourceId, groupOf(entry.item.externalId)), workId)
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        counts.skipped++
      }
      continue
    }
    let primaryWork: string | undefined
    if (isSibling(entry)) {
      primaryWork = createdWork.get(key(entry.sourceId, groupOf(entry.item.externalId))) ?? (await linkedGroupWork(db, scope, entry.sourceId, entry.item.externalId)) ?? undefined
    }
    const resolution: InboxResolution = primaryWork === undefined ? { action: 'create_work' } : { action: 'link_new_edition', workId: primaryWork }
    try {
      const { workId } = await resolveSourceMatch(db, scope, entry.id, resolution)
      if (primaryWork !== undefined) counts.linked++
      else {
        counts.created++
        if (workId !== null) createdWork.set(key(entry.sourceId, groupOf(entry.item.externalId)), workId)
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      counts.skipped++
    }
  }
  return { ...counts, remaining: (await pendingCounts(db, scope)).unmatched }
}
