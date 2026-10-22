import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import {
  applyHoldingAction,
  coveredPositions,
  deriveAvailability,
  DomainError,
  editionFieldNames,
  formatSeriesPosition,
  initialHoldingEvent,
  markManual,
  mergeKind,
  mergeWishes,
  notFound,
  pickCoverAssetId,
  sortTitle,
  statusAfterCompletion,
  workFieldNames,
  workKindLabel,
  type Availability,
  type CreateWorkInput,
  type EditionContributorRole,
  type EditionFormat,
  type EditionInput,
  type EditionOwnership,
  type EditionPatch,
  type HoldingChange,
  type HoldingEventType,
  type HoldingOrigin,
  type MatchCandidate,
  type Provenance,
  type ReadingStatus,
  type SeriesRef,
  type SessionOutcome,
  type SetScope,
  type SourceKind,
  type WorkKind,
  type WorkPatch,
} from '@mylib/domain'
import type { Db } from '../client'
import {
  assets,
  contributorNames,
  contributors,
  editionContributors,
  editionHoldingEvents,
  editions,
  proposals,
  queueEntries,
  readingProgress,
  readingSessions,
  series,
  setItems,
  sets,
  sourceItems,
  sources,
  tags,
  userHiddenWorks,
  users,
  userWorks,
  wishes,
  workContributors,
  workSeries,
  workTags,
  workTitles,
  works,
} from '../schema'
import { linkedPeople, pruneOrphanPeople } from './people'
import { uniqueIds, uniquePeople, upsertContributors, upsertSeries, upsertTags } from './lookups'
import { assertVisibleWork, requireAdmin, type UserScope } from './scope'
import { firstEditionLanguage, shownBookName, shownWorkName } from './person-names'
import { refreshSearchDocument } from './search-index'
import { accessibleSets } from './sets'
import { shownSeriesName } from './series-names'
import { moveTitles, setPrimaryTitle, shownEditionSubtitle, shownEditionTitle, shownTitleField } from './titles'

export interface EditionDetail {
  id: string
  format: EditionFormat
  title: string | null
  subtitle: string | null
  /** what the copy shows (#145): its own title, else the book's title in its language, else the primary */
  displayTitle: string
  displaySubtitle: string | null
  isbn13: string | null
  isbn10: string | null
  asin: string | null
  publisher: string | null
  publishedOn: string | null
  pageCount: number | null
  wordCount: number | null
  durationSec: number | null
  language: string | null
  shelfLocation: string | null
  volume: number | null
  volumeCount: number | null
  ownership: EditionOwnership
  inPossession: boolean
  provenance: Provenance
  coverAssetId: string | null
  narrators: { id: string; name: string }[]
  translators: { id: string; name: string }[]
  /** newest first */
  history: HoldingEventView[]
  /** the sources currently backing this copy (source names aren't secret), by name */
  sources: { name: string; kind: SourceKind }[]
}

export interface HoldingEventView {
  id: string
  type: HoldingEventType
  occurredOn: string
  note: string | null
  origin: HoldingOrigin
  actorName: string | null
}

export interface WorkDetail {
  id: string
  /** what this viewer sees (their language order, #145) */
  title: string
  subtitle: string | null
  /** the stored title and subtitle: what an edit form must start from, so a save never rewrites the primary with another language's text */
  primaryTitle: string
  primarySubtitle: string | null
  /** every title of the book, primary first (#145) */
  titles: { id: string; language: string | null; title: string; subtitle: string | null; primary: boolean }[]
  /** the id of the title row shown as `title` (the viewer's pick) */
  titleId: string
  description: string | null
  originalYear: number | null
  kind: WorkKind
  provenance: Provenance
  createdAt: Date
  availability: Availability
  /** `name` is the viewer's pick; `creditedName` is the spelling the book credits (else the primary), for edit forms */
  authors: { id: string; name: string; creditedName: string }[]
  series: { id: string; name: string; position: number | null; positionEnd: number | null }[]
  tags: { id: string; name: string }[]
  editions: EditionDetail[]
  me: { status: ReadingStatus; rating: number | null; review: string | null; inQueue: boolean }
  sets: { id: string; name: string; scope: SetScope }[]
  coverAssetId: string | null
}

// ---- relation writers ----------------------------------------------------

export async function replaceAuthors(db: Db, workId: string, names: readonly string[], language: string | null = null): Promise<void> {
  const before = (await db.select({ id: workContributors.contributorId }).from(workContributors).where(eq(workContributors.workId, workId))).map((r) => r.id)
  await db.delete(workContributors).where(eq(workContributors.workId, workId))
  const people = uniquePeople(await upsertContributors(db, names, language))
  if (people.length > 0) {
    await db.insert(workContributors).values(people.map((p, position) => ({ workId, contributorId: p.contributorId, nameId: p.nameId, position })))
  }
  await pruneOrphanPeople(db, before)
}

export async function replaceSeries(db: Db, workId: string, refs: readonly SeriesRef[]): Promise<void> {
  await db.delete(workSeries).where(eq(workSeries.workId, workId))
  if (refs.length === 0) return
  const ids = await upsertSeries(db, refs.map((r) => r.name))
  const seen = new Set<string>()
  const rows: (typeof workSeries.$inferInsert)[] = []
  refs.forEach((ref, i) => {
    const seriesId = ids[i]
    if (seriesId === undefined || seen.has(seriesId)) return
    seen.add(seriesId)
    rows.push({ workId, seriesId, position: ref.position, positionEnd: ref.positionEnd, sortIndex: rows.length })
  })
  await db.insert(workSeries).values(rows)
}

export async function replaceTags(db: Db, workId: string, names: readonly string[]): Promise<void> {
  await db.delete(workTags).where(eq(workTags.workId, workId))
  const ids = uniqueIds(await upsertTags(db, names))
  if (ids.length > 0) await db.insert(workTags).values(ids.map((tagId) => ({ workId, tagId })))
}

