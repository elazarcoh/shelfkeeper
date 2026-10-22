import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  editionFormats,
  editionFromWish,
  markManual,
  notFound,
  pickCoverAssetId,
  sortTitle,
  wishPageFromExtracted,
  wishVolumes,
  setForVolume,
  volumeSets,
  WishPage,
  type EditionFormat,
  type ExtractedPage,
  type WishFields,
  type WishMember,
  type WishRow,
  type WorkKind,
} from '@mylib/domain'
import type { Db } from '../client'
import {
  editions,
  queueEntries,
  readingSessions,
  setItems,
  sourceItems,
  userWorks,
  users,
  workContributors,
  works,
  wishes,
} from '../schema'
import { addEdition, clearSetVolumeCount, lockWorkEditions, replaceAuthors, replaceSeries } from './catalog'
import { linkedPeople, pruneOrphanPeople } from './people'
import { assertVisibleWork, type UserScope } from './scope'
import { shownWorkName } from './person-names'
import { refreshSearchDocument } from './search-index'
import { UNKNOWN_AUTHOR } from './source-catalog'
import { setPrimaryTitle, shownTitleField } from './titles'

const LIST_LIMIT = 500

/** Store only a snapshot that fits the schema; one bad field must never block the wish itself. */
function storablePage(page: WishPage | null): WishPage | null {
  if (page === null) return null
  const parsed = WishPage.safeParse(page)
  return parsed.success ? parsed.data : null
}

/**
 * Add or update the caller's wish on a book they can see. A null page never erases a stored snapshot.
 * Shares a lock on the work so a concurrent removal of the last wish cannot delete it under us.
 */
export async function upsertWish(db: Db, scope: UserScope, workId: string, fields: WishFields, page: WishPage | null = null): Promise<void> {
  const snapshot = storablePage(page)
  await db.transaction(async (tx) => {
    await assertVisibleWork(tx, scope, workId)
    const [shared] = await tx.select({ id: works.id }).from(works).where(eq(works.id, workId)).for('share')
    if (!shared) throw notFound('Book')
    await tx
      .insert(wishes)
      .values({ userId: scope.userId, workId, formats: fields.formats, language: fields.language, note: fields.note, page: snapshot })
      .onConflictDoUpdate({
        target: [wishes.userId, wishes.workId],
        set: {
          formats: fields.formats,
          language: fields.language,
          note: fields.note,
          ...(snapshot !== null ? { page: snapshot } : {}),
          updatedAt: new Date(),
        },
      })
  })
}

/** The minimal book a wish needs when nothing in the library matches: a manual-provenance work with its authors and series. */
export async function createWishWork(
  tx: Db,
  input: { title: string; authors: string[]; series: { name: string; position: number | null } | null; language: string | null; description: string | null; aiKind?: WorkKind },
): Promise<string> {
  const now = new Date()
  const provided = ['title', ...(input.description ? ['description'] : []), 'authors', ...(input.series ? ['series'] : [])]
  const [work] = await tx
    .insert(works)
    .values({
      title: input.title,
      subtitle: null,
      description: input.description,
      sortTitle: sortTitle(input.title),
      // an Ask AI pick's kind is automatic: unlocked, so the person's own choice still wins
      ...(input.aiKind && input.aiKind !== 'book' ? { kind: input.aiKind } : {}),
      provenance: input.aiKind && input.aiKind !== 'book' ? { ...markManual({}, provided, now), kind: { origin: 'ai', at: now.toISOString(), locked: false } } : markManual({}, provided, now),
    })
    .returning({ id: works.id })
  if (!work) throw new Error('work insert failed')
  await setPrimaryTitle(tx, work.id, { title: input.title, subtitle: null, language: input.language })
  await replaceAuthors(tx, work.id, input.authors.length > 0 ? input.authors : [UNKNOWN_AUTHOR], input.language)
  await replaceSeries(tx, work.id, input.series ? [{ name: input.series.name, position: input.series.position, positionEnd: null }] : [])
  await refreshSearchDocument(tx, work.id)
  return work.id
}

