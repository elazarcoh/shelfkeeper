import { createHash } from 'node:crypto'
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm'
import {
  emptySyncStats,
  ExternalItem,
  externalItemFingerprint,
  MAX_RECORDED_ITEM_ERRORS,
  type InboxResolution,
  type ItemError,
  type Result,
  type SourceMatchPayload,
  type SyncStats,
} from '@mylib/domain'
import type { Db } from '../client'
import { editions, proposals, sourceItems } from '../schema'
import { findCandidates } from './match'
import { applyItemToEdition, removeEditionForSource, restoreEditionForSource } from './source-catalog'

export interface SyncOutcome {
  complete: boolean
  stats: SyncStats
  error: string | null
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function withoutRaw(item: ExternalItem): ExternalItem {
  const copy: ExternalItem = { ...item }
  delete copy.raw
  return copy
}

/**
 * The fingerprint with the description's whitespace collapsed and without the library path: an upgrade
 * that tidies descriptions, or that starts reporting where the files are (#104), is no content change.
 */
function looseFingerprint(item: ExternalItem): string {
  const others = Object.fromEntries(Object.entries(item.identifiers.others).filter(([key]) => key !== 'libraryPath'))
  return externalItemFingerprint({
    ...item,
    description: item.description === null ? null : item.description.replace(/\s+/g, ' ').trim(),
    identifiers: { ...item.identifiers, others },
  })
}

/** Whether the stored item differs from the new one in more than that (read before it is overwritten). */
async function changedInContent(db: Db, sourceItemId: string, next: ExternalItem): Promise<boolean> {
  const [row] = await db.select({ normalized: sourceItems.normalized }).from(sourceItems).where(eq(sourceItems.id, sourceItemId))
  const stored = ExternalItem.safeParse(row?.normalized)
  return !stored.success || looseFingerprint(stored.data) !== looseFingerprint(next)
}

function recordError(stats: SyncStats, error: ItemError): void {
  stats.invalid++
  if (stats.errors.length < MAX_RECORDED_ITEM_ERRORS) stats.errors.push(error)
}

/** A connector can hand back anything for an unparsable record — including `null` or a primitive. */
function externalIdOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const id = (value as Record<string, unknown>).externalId
  return typeof id === 'string' ? id : null
}

/**
 * An item the source listed but we couldn't read this time is still *there*: count it as seen
 * so the removal pass doesn't mark its copy gone. Items derived from one source record share
 * the prefix "<id>:" (e.g. an Audiobookshelf book's ebook is "<id>:ebook").
 */
async function touchSeen(db: Db, sourceId: string, externalId: string): Promise<void> {
  await db
    .update(sourceItems)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(sourceItems.sourceId, sourceId),
        or(eq(sourceItems.externalId, externalId), sql`starts_with(${sourceItems.externalId}, ${`${externalId}:`})`),
      ),
    )
}

async function supersedePending(db: Db, sourceItemId: string): Promise<void> {
  await db
    .update(proposals)
    .set({ status: 'superseded' })
    .where(and(eq(proposals.sourceItemId, sourceItemId), eq(proposals.status, 'pending')))
}

async function hasPendingProposal(db: Db, sourceItemId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.sourceItemId, sourceItemId), eq(proposals.status, 'pending')))
    .limit(1)
  return row !== undefined
}

/** Store more candidates than the Inbox shows (Task 10 filters by the viewer's visibility, then shows the top 5). */
const STORED_CANDIDATES = 10

async function proposeMatch(db: Db, sourceId: string, sourceItemId: string, item: ExternalItem): Promise<void> {
  const payload: SourceMatchPayload = { sourceId, sourceItemId, item }
  await db.insert(proposals).values({
    // a monitored-but-missing Readarr/Chaptarr book asks for a wanted placeholder, not a copy (spec §5)
    kind: item.wantedOnly ? 'create_wanted' : 'source_match',
    payload,
    candidates: await findCandidates(db, sourceId, item, STORED_CANDIDATES),
    scope: 'catalog',
    createdBy: 'sync',
    sourceItemId,
  })
}