/** Swaps one role's people on an edition and returns those it unlinked; the caller prunes them (once, when it swaps several roles). */
async function swapEditionPeople(
  db: Db,
  editionId: string,
  role: EditionContributorRole,
  names: readonly string[],
  language: string | null,
): Promise<string[]> {
  const before = (
    await db
      .select({ id: editionContributors.contributorId })
      .from(editionContributors)
      .where(and(eq(editionContributors.editionId, editionId), eq(editionContributors.role, role)))
  ).map((r) => r.id)
  await db.delete(editionContributors).where(and(eq(editionContributors.editionId, editionId), eq(editionContributors.role, role)))
  const people = uniquePeople(await upsertContributors(db, names, language))
  if (people.length > 0) {
    await db
      .insert(editionContributors)
      .values(people.map((p, position) => ({ editionId, contributorId: p.contributorId, nameId: p.nameId, role, position })))
  }
  return before
}

export async function replaceEditionPeople(
  db: Db,
  editionId: string,
  role: EditionContributorRole,
  names: readonly string[],
  language: string | null = null,
): Promise<void> {
  await pruneOrphanPeople(db, await swapEditionPeople(db, editionId, role, names, language))
}

function providedFields<K extends string>(names: readonly K[], values: Partial<Record<K, unknown>>): K[] {
  return names.filter((name) => {
    const v = values[name]
    return v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)
  })
}

/** Volume and count as they will be after a write: a count needs a volume, and a volume can't exceed its count (#66). */
function checkVolume(volume: number | null, volumeCount: number | null): void {
  if (volumeCount !== null && volume === null) throw new DomainError('INVALID', 'Set the volume number first')
  if (volume !== null && volumeCount !== null && volume > volumeCount) throw new DomainError('INVALID', "Volume can't be higher than the number of volumes")
}

/** Volumes of one set in a single input must not name different counts (null inherits). */
function checkVolumeCountsAgree(inputs: readonly EditionInput[]): void {
  const counts = new Map<string, number>()
  for (const e of inputs) {
    if (e.volume === null || e.volumeCount === null) continue
    const key = `${e.format}:${e.language ?? ''}`
    const seen = counts.get(key)
    if (seen !== undefined && seen !== e.volumeCount) throw new DomainError('INVALID', 'Volumes of one edition disagree on the number of volumes')
    counts.set(key, e.volumeCount)
  }
}

/** The set's count was wrong (a volume above it exists): it becomes unknown on every edition of the set. */
export async function clearSetVolumeCount(tx: Db, workId: string, format: EditionFormat, language: string | null): Promise<void> {
  await tx
    .update(editions)
    .set({ volumeCount: null })
    .where(and(eq(editions.workId, workId), eq(editions.format, format), sql`${editions.language} is not distinct from ${language}`, isNotNull(editions.volume)))
}

/**
 * Keeps volume_count equal across an edition's volume set (same work, format and language; null is its own language).
 * With a count, it is pushed to the other volumes. Without one, the edition adopts the set's largest count
 * (if that covers its volume) — unless `clear`, which removes the count from the whole set.
 */
export async function syncVolumeCount(tx: Db, workId: string, editionId: string, clear = false): Promise<void> {
  const [e] = await tx
    .select({ format: editions.format, language: editions.language, volume: editions.volume, volumeCount: editions.volumeCount })
    .from(editions)
    .where(eq(editions.id, editionId))
  if (!e || e.volume === null) return
  const siblings = and(
    eq(editions.workId, workId),
    eq(editions.format, e.format),
    sql`${editions.language} is not distinct from ${e.language}`,
    isNotNull(editions.volume),
    sql`${editions.id} <> ${editionId}`,
  )
  if (e.volumeCount !== null) {
    // the count can't be lower than any volume already in the set (itself included)
    const [top] = await tx
      .select({ n: sql<number | null>`max(${editions.volume})` })
      .from(editions)
      .where(or(siblings, eq(editions.id, editionId)))
    const max = top?.n ?? e.volume
    if (max > e.volumeCount) throw new DomainError('INVALID', `Volume ${max} is in the catalog, so the number of volumes can't be lower`)
    await tx.update(editions).set({ volumeCount: e.volumeCount }).where(siblings)
    return
  }
  if (clear) {
    await tx.update(editions).set({ volumeCount: null }).where(siblings)
    return
  }
  const [set] = await tx.select({ n: sql<number | null>`max(${editions.volumeCount})` }).from(editions).where(siblings)
  if (set?.n != null && set.n >= e.volume) await tx.update(editions).set({ volumeCount: set.n }).where(eq(editions.id, editionId))
}

const today = (): string => new Date().toISOString().slice(0, 10)

async function insertEdition(db: Db, workId: string, e: EditionInput, now: Date, actorUserId: string | null): Promise<string> {
  const { narrators, translators, ownership, holdingOn, holdingNote, ...fields } = e
  const [row] = await db
    .insert(editions)
    .values({
      workId,
      ...fields,
      ownership,
      inPossession: true,
      provenance: markManual({}, providedFields(editionFieldNames, e), now),
    })
    .returning({ id: editions.id })
  if (!row) throw new Error('edition insert failed')
  await db.insert(editionHoldingEvents).values({
    editionId: row.id,
    type: initialHoldingEvent(ownership),
    occurredOn: holdingOn ?? today(),
    note: holdingNote,
    origin: 'manual',
    actorUserId,
  })
  // new people are named in the edition's language
  await replaceEditionPeople(db, row.id, 'narrator', narrators, e.language)
  await replaceEditionPeople(db, row.id, 'translator', translators, e.language)
  return row.id
}

/**
 * Loads the edition (and locks it and its work row) for a read-modify-write.
 * Must run inside a transaction — the lock serializes concurrent mutations of the same
 * edition/work (updateEdition, changeHolding, deleteEdition, splitEdition), so two racing
 * calls cannot both act on the same stale state (e.g. double holding events, or both
 * deleting/splitting past the last-edition guard).
 */