export async function addWishFromPage(
  db: Db,
  scope: UserScope,
  input: { page: ExtractedPage; target: { action: 'create_work' } | { action: 'wish_work'; workId: string }; fields: WishFields },
): Promise<{ workId: string }> {
  return db.transaction(async (tx) => {
    const p = input.page
    const workId =
      input.target.action === 'wish_work'
        ? input.target.workId
        : await createWishWork(tx, { title: p.title, authors: p.authors, series: p.series, language: p.language, description: p.description })
    await upsertWish(tx, scope, workId, input.fields, wishPageFromExtracted(p))
    return { workId }
  })
}

/** Drop the caller's wish; a book that existed only for wishes (nobody owns, tracks or queued it) goes with the last one. */
export async function removeWish(db: Db, scope: UserScope, workId: string): Promise<{ workDeleted: boolean }> {
  return db.transaction(async (tx) => {
    // lock order: work before wish, as deleteWork/mergeWorks do (the work delete cascades to wishes); also stops a
    // concurrent add/attach slipping in between the orphan check and the delete
    const locked = await tx.select({ id: works.id }).from(works).where(eq(works.id, workId)).for('update')
    if (locked.length === 0) throw notFound('Wish')
    const deleted = await tx
      .delete(wishes)
      .where(and(eq(wishes.userId, scope.userId), eq(wishes.workId, workId)))
      .returning({ id: wishes.id })
    if (deleted.length === 0) throw notFound('Wish')
    const [row] = await tx.execute<{ orphaned: boolean }>(sql`select (
      not exists (select 1 from ${editions} where ${editions.workId} = ${workId})
      and not exists (select 1 from ${wishes} where ${wishes.workId} = ${workId})
      and not exists (select 1 from ${userWorks} where ${userWorks.workId} = ${workId} and (${userWorks.status} <> 'none' or ${userWorks.rating} is not null or ${userWorks.review} is not null))
      and not exists (select 1 from ${queueEntries} where ${queueEntries.workId} = ${workId})
      and not exists (select 1 from ${readingSessions} where ${readingSessions.workId} = ${workId})
      and not exists (select 1 from ${setItems} where ${setItems.workId} = ${workId})
      and not exists (select 1 from ${sourceItems} where ${sourceItems.workId} = ${workId})
    ) as orphaned`)
    if (row?.orphaned !== true) return { workDeleted: false }
    const people = await linkedPeople(tx, { workIds: [workId] })
    await tx.delete(works).where(eq(works.id, workId))
    await pruneOrphanPeople(tx, people)
    return { workDeleted: true }
  })
}

/** The wish became an owned copy: pre-filled from the page, acquired on `on`, the wish gone. */
export async function boughtWish(
  db: Db,
  scope: UserScope,
  workId: string,
  format: EditionFormat,
  on: string,
  volume: number | null = null,
): Promise<{ workId: string; editionId: string; coverUrl: string | null }> {
  return db.transaction(async (tx) => {
    // lock order: the work's editions by id, then the work, then the wish (as deleteWork/mergeWorks do)
    await lockWorkEditions(tx, workId)
    const locked = await tx.select({ id: works.id }).from(works).where(eq(works.id, workId)).for('update')
    if (locked.length === 0) throw notFound('Wish')
    const [wish] = await tx
      .select({ id: wishes.id, page: wishes.page, language: wishes.language })
      .from(wishes)
      .where(and(eq(wishes.userId, scope.userId), eq(wishes.workId, workId)))
      .for('update')
    if (!wish) throw notFound('Wish')
    let clearsCount = false
    const input = editionFromWish(wish.page, format, on, volume)
    if (input.volume !== null) {
      // a volume belongs to the set matching showed: that set's language, and its established count
      const owned = await tx
        .select({ id: editions.id, format: editions.format, language: editions.language, volume: editions.volume, volumeCount: editions.volumeCount })
        .from(editions)
        .where(eq(editions.workId, workId))
      const set = setForVolume(volumeSets(owned), format, input.language ?? wish.language)
      input.language = set === undefined ? (input.language ?? wish.language) : set.language
      const top = Math.max(0, ...(set?.members.map((m) => m.volume ?? 0) ?? []))
      const setHasCount = set?.members.some((m) => m.volumeCount !== null) ?? false
      clearsCount = setHasCount && input.volume > Math.max(0, ...(set?.members.map((m) => m.volumeCount ?? 0) ?? []))
      if (setHasCount || (input.volumeCount !== null && input.volumeCount < top)) input.volumeCount = null
    }
    const editionId = await addEdition(tx, scope, workId, input)
    if (clearsCount) await clearSetVolumeCount(tx, workId, format, input.language ?? null)
    await tx.delete(wishes).where(eq(wishes.id, wish.id))
    return { workId, editionId, coverUrl: wish.page?.coverUrl ?? null }
  })
}