/**
 * #104: another source's live, linked item has the same files (same `libraryPath`) in the same format —
 * Audiobookshelf and Chaptarr reading one folder. Link this item to that copy exactly as accepting
 * "Link to this copy" in the Inbox would, and keep an accepted proposal as the record. Only when there
 * is exactly one such copy; a wanted item or a volume of a set is always left for a person.
 */
async function linkSameFiles(tx: Db, sourceId: string, sourceItemId: string, item: ExternalItem): Promise<boolean> {
  const path = item.identifiers.others.libraryPath
  if (path === undefined || item.wantedOnly || item.volume !== null) return false
  const copies = await tx
    .selectDistinct({ editionId: editions.id, workId: editions.workId })
    .from(sourceItems)
    .innerJoin(editions, eq(editions.id, sourceItems.editionId))
    .where(
      and(
        eq(sourceItems.state, 'linked'),
        isNull(sourceItems.removedAt),
        ne(sourceItems.id, sourceItemId),
        eq(editions.format, item.format),
        sql`(${sourceItems.normalized}->'identifiers'->'others') @> ${JSON.stringify({ libraryPath: path })}::jsonb`,
      ),
    )
    .limit(2)
  const [copy, another] = copies
  if (copy === undefined || another !== undefined) return false

  const now = new Date()
  await restoreEditionForSource(tx, copy.editionId, now, null, { onlyUndoSync: true })
  await applyItemToEdition(tx, sourceId, copy.editionId, item)
  await tx.update(sourceItems).set({ state: 'linked', workId: copy.workId, editionId: copy.editionId }).where(eq(sourceItems.id, sourceItemId))
  await supersedePending(tx, sourceItemId)
  const payload: SourceMatchPayload = { sourceId, sourceItemId, item }
  const resolution: InboxResolution = { action: 'link_edition', editionId: copy.editionId }
  await tx.insert(proposals).values({
    kind: 'source_match',
    payload,
    candidates: [],
    scope: 'catalog',
    createdBy: 'sync',
    sourceItemId,
    status: 'accepted',
    resolution,
    resolvedAt: now,
  })
  return true
}

/** Stores an item read back after a push to Audiobookshelf (#115), applying it like a sync would; the stats are thrown away. */
export async function storeSourceItem(db: Db, sourceId: string, item: ExternalItem): Promise<void> {
  await upsertItem(db, sourceId, item, emptySyncStats())
}