async function visibleEdition(db: Db, scope: UserScope, editionId: string) {
  const [row] = await db
    .select({
      id: editions.id,
      workId: editions.workId,
      provenance: editions.provenance,
      ownership: editions.ownership,
      inPossession: editions.inPossession,
      format: editions.format,
      language: editions.language,
      volume: editions.volume,
      volumeCount: editions.volumeCount,
    })
    .from(editions)
    .innerJoin(works, eq(works.id, editions.workId))
    .where(and(eq(editions.id, editionId), scope.visible))
    .for('update')
  if (!row) throw notFound('Edition')
  return row
}

async function editionCount(db: Db, workId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(editions).where(eq(editions.workId, workId))
  return row?.n ?? 0
}

// ---- public API ------------------------------------------------------------

export async function createWork(db: Db, input: CreateWorkInput, actorUserId: string | null = null): Promise<string> {
  return db.transaction(async (tx) => {
    const now = new Date()
    const [work] = await tx
      .insert(works)
      .values({
        title: input.title,
        sortTitle: sortTitle(input.title),
        subtitle: input.subtitle,
        description: input.description,
        originalYear: input.originalYear,
        kind: input.kind ?? 'book',
        provenance: markManual({}, providedFields(workFieldNames, input), now),
      })
      .returning({ id: works.id })
    if (!work) throw new Error('work insert failed')
    const firstLanguage = input.editions.find((e) => e.language !== null)?.language ?? null
    await setPrimaryTitle(tx, work.id, { title: input.title, subtitle: input.subtitle ?? null, language: firstLanguage })
    await replaceAuthors(tx, work.id, input.authors, firstLanguage)
    await replaceSeries(tx, work.id, input.series)
    await replaceTags(tx, work.id, input.tags)
    checkVolumeCountsAgree(input.editions)
    const editionIds: string[] = []
    for (const edition of input.editions) editionIds.push(await insertEdition(tx, work.id, edition, now, actorUserId))
    for (const id of editionIds) await syncVolumeCount(tx, work.id, id)
    await refreshSearchDocument(tx, work.id)
    return work.id
  })
}

export async function getWorkDetail(db: Db, scope: UserScope, workId: string): Promise<WorkDetail> {
  const [work] = await db
    .select({
      id: works.id,
      title: shownTitleField(works.id, scope.languages, 'title'),
      subtitle: shownTitleField(works.id, scope.languages, 'subtitle'),
      primaryTitle: works.title,
      primarySubtitle: works.subtitle,
      description: works.description,
      originalYear: works.originalYear,
      kind: works.kind,
      provenance: works.provenance,
      createdAt: works.createdAt,
    })
    .from(works)
    .where(and(eq(works.id, workId), scope.visible))
  if (!work) throw notFound('Book')

  const [authorRows, seriesRows, tagRows, editionRows, peopleRows, mineRows, queueRows, setRows, historyRows, sourceRows] = await Promise.all([
    db
      .select({ id: workContributors.contributorId, name: shownWorkName(workContributors.nameId, workContributors.contributorId, scope.languages), creditedName: sql<string>`coalesce(${contributorNames.name}, ${contributors.name})` })
      .from(workContributors)
      .innerJoin(contributors, eq(contributors.id, workContributors.contributorId))
      .leftJoin(contributorNames, eq(contributorNames.id, workContributors.nameId))
      .where(eq(workContributors.workId, workId))
      .orderBy(asc(workContributors.position)),
    db
      .select({ id: series.id, name: shownSeriesName(series.id, scope.languages), position: workSeries.position, positionEnd: workSeries.positionEnd })
      .from(workSeries)
      .innerJoin(series, eq(series.id, workSeries.seriesId))
      .where(eq(workSeries.workId, workId))
      .orderBy(asc(workSeries.sortIndex)),
    db
      .select({ id: tags.id, name: tags.name })
      .from(workTags)
      .innerJoin(tags, eq(tags.id, workTags.tagId))
      .where(eq(workTags.workId, workId))
      .orderBy(asc(tags.name)),
    db
      .select({
        id: editions.id,
        format: editions.format,
        title: editions.title,
        subtitle: editions.subtitle,
        displayTitle: shownEditionTitle(editions.id),
        displaySubtitle: shownEditionSubtitle(editions.id),
        isbn13: editions.isbn13,
        isbn10: editions.isbn10,
        asin: editions.asin,
        publisher: editions.publisher,
        publishedOn: editions.publishedOn,
        pageCount: editions.pageCount,
        wordCount: editions.wordCount,
        durationSec: editions.durationSec,
        language: editions.language,
        shelfLocation: editions.shelfLocation,
        volume: editions.volume,
        volumeCount: editions.volumeCount,
        ownership: editions.ownership,
        inPossession: editions.inPossession,
        provenance: editions.provenance,
        coverAssetId: editions.coverAssetId,
        createdAt: editions.createdAt,
      })
      .from(editions)
      .where(eq(editions.workId, workId))
      // editions created in one transaction share created_at, so fall back to format order, then volume order
      .orderBy(asc(editions.createdAt), asc(editions.format), sql`${editions.volume} asc nulls first`, asc(editions.id)),
    db
      .select({
        editionId: editionContributors.editionId,
        role: editionContributors.role,
        id: editionContributors.contributorId,
        name: shownBookName(editionContributors.nameId, editionContributors.contributorId, editions.workId, editions.language),
      })
      .from(editionContributors)
      .innerJoin(editions, eq(editions.id, editionContributors.editionId))
      .where(eq(editions.workId, workId))
      .orderBy(asc(editionContributors.position)),
    db
      .select({ status: userWorks.status, rating: userWorks.rating, review: userWorks.review })
      .from(userWorks)
      .where(and(eq(userWorks.userId, scope.userId), eq(userWorks.workId, workId))),
    db
      .select({ workId: queueEntries.workId })
      .from(queueEntries)
      .where(and(eq(queueEntries.userId, scope.userId), eq(queueEntries.workId, workId))),
    db
      .select({ id: sets.id, name: sets.name, scope: sets.scope })
      .from(setItems)
      .innerJoin(sets, eq(sets.id, setItems.setId))
      .where(and(eq(setItems.workId, workId), accessibleSets(scope.userId)))
      .orderBy(asc(sets.name)),
    db
      .select({
        id: editionHoldingEvents.id,
        editionId: editionHoldingEvents.editionId,
        type: editionHoldingEvents.type,
        occurredOn: editionHoldingEvents.occurredOn,
        note: editionHoldingEvents.note,
        origin: editionHoldingEvents.origin,
        actorName: users.displayName,
      })
      .from(editionHoldingEvents)
      .innerJoin(editions, eq(editions.id, editionHoldingEvents.editionId))
      .leftJoin(users, eq(users.id, editionHoldingEvents.actorUserId))
      .where(eq(editions.workId, workId))
      .orderBy(desc(editionHoldingEvents.occurredOn), desc(editionHoldingEvents.createdAt)),
    db
      .selectDistinct({ editionId: editions.id, sourceId: sources.id, name: sources.name, kind: sources.kind })
      .from(sourceItems)
      .innerJoin(editions, eq(editions.id, sourceItems.editionId))
      .innerJoin(sources, eq(sources.id, sourceItems.sourceId))
      .where(and(eq(editions.workId, workId), isNull(sourceItems.removedAt)))
      .orderBy(asc(sources.name), asc(sources.id), asc(editions.id)),
  ])

  const people = (editionId: string, role: EditionContributorRole) =>
    peopleRows.filter((p) => p.editionId === editionId && p.role === role).map((p) => ({ id: p.id, name: p.name }))
  const mine = mineRows[0]
  const titleRows = await db
    .select({ id: workTitles.id, language: workTitles.language, title: workTitles.title, subtitle: workTitles.subtitle, primary: workTitles.primary })
    .from(workTitles)
    .where(eq(workTitles.workId, workId))
    .orderBy(desc(workTitles.primary), asc(workTitles.id))
  // the same rule as shownTitleField: the first of the viewer's languages the book has, else the primary
  const shownTitle = scope.languages.flatMap((l) => titleRows.filter((r) => r.language === l)).at(0) ?? titleRows.find((r) => r.primary)

  return {
    ...work,
    titles: titleRows,
    titleId: shownTitle?.id ?? '',
    authors: authorRows,
    series: seriesRows,
    tags: tagRows,
    availability: deriveAvailability(editionRows),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop createdAt (only fetched for pickCoverAssetId below); not part of EditionDetail
    editions: editionRows.map(({ createdAt, ...e }) => ({
      ...e,
      narrators: people(e.id, 'narrator'),
      translators: people(e.id, 'translator'),
      history: historyRows
        .filter((h) => h.editionId === e.id)
        .map((h) => ({ id: h.id, type: h.type, occurredOn: h.occurredOn, note: h.note, origin: h.origin, actorName: h.actorName })),
      sources: sourceRows.filter((r) => r.editionId === e.id).map((r) => ({ name: r.name, kind: r.kind })),
    })),
    me: {
      status: mine?.status ?? 'none',
      rating: mine?.rating ?? null,
      review: mine?.review ?? null,
      inQueue: queueRows.length > 0,
    },
    sets: setRows,
    // same rule as getWorkCards (R19): a book's cover never differs between its card and its page
    coverAssetId: pickCoverAssetId(editionRows),
  }
}