/** Anyone can read anyone's list, minus the books the viewer has hidden. */
export async function listWishes(db: Db, scope: UserScope, ownerUserId: string): Promise<WishRow[]> {
  const rows = await db
    .select({
      workId: works.id,
      title: shownTitleField(works.id, scope.languages, 'title'),
      kind: works.kind,
      formats: wishes.formats,
      language: wishes.language,
      note: wishes.note,
      page: wishes.page,
      createdAt: wishes.createdAt,
    })
    .from(wishes)
    .innerJoin(works, eq(works.id, wishes.workId))
    .where(and(eq(wishes.userId, ownerUserId), scope.visible))
    .orderBy(desc(wishes.createdAt), asc(wishes.id))
    .limit(LIST_LIMIT)
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.workId)
  const [authorRows, editionRows] = await Promise.all([
    db
      .select({ workId: workContributors.workId, name: shownWorkName(workContributors.nameId, workContributors.contributorId, scope.languages) })
      .from(workContributors)
      .where(inArray(workContributors.workId, ids))
      .orderBy(asc(workContributors.position)),
    db
      .select({
        workId: editions.workId,
        id: editions.id,
        format: editions.format,
        language: editions.language,
        volume: editions.volume,
        volumeCount: editions.volumeCount,
        coverAssetId: editions.coverAssetId,
        createdAt: editions.createdAt,
      })
      .from(editions)
      .where(inArray(editions.workId, ids))
      .orderBy(asc(editions.createdAt), asc(editions.id)),
  ])
  const authors = new Map<string, string[]>()
  for (const a of authorRows) authors.set(a.workId, [...(authors.get(a.workId) ?? []), a.name])
  const eds = new Map<string, typeof editionRows>()
  for (const e of editionRows) eds.set(e.workId, [...(eds.get(e.workId) ?? []), e])
  return rows.map((r) => {
    const own = eds.get(r.workId) ?? []
    return {
      workId: r.workId,
      title: r.title,
      kind: r.kind,
      authors: authors.get(r.workId) ?? [],
      formats: r.formats,
      language: r.language,
      note: r.note,
      page: r.page,
      coverAssetId: pickCoverAssetId(own),
      haveFormats: editionFormats.filter((f) => own.some((e) => e.format === f)),
      volumes: wishVolumes({ formats: r.formats, language: r.language }, own),
      createdAt: r.createdAt.toISOString(),
    }
  })
}

/** Every household member with how many (visible) wishes they have; the viewer first, then by name. */
export async function wishMembers(db: Db, scope: UserScope): Promise<WishMember[]> {
  const rows = await db
    .select({ userId: users.id, name: users.displayName, count: sql<number>`count(${works.id})::int` })
    .from(users)
    .leftJoin(wishes, eq(wishes.userId, users.id))
    .leftJoin(works, and(eq(works.id, wishes.workId), scope.visible))
    .groupBy(users.id, users.displayName)
  return rows.sort((a, b) => Number(b.userId === scope.userId) - Number(a.userId === scope.userId) || a.name.localeCompare(b.name))
}

/** Every household wish on one book, the viewer's first. */
export async function wishesForWork(db: Db, scope: UserScope, workId: string): Promise<{ userId: string; name: string; fields: WishFields }[]> {
  await assertVisibleWork(db, scope, workId)
  const rows = await db
    .select({ userId: wishes.userId, name: users.displayName, formats: wishes.formats, language: wishes.language, note: wishes.note })
    .from(wishes)
    .innerJoin(users, eq(users.id, wishes.userId))
    .where(eq(wishes.workId, workId))
  return rows
    .map((r) => ({ userId: r.userId, name: r.name, fields: { formats: r.formats, language: r.language, note: r.note } }))
    .sort((a, b) => Number(b.userId === scope.userId) - Number(a.userId === scope.userId) || a.name.localeCompare(b.name))
}