async function upsertItem(db: Db, sourceId: string, item: ExternalItem, stats: SyncStats): Promise<void> {
  const normalized = withoutRaw(item)
  const contentHash = sha256(externalItemFingerprint(item))
  const raw = item.raw ?? null
  await db.transaction(async (tx) => {
    const now = new Date()
    const [existing] = await tx
      .select({
        id: sourceItems.id,
        contentHash: sourceItems.contentHash,
        removedAt: sourceItems.removedAt,
        editionId: sourceItems.editionId,
        state: sourceItems.state,
        workId: sourceItems.workId,
        coverUrl: sql<string | null>`${sourceItems.normalized}->>'coverUrl'`,
      })
      .from(sourceItems)
      .where(and(eq(sourceItems.sourceId, sourceId), eq(sourceItems.externalId, item.externalId)))
      .for('update')

    if (!existing) {
      const [row] = await tx
        .insert(sourceItems)
        .values({ sourceId, externalId: item.externalId, raw, normalized, contentHash, firstSeenAt: now, lastSeenAt: now })
        .returning({ id: sourceItems.id })
      if (!row) throw new Error('source item insert failed')
      stats.created++
      if (await linkSameFiles(tx, sourceId, row.id, normalized)) {
        stats.linked = (stats.linked ?? 0) + 1
        return
      }
      await proposeMatch(tx, sourceId, row.id, normalized)
      stats.proposals++
      return
    }

    const changed = existing.contentHash !== contentHash
    // a rejection is sticky (a person decided) unless the source's own content actually changed —
    // then it's arguably a different item and deserves another look; tidied description whitespace
    // (e.g. after an upgrade of how a connector reads descriptions) is not such a change
    const reopen = existing.state === 'ignored' && changed && (await changedInContent(tx, existing.id, normalized))
    // a linked copy takes the item's changes, but not a mere re-reading of it (tidied whitespace, a new library path)
    const reapply = existing.state === 'linked' && existing.editionId !== null && changed && (await changedInContent(tx, existing.id, normalized))
    // a plain re-sighting (same content, same cover, not coming back from a removal) only moves lastSeenAt:
    // rewriting two jsonb columns for every item on every sync is pure write amplification (3a deferral)
    const quiet = !changed && existing.removedAt === null && existing.coverUrl === (item.coverUrl ?? null)
    await tx
      .update(sourceItems)
      .set(quiet ? { lastSeenAt: now } : { lastSeenAt: now, removedAt: null, raw, normalized, contentHash })
      .where(eq(sourceItems.id, existing.id))
    if (changed) stats.changed++
    else stats.unchanged++

    // spec §5 step 4: the same externalId seen again after a removal restores the copy
    if (existing.removedAt !== null && existing.state === 'linked' && existing.editionId !== null) {
      if (await restoreEditionForSource(tx, existing.editionId, now, null, { onlyUndoSync: true })) stats.restored++
    }

    // the linked edition (and/or its work) was deleted out from under this item (FK ON DELETE SET
    // NULL): the item still says 'linked' but there is nothing to apply changes to any more —
    // treat it like an unlinked item and file a fresh match proposal instead of silently skipping it
    // a wanted placeholder is linked to its book with no copy (spec §4 source_item.workId) — not an orphan,
    // unless its book was deleted too; any other linked item without an edition lost its copy
    const placeholder = existing.state === 'linked' && existing.editionId === null && existing.workId !== null && normalized.wantedOnly
    const orphanedLink = existing.state === 'linked' && existing.editionId === null && !placeholder

    if (existing.state === 'linked' && existing.editionId !== null) {
      if (reapply) await applyItemToEdition(tx, sourceId, existing.editionId, normalized)
    } else if (orphanedLink) {
      await tx.update(sourceItems).set({ state: 'pending', workId: null }).where(eq(sourceItems.id, existing.id))
      await supersedePending(tx, existing.id)
      if (await linkSameFiles(tx, sourceId, existing.id, normalized)) {
        stats.linked = (stats.linked ?? 0) + 1
      } else {
        await proposeMatch(tx, sourceId, existing.id, normalized)
        stats.proposals++
      }
    } else if (existing.state === 'pending' && (await linkSameFiles(tx, sourceId, existing.id, normalized))) {
      // checked on every sync, not only when the item changed: the other source may have linked the
      // same files since this item was filed (one indexed lookup, and only for items with a path)
      stats.linked = (stats.linked ?? 0) + 1
    } else if (existing.state === 'pending') {
      if (changed) await supersedePending(tx, existing.id)
      if (changed || !(await hasPendingProposal(tx, existing.id))) {
        await proposeMatch(tx, sourceId, existing.id, normalized)
        stats.proposals++
      }
    } else if (reopen) {
      await tx.update(sourceItems).set({ state: 'pending' }).where(eq(sourceItems.id, existing.id))
      await proposeMatch(tx, sourceId, existing.id, normalized)
      stats.proposals++
    }
    // an unchanged ignored item stays ignored
  })
}

/**
 * Spec §5 step 4 — only ever called after a complete, successful fetch. The candidate list is a
 * snapshot; re-check each item fresh (locked) inside its own transaction, since something else
 * (a person accepting a proposal, another sync) could have touched it since the snapshot was read.
 */