/** Sets every work of a series the person can see; hidden works are left alone. `changed` counts the ones whose kind differs. */
export async function setSeriesKind(db: Db, scope: UserScope, seriesId: string, kind: WorkKind): Promise<{ changed: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: works.id, kind: works.kind })
      .from(works)
      .innerJoin(workSeries, eq(workSeries.workId, works.id))
      .where(and(eq(workSeries.seriesId, seriesId), scope.visible))
      .orderBy(works.id)
      .for('update', { of: works })
    for (const row of rows) await updateWork(tx, scope, row.id, { kind })
    return { changed: rows.filter((r) => r.kind !== kind).length }
  })
}

export async function updateWork(db: Db, scope: UserScope, workId: string, patch: WorkPatch): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ provenance: works.provenance, title: works.title, subtitle: works.subtitle })
      .from(works)
      .where(and(eq(works.id, workId), scope.visible))
      .for('update')
    if (!current) throw notFound('Book')

    const changed = workFieldNames.filter((f) => patch[f] !== undefined)
    const [edited] = patch.titleId === undefined ? [] : await tx.select().from(workTitles).where(and(eq(workTitles.id, patch.titleId), eq(workTitles.workId, workId)))
    if (patch.titleId !== undefined && !edited) throw notFound('Title')
    if (edited && !edited.primary) {
      // another language's row: only that row changes; work.* stays the primary's
      const title = patch.title ?? edited.title
      await tx
        .update(workTitles)
        .set({ title, subtitle: patch.subtitle === undefined ? edited.subtitle : patch.subtitle, sortTitle: sortTitle(title) })
        .where(eq(workTitles.id, edited.id))
    } else if (patch.title !== undefined || patch.subtitle !== undefined) {
      await setPrimaryTitle(tx, workId, { title: patch.title ?? current.title, subtitle: patch.subtitle === undefined ? current.subtitle : patch.subtitle })
    }
    await tx
      .update(works)
      .set({
        description: patch.description,
        originalYear: patch.originalYear,
        kind: patch.kind,
        provenance: markManual(current.provenance, changed, new Date()),
      })
      .where(eq(works.id, workId))
    if (patch.authors !== undefined) {
      const [first] = await tx.select({ language: firstEditionLanguage(works.id) }).from(works).where(eq(works.id, workId))
      await replaceAuthors(tx, workId, patch.authors, first?.language ?? null)
    }
    if (patch.series !== undefined) await replaceSeries(tx, workId, patch.series)
    if (patch.tags !== undefined) await replaceTags(tx, workId, patch.tags)
    await refreshSearchDocument(tx, workId)
  })
}

// lock the book's editions by id before visibleEdition locks edition then work (the order mergeWorks uses, "#6's order"),
// so two saves of different volumes of one book can't deadlock while syncVolumeCount rewrites siblings
export async function lockWorkEditions(tx: Db, workId: string): Promise<void> {
  await tx.select({ id: editions.id }).from(editions).where(eq(editions.workId, workId)).orderBy(asc(editions.id)).for('update')
}

