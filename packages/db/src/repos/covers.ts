import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { syncedSourceKinds } from '@mylib/domain'
import type { Db } from '../client'
import { assets, editions, proposals, sourceItems, sources, works } from '../schema'
import type { UserScope } from './scope'

export const COVER_RETRY_DAYS = 7

export interface CoverWork {
  sourceItemId: string
  editionId: string
  coverUrl: string
}

const coverUrl = sql<string>`${sourceItems.normalized}->>'coverUrl'`

/** Linked, present copies of this source that have no cover yet and weren't tried in the last week. */
export async function listCoverWork(db: Db, sourceId: string, limit = 50): Promise<CoverWork[]> {
  const rows = await db
    .select({ sourceItemId: sourceItems.id, editionId: editions.id, coverUrl })
    .from(sourceItems)
    .innerJoin(editions, eq(editions.id, sourceItems.editionId))
    .where(
      and(
        eq(sourceItems.sourceId, sourceId),
        eq(sourceItems.state, 'linked'),
        isNull(sourceItems.removedAt),
        isNull(editions.coverAssetId),
        isNotNull(coverUrl),
        or(isNull(sourceItems.coverCheckedAt), lt(sourceItems.coverCheckedAt, sql`now() - make_interval(days => ${COVER_RETRY_DAYS})`)),
      ),
    )
    .orderBy(asc(sourceItems.id))
    .limit(limit)
  return rows
}

/** Stores the asset once per hash, and gives it to the copy unless someone already did. */
export async function saveCover(db: Db, work: CoverWork, stored: { path: string; sha256: string; mime: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(assets).values({ kind: 'cover', path: stored.path, mime: stored.mime, sha256: stored.sha256 }).onConflictDoNothing({ target: assets.sha256 })
    const [asset] = await tx.select({ id: assets.id }).from(assets).where(eq(assets.sha256, stored.sha256))
    if (!asset) throw new Error('asset insert failed')
    await tx.update(editions).set({ coverAssetId: asset.id }).where(and(eq(editions.id, work.editionId), isNull(editions.coverAssetId)))
    await tx.update(sourceItems).set({ coverCheckedAt: new Date() }).where(eq(sourceItems.id, work.sourceItemId))
  })
}

export async function markCoverChecked(db: Db, sourceItemId: string): Promise<void> {
  await db.update(sourceItems).set({ coverCheckedAt: new Date() }).where(eq(sourceItems.id, sourceItemId))
}

/** Every source whose copies can have a cover: synced sources, shelf batches and CSV imports (a linked row's page has one; the job for a source with nothing to do exits at once). */
export async function listCoverSourceIds(db: Db): Promise<string[]> {
  return (await db.select({ id: sources.id }).from(sources).where(inArray(sources.kind, [...syncedSourceKinds, 'shelf', 'csv']))).map((r) => r.id)
}

/**
 * An asset is served only to someone who can see a book with a copy that uses it (plan deviation 14),
 * or (#161) to the person whose waiting Inbox book has it as its cover photo.
 */
export async function findVisibleAsset(db: Db, scope: UserScope, assetId: string): Promise<{ path: string; mime: string; sha256: string } | null> {
  const columns = { path: assets.path, mime: assets.mime, sha256: assets.sha256 }
  const [row] = await db
    .select(columns)
    .from(assets)
    .innerJoin(editions, eq(editions.coverAssetId, assets.id))
    .innerJoin(works, eq(works.id, editions.workId))
    .where(and(eq(assets.id, assetId), scope.visible))
    .limit(1)
  if (row !== undefined) return row
  const [waiting] = await db
    .select(columns)
    .from(assets)
    .innerJoin(proposals, sql`${proposals.payload}->>'coverAssetId' = ${assets.id}::text`)
    .where(and(eq(assets.id, assetId), eq(proposals.scope, 'user'), eq(proposals.userId, scope.userId), eq(proposals.status, 'pending')))
    .limit(1)
  return waiting ?? null
}