async function markMissing(db: Db, sourceId: string, fetchStartedAt: Date, stats: SyncStats): Promise<void> {
  const missing = await db
    .select({ id: sourceItems.id })
    .from(sourceItems)
    .where(and(eq(sourceItems.sourceId, sourceId), isNull(sourceItems.removedAt), lt(sourceItems.lastSeenAt, fetchStartedAt)))
  for (const m of missing) {
    const removed = await db.transaction(async (tx) => {
      const [fresh] = await tx
        .select({
          id: sourceItems.id,
          editionId: sourceItems.editionId,
          state: sourceItems.state,
          removedAt: sourceItems.removedAt,
          lastSeenAt: sourceItems.lastSeenAt,
        })
        .from(sourceItems)
        .where(eq(sourceItems.id, m.id))
        .for('update')
      if (!fresh || fresh.removedAt !== null || fresh.lastSeenAt >= fetchStartedAt) return false

      const now = new Date()
      await tx.update(sourceItems).set({ removedAt: now }).where(eq(sourceItems.id, fresh.id))
      await supersedePending(tx, fresh.id)
      if (fresh.state === 'linked' && fresh.editionId !== null) {
        // another live item can back the same copy (the user linked two files to one edition)
        const [stillBacked] = await tx
          .select({ id: sourceItems.id })
          .from(sourceItems)
          .where(and(eq(sourceItems.editionId, fresh.editionId), isNull(sourceItems.removedAt), ne(sourceItems.id, fresh.id)))
          .limit(1)
        if (!stillBacked) await removeEditionForSource(tx, fresh.editionId, now)
      }
      return true
    })
    if (removed) stats.removed++
  }
}

export async function syncSource(
  db: Db,
  sourceId: string,
  items: AsyncIterable<Result<ExternalItem, ItemError>>,
): Promise<SyncOutcome> {
  const stats = emptySyncStats()
  const fetchStartedAt = new Date()
  let hasUnidentifiableError = false
  try {
    for await (const result of items) {
      if (!result.ok) {
        recordError(stats, result.error)
        if (result.error.externalId !== null) await touchSeen(db, sourceId, result.error.externalId)
        else hasUnidentifiableError = true
        continue
      }
      const parsed = ExternalItem.safeParse(result.value)
      if (!parsed.success) {
        const externalId = externalIdOf(result.value)
        recordError(stats, { externalId, message: parsed.error.issues[0]?.message ?? 'Invalid item' })
        if (externalId !== null) await touchSeen(db, sourceId, externalId)
        else hasUnidentifiableError = true
        continue
      }
      stats.seen++
      await upsertItem(db, sourceId, parsed.data, stats)
    }

    if (hasUnidentifiableError) {
      // an item we couldn't even identify might be any of this source's existing items — we can't
      // safely rule any of them out as gone, so skip the removal pass entirely this run
      return { complete: true, stats, error: 'Some items could not be identified, so nothing was marked as gone' }
    }
    if (stats.seen === 0 && (await hasLiveItems(db, sourceId))) {
      // a source that suddenly lists nothing is far more likely misconfigured (wrong library, a token
      // that lost its permissions) than emptied: don't mark the household's copies gone (plan deviation 14)
      return { complete: true, stats, error: 'The source listed no readable books, so nothing was marked as gone' }
    }
    await markMissing(db, sourceId, fetchStartedAt, stats)
    return { complete: true, stats, error: null }
  } catch (error) {
    // any failure — the connector's iterator, an upsert, the live-items check, or the removal pass
    // itself — must still resolve to the documented outcome shape, never reject
    return { complete: false, stats, error: error instanceof Error ? error.message : String(error) }
  }
}

async function hasLiveItems(db: Db, sourceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sourceItems.id })
    .from(sourceItems)
    .where(and(eq(sourceItems.sourceId, sourceId), isNull(sourceItems.removedAt)))
    .limit(1)
  return row !== undefined
}