// the same, starting from one edition: read its work unlocked, then lock the work's editions
async function lockOwnerEditions(tx: Db, editionId: string): Promise<void> {
  const [owner] = await tx.select({ workId: editions.workId }).from(editions).where(eq(editions.id, editionId))
  if (owner) await lockWorkEditions(tx, owner.workId)
}

export async function addEdition(db: Db, scope: UserScope, workId: string, input: EditionInput): Promise<string> {
  return db.transaction(async (tx) => {
    await assertVisibleWork(tx, scope, workId)
    // same order as updateEdition and mergeWorks: editions by id, then the work
    await lockWorkEditions(tx, workId)
    const id = await insertEdition(tx, workId, input, new Date(), scope.userId)
    await syncVolumeCount(tx, workId, id)
    await refreshSearchDocument(tx, workId)
    return id
  })
}

export async function updateEdition(db: Db, scope: UserScope, editionId: string, patch: EditionPatch): Promise<void> {
  await db.transaction(async (tx) => {
    await lockOwnerEditions(tx, editionId)
    const edition = await visibleEdition(tx, scope, editionId)
    const { narrators, translators, ...fields } = patch
    const changed = editionFieldNames.filter((f) => patch[f] !== undefined)
    // clearing the volume clears its count; otherwise check the pair as it will be stored
    const volume = patch.volume === undefined ? edition.volume : patch.volume
    // moving to another format or language leaves the old set's count behind: the destination set's count wins (inherited below)
    const moves = (patch.format !== undefined && patch.format !== edition.format) || (patch.language !== undefined && patch.language !== edition.language)
    const keptCount = moves ? null : edition.volumeCount
    const volumeCount = patch.volume === null ? null : patch.volumeCount === undefined ? keptCount : patch.volumeCount
    checkVolume(volume, volumeCount)
    await tx
      .update(editions)
      .set({ ...fields, volumeCount, provenance: markManual(edition.provenance, changed, new Date()) })
      .where(eq(editions.id, editionId))
    // an explicit null count (volume kept) removes the count from the whole set
    if (patch.volume !== undefined || patch.volumeCount !== undefined || patch.format !== undefined || patch.language !== undefined)
      await syncVolumeCount(tx, edition.workId, editionId, patch.volumeCount === null && patch.volume !== null)
    if (narrators !== undefined || translators !== undefined) {
      // new people are named in the edition's language
      const language = patch.language === undefined ? edition.language : patch.language
      // prune once at the end: someone moved between roles in one save keeps their id
      const removed: string[] = []
      if (narrators !== undefined) removed.push(...(await swapEditionPeople(tx, editionId, 'narrator', narrators, language)))
      if (translators !== undefined) removed.push(...(await swapEditionPeople(tx, editionId, 'translator', translators, language)))
      await pruneOrphanPeople(tx, removed)
    }
    await refreshSearchDocument(tx, edition.workId)
  })
}

/** Throws NOT_FOUND unless I can see this copy (checked before anything is downloaded for it). */
export async function assertVisibleEdition(db: Db, scope: UserScope, editionId: string): Promise<void> {
  const [row] = await db.select({ id: editions.id }).from(editions).innerJoin(works, eq(works.id, editions.workId)).where(and(eq(editions.id, editionId), scope.visible))
  if (!row) throw notFound('Edition')
}

/** A stored cover picture's asset row, the same picture twice being one row: its id. */
export async function coverAssetRow(tx: Db, stored: { path: string; sha256: string; mime: string }): Promise<string> {
  await tx.insert(assets).values({ kind: 'cover', path: stored.path, mime: stored.mime, sha256: stored.sha256 }).onConflictDoNothing({ target: assets.sha256 })
  const [asset] = await tx.select({ id: assets.id }).from(assets).where(eq(assets.sha256, stored.sha256))
  if (!asset) throw new Error('asset insert failed')
  return asset.id
}

/** A cover the person picked (from a book page): it replaces the copy's cover; the file is stored once per hash. */
export async function setEditionCover(db: Db, scope: UserScope, editionId: string, stored: { path: string; sha256: string; mime: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await visibleEdition(tx, scope, editionId)
    await tx.update(editions).set({ coverAssetId: await coverAssetRow(tx, stored) }).where(eq(editions.id, editionId))
  })
}

/** Holding changes (spec §4.1a): the only way a copy is "lost" — nothing is deleted. */
export async function changeHolding(db: Db, scope: UserScope, editionId: string, change: HoldingChange): Promise<void> {
  await db.transaction(async (tx) => {
    const edition = await visibleEdition(tx, scope, editionId)
    const result = applyHoldingAction(edition, change.action)
    if (!result) throw new DomainError('INVALID', 'That change does not apply to this copy right now')
    await tx.update(editions).set(result.next).where(eq(editions.id, editionId))
    await tx.insert(editionHoldingEvents).values({
      editionId,
      type: result.event,
      occurredOn: change.on,
      note: change.note,
      origin: 'manual',
      actorUserId: scope.userId,
    })
  })
}

/** For editions entered by mistake. Admins only; a book keeps at least one edition. */
export async function deleteEdition(db: Db, scope: UserScope, editionId: string): Promise<void> {
  requireAdmin(scope)
  await db.transaction(async (tx) => {
    const edition = await visibleEdition(tx, scope, editionId)
    if ((await editionCount(tx, edition.workId)) <= 1) {
      throw new DomainError('CONFLICT', 'A book needs at least one edition — delete the book instead')
    }
    // the edition's points lose their volume (FK set null): where a point without one already holds that day, they would clash, so they go
    await tx.delete(readingProgress).where(
      and(
        eq(readingProgress.editionId, editionId),
        sql`exists (select 1 from ${readingProgress} as other where other.session_id = ${readingProgress.sessionId} and other.occurred_on = ${readingProgress.occurredOn} and other.edition_id is null)`,
      ),
    )
    const people = await linkedPeople(tx, { editionIds: [editionId] })
    await tx.delete(editions).where(eq(editions.id, editionId))
    await pruneOrphanPeople(tx, people)
    await refreshSearchDocument(tx, edition.workId)
  })
}

export async function splitEdition(db: Db, scope: UserScope, editionId: string): Promise<string> {
  return db.transaction(async (tx) => {
    // same order as updateEdition and mergeWorks: editions by id, then the work
    await lockOwnerEditions(tx, editionId)
    const edition = await visibleEdition(tx, scope, editionId)
    if ((await editionCount(tx, edition.workId)) <= 1) {
      throw new DomainError('CONFLICT', 'This is the only edition of the book')
    }
    const source = await getWorkDetail(tx, scope, edition.workId)
    const [work] = await tx
      .insert(works)
      .values({
        title: source.title,
        sortTitle: sortTitle(source.title),
        subtitle: source.subtitle,
        description: source.description,
        originalYear: source.originalYear,
        kind: source.kind,
        provenance: source.provenance,
      })
      .returning({ id: works.id })
    if (!work) throw new Error('work insert failed')
    await setPrimaryTitle(tx, work.id, { title: source.title, subtitle: source.subtitle, language: edition.language })
    await replaceAuthors(tx, work.id, source.authors.map((a) => a.name), edition.language)
    await replaceSeries(tx, work.id, source.series.map((s) => ({ name: s.name, position: s.position, positionEnd: s.positionEnd })))
    await replaceTags(tx, work.id, source.tags.map((tag) => tag.name))
    // The split-off book stays hidden from the same people and stays in the same sets.
    const hidden = await tx
      .select({ userId: userHiddenWorks.userId, hiddenBy: userHiddenWorks.hiddenBy })
      .from(userHiddenWorks)
      .where(eq(userHiddenWorks.workId, edition.workId))
    if (hidden.length > 0) await tx.insert(userHiddenWorks).values(hidden.map((h) => ({ ...h, workId: work.id })))
    const memberships = await tx
      .select({ setId: setItems.setId })
      .from(setItems)
      .where(eq(setItems.workId, edition.workId))
    if (memberships.length > 0) await tx.insert(setItems).values(memberships.map((m) => ({ ...m, workId: work.id })))
    // each person's status/rating/notes follow to the split-off book (sessions follow their edition below)
    const tracking = await tx
      .select({ userId: userWorks.userId, status: userWorks.status, rating: userWorks.rating, review: userWorks.review, ratedAt: userWorks.ratedAt })
      .from(userWorks)
      .where(eq(userWorks.workId, edition.workId))
    if (tracking.length > 0) await tx.insert(userWorks).values(tracking.map((row) => ({ ...row, workId: work.id })))
    await tx.update(editions).set({ workId: work.id, volume: null, volumeCount: null }).where(eq(editions.id, editionId))
    // sessions follow their edition, so a session's work always matches its edition's work (stats rebuild on read)
    await tx.update(readingSessions).set({ workId: work.id }).where(eq(readingSessions.editionId, editionId))
    await refreshSearchDocument(tx, edition.workId)
    await refreshSearchDocument(tx, work.id)
    return work.id
  })
}

export async function deleteWork(db: Db, scope: UserScope, workId: string): Promise<void> {
  requireAdmin(scope)
  await db.transaction(async (tx) => {
    await assertVisibleWork(tx, scope, workId)
    // #6: the cascade's lock order follows Postgres's internal trigger names, so it is taken here explicitly first, in
    // the order every other write uses (an edition before its sessions, as add-with-length does): never a deadlock
    await tx.select({ id: editions.id }).from(editions).where(eq(editions.workId, workId)).orderBy(asc(editions.id)).for('update')
    await tx
      .select({ id: readingSessions.id })
      .from(readingSessions)
      .where(eq(readingSessions.workId, workId))
      .orderBy(asc(readingSessions.id))
      .for('update')
    const people = await linkedPeople(tx, { workIds: [workId] })
    await tx.delete(works).where(eq(works.id, workId))
    await pruneOrphanPeople(tx, people)
  })
}

export interface MergeResult {
  workId: string
  /** one line per value that lost a conflict, for the admin to see what the merge did not carry over */
  dropped: string[]
}

const MAX_MERGE_SOURCES = 20

/**
 * Makes the sources' editions editions of the target and deletes the sources (#28). Admins only; the target's own
 * title, authors and description win, and `dropped` names what lost. Per-person tracking is merged, never lost.
 */
export async function mergeWorks(db: Db, scope: UserScope, targetWorkId: string, sourceWorkIds: readonly string[]): Promise<MergeResult> {
  requireAdmin(scope)
  if (sourceWorkIds.length < 1 || sourceWorkIds.length > MAX_MERGE_SOURCES) {
    throw new DomainError('INVALID', `Merge 1 to ${MAX_MERGE_SOURCES} books at a time`)
  }
  if (new Set(sourceWorkIds).size !== sourceWorkIds.length) throw new DomainError('INVALID', 'The same book is listed twice')
  if (sourceWorkIds.includes(targetWorkId)) throw new DomainError('INVALID', 'A book cannot be merged into itself')
  const sourceIds = [...sourceWorkIds]
  const allIds = [targetWorkId, ...sourceIds]

  return db.transaction(async (tx) => {
    await lockForMerge(tx, allIds)
    return { workId: targetWorkId, dropped: await moveIntoTarget(tx, scope, targetWorkId, sourceIds) }
  })
}

export async function lockForMerge(tx: Db, allIds: string[]): Promise<void> {
  // #6's order (edition, work, then sessions), widened to every involved book and each level sorted by id, so a
  // concurrent add-with-length or delete cannot deadlock with it. A session started on a source mid-merge waits,
  // then fails its foreign key cleanly once the source is gone instead of being cascaded away silently.
  // A progress write locks its session, then KEY-SHAREs the point's edition; this locks editions, then sessions, so
  // Postgres may abort one of the two as a deadlock. It is retried and nothing is lost (as before).
  await tx.select({ id: editions.id }).from(editions).where(inArray(editions.workId, allIds)).orderBy(asc(editions.id)).for('update')
  await tx.select({ id: works.id }).from(works).where(inArray(works.id, allIds)).orderBy(asc(works.id)).for('update')
  await tx.select({ id: wishes.id }).from(wishes).where(inArray(wishes.workId, allIds)).orderBy(asc(wishes.id)).for('update')
  await tx
    .select({ id: readingSessions.id })
    .from(readingSessions)
    .where(inArray(readingSessions.workId, allIds))
    .orderBy(asc(readingSessions.id))
    .for('update')
}

/** Everything of a merge after the locks (`lockForMerge`) and validation; returns what lost a conflict. */
export async function moveIntoTarget(tx: Db, scope: UserScope, targetWorkId: string, sourceIds: string[]): Promise<string[]> {
  for (const id of [targetWorkId, ...sourceIds]) await assertVisibleWork(tx, scope, id)

  const dropped: string[] = []
  const target = await getWorkDetail(tx, scope, targetWorkId)
  const knownAuthors = new Set(target.authors.map((a) => a.id))
  const targetSeries = new Map(target.series.map((s) => [s.id, { position: s.position, positionEnd: s.positionEnd }]))
  const label = (p: { position: number | null; positionEnd: number | null }) => `#${formatSeriesPosition(p.position, p.positionEnd)}`
  let kept = { kind: target.kind, provenance: target.provenance }
  for (const id of sourceIds) {
    const source = await getWorkDetail(tx, scope, id)
    dropped.push(...(await moveTitles(tx, id, targetWorkId)))
    const merged = mergeKind(kept, source)
    if (merged.fromSource) {
      // the source's provenance entry comes along, so a lock on its kind stays a lock
      const provenance = { ...kept.provenance }
      if (source.provenance.kind) provenance.kind = source.provenance.kind
      else delete provenance.kind
      kept = { kind: merged.kind, provenance }
    } else if (source.kind !== kept.kind) {
      dropped.push(`Kind: ${workKindLabel[source.kind]} (from “${source.title}”)`)
    }
    // authors are never unioned: "Rowling" and "רולינג" are one author, so the target's list stands
    for (const author of source.authors) {
      if (knownAuthors.has(author.id)) continue
      knownAuthors.add(author.id)
      dropped.push(`Author ${author.name}`)
    }
    for (const s of source.series) {
      const held = targetSeries.get(s.id)
      if (held === undefined) {
        await tx.insert(workSeries).values({ workId: targetWorkId, seriesId: s.id, position: s.position, positionEnd: s.positionEnd, sortIndex: targetSeries.size })
        targetSeries.set(s.id, { position: s.position, positionEnd: s.positionEnd })
      } else if ((s.position !== null && !coveredPositions(held.position, held.positionEnd).includes(s.position)) || (s.positionEnd !== null && s.positionEnd !== held.positionEnd)) {
        // a single position the target's range holds is no conflict; a range is held only by the same range (#122)
        dropped.push(`${s.name} ${label(s)} (${held.position === null ? 'kept without a position' : `kept ${label(held)}`})`)
      }
    }
  }

  if (kept.kind !== target.kind || kept.provenance.kind !== target.provenance.kind) {
    await tx.update(works).set({ kind: kept.kind, provenance: kept.provenance }).where(eq(works.id, targetWorkId))
  }

  const sourceTags = await tx.select({ tagId: workTags.tagId }).from(workTags).where(inArray(workTags.workId, sourceIds))
  if (sourceTags.length > 0) {
    await tx.insert(workTags).values(sourceTags.map((r) => ({ workId: targetWorkId, tagId: r.tagId }))).onConflictDoNothing()
  }
  // editions bring their loans and covers; sessions (even ones without an edition) bring their progress and snoozes
  await tx.update(editions).set({ workId: targetWorkId }).where(inArray(editions.workId, sourceIds))
  await tx.update(readingSessions).set({ workId: targetWorkId }).where(inArray(readingSessions.workId, sourceIds))
  await tx.update(sourceItems).set({ workId: targetWorkId }).where(inArray(sourceItems.workId, sourceIds))
  const memberships = await tx.select({ setId: setItems.setId }).from(setItems).where(inArray(setItems.workId, sourceIds))
  if (memberships.length > 0) {
    await tx.insert(setItems).values(memberships.map((m) => ({ setId: m.setId, workId: targetWorkId }))).onConflictDoNothing()
  }

  await mergeHidden(tx, targetWorkId, sourceIds, dropped)
  await mergeTracking(tx, targetWorkId, sourceIds, dropped)
  await mergeQueues(tx, targetWorkId, sourceIds)
  await repointCandidates(tx, targetWorkId, sourceIds)
  await repointShelfPresets(tx, targetWorkId, sourceIds)

  await mergeWishRows(tx, targetWorkId, sourceIds)

  const people = await linkedPeople(tx, { workIds: sourceIds })
  await tx.delete(works).where(inArray(works.id, sourceIds))
  await pruneOrphanPeople(tx, people)
  await refreshSearchDocument(tx, targetWorkId)
  return dropped
}

async function displayNames(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const rows = await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, [...userIds]))
  return new Map(rows.map((r) => [r.id, r.name]))
}

/** A book hidden from someone stays hidden from them after a merge. */
async function mergeHidden(db: Db, targetWorkId: string, sourceIds: string[], dropped: string[]): Promise<void> {
  const [hidden, alreadyHidden] = await Promise.all([
    db.select().from(userHiddenWorks).where(inArray(userHiddenWorks.workId, sourceIds)),
    db.select({ userId: userHiddenWorks.userId }).from(userHiddenWorks).where(eq(userHiddenWorks.workId, targetWorkId)),
  ])
  const had = new Set(alreadyHidden.map((r) => r.userId))
  const fresh = new Map<string, (typeof hidden)[number]>()
  for (const row of hidden) if (!had.has(row.userId) && !fresh.has(row.userId)) fresh.set(row.userId, row)
  if (fresh.size === 0) return
  await db.insert(userHiddenWorks).values([...fresh.values()].map((h) => ({ userId: h.userId, workId: targetWorkId, hiddenBy: h.hiddenBy, createdAt: h.createdAt })))
  const names = await displayNames(db, [...fresh.keys()])
  for (const userId of fresh.keys()) dropped.push(`Now hidden from ${names.get(userId) ?? 'someone'}`)
}

/** Per person: the target's status, rating and review win, a source fills a gap; status then follows their sessions on the target. */
async function mergeTracking(db: Db, targetWorkId: string, sourceIds: string[], dropped: string[]): Promise<void> {
  const rows = await db.select().from(userWorks).where(inArray(userWorks.workId, [targetWorkId, ...sourceIds]))
  if (rows.length === 0) return
  const sessions = await db
    .select({ userId: readingSessions.userId, outcome: readingSessions.outcome })
    .from(readingSessions)
    .where(eq(readingSessions.workId, targetWorkId))
  const outcomes = new Map<string, SessionOutcome[]>()
  for (const s of sessions) outcomes.set(s.userId, [...(outcomes.get(s.userId) ?? []), s.outcome])
  const names = await displayNames(db, rows.map((r) => r.userId))

  for (const userId of new Set(rows.map((r) => r.userId))) {
    const mine = rows.filter((r) => r.userId === userId)
    const own = mine.find((r) => r.workId === targetWorkId)
    const fromSources = sourceIds.flatMap((id) => mine.filter((r) => r.workId === id))
    const [first, ...rest] = own ? [own, ...fromSources] : fromSources
    if (!first) continue
    const merged = { status: first.status, rating: first.rating, ratedAt: first.ratedAt, review: first.review }
    const name = names.get(userId) ?? 'Someone'
    for (const r of rest) {
      if (merged.status === 'none') merged.status = r.status
      if (r.rating !== null && merged.rating === null) {
        merged.rating = r.rating
        merged.ratedAt = r.ratedAt
      } else if (r.rating !== null && r.rating !== merged.rating) {
        dropped.push(`${name}’s rating ${r.rating} (kept ${merged.rating})`)
      }
      if (r.review !== null && merged.review === null) merged.review = r.review
      else if (r.review !== null && r.review !== merged.review) dropped.push(`${name}’s review (kept the one on the target)`)
    }
    // the same rule as deleteReadingSession: reading while any session is in progress, else read if any finished
    const mySessions = outcomes.get(userId) ?? []
    if (mySessions.length > 0) merged.status = statusAfterCompletion('abandoned', mySessions)
    await db
      .insert(userWorks)
      .values({ userId, workId: targetWorkId, ...merged })
      .onConflictDoUpdate({ target: [userWorks.userId, userWorks.workId], set: { ...merged, updatedAt: new Date() } })
  }
}

/** Per person: a queued target stays where it is; otherwise the best-placed source entry moves over, keeping its position. */
async function mergeQueues(db: Db, targetWorkId: string, sourceIds: string[]): Promise<void> {
  const entries = await db
    .select()
    .from(queueEntries)
    .where(inArray(queueEntries.workId, [targetWorkId, ...sourceIds]))
    .orderBy(asc(queueEntries.position), asc(queueEntries.addedAt))
  const queued = new Set(entries.filter((e) => e.workId === targetWorkId).map((e) => e.userId))
  const moving = new Map<string, (typeof entries)[number]>()
  for (const e of entries) if (!queued.has(e.userId) && !moving.has(e.userId)) moving.set(e.userId, e)
  if (moving.size === 0) return
  await db.insert(queueEntries).values([...moving.values()].map((e) => ({ userId: e.userId, workId: targetWorkId, position: e.position, addedAt: e.addedAt })))
}

/**
 * Pending proposals keep their stored candidates, so a candidate naming a source now names the target; duplicates
 * (same book and edition) keep the best score. Otherwise "Create books for all unmatched" would re-create the book.
 */
async function repointCandidates(db: Db, targetWorkId: string, sourceIds: string[]): Promise<void> {
  const mentionsSource = or(...sourceIds.map((id) => sql`${proposals.candidates} @> ${JSON.stringify([{ workId: id }])}::jsonb`))
  const pending = await db
    .select({ id: proposals.id, candidates: proposals.candidates })
    .from(proposals)
    .where(and(eq(proposals.status, 'pending'), mentionsSource))
  for (const p of pending) {
    const kept = new Map<string, MatchCandidate>()
    for (const c of p.candidates) {
      const next = sourceIds.includes(c.workId) ? { ...c, workId: targetWorkId } : c
      const key = `${next.workId}:${next.editionId ?? ''}`
      const best = kept.get(key)
      kept.set(key, best && best.score >= next.score ? best : next)
    }
    await db.update(proposals).set({ candidates: [...kept.values()] }).where(eq(proposals.id, p.id))
  }
}

/** A pending shelf proposal's "physical copy of X" follows X into the target, so the person's choice isn't lost. */
async function repointShelfPresets(db: Db, targetWorkId: string, sourceIds: string[]): Promise<void> {
  await db
    .update(proposals)
    .set({ payload: sql`jsonb_set(${proposals.payload}, '{photo,preset,workId}', ${JSON.stringify(targetWorkId)}::jsonb)` })
    .where(and(eq(proposals.status, 'pending'), inArray(sql`${proposals.payload} #>> '{photo,preset,workId}'`, sourceIds)))
}

/** Each person's wishes on the sources move to the target; two wishes by one person become one (#28, #53). */
async function mergeWishRows(db: Db, targetWorkId: string, sourceIds: string[]): Promise<void> {
  const sourceWishes = await db.select().from(wishes).where(inArray(wishes.workId, sourceIds)).orderBy(asc(wishes.createdAt), asc(wishes.id))
  for (const w of sourceWishes) {
    const [mine] = await db.select().from(wishes).where(and(eq(wishes.workId, targetWorkId), eq(wishes.userId, w.userId)))
    if (mine) {
      await db.update(wishes).set(mergeWishes(mine, w)).where(eq(wishes.id, mine.id))
      await db.delete(wishes).where(eq(wishes.id, w.id))
    } else {
      await db.update(wishes).set({ workId: targetWorkId }).where(eq(wishes.id, w.id))
    }
  }
}
