import { and, desc, eq, gt, inArray, isNull, lte, max, ne, or, sql } from 'drizzle-orm'
import {
  DomainError,
  clientTodayProblem,
  atVolumeEnd,
  bookFraction,
  bookHighest,
  markManual,
  nextVolumePresent,
  notFound,
  pastAbandonProblem,
  progressDateProblem,
  progressKindProblem,
  progressPastEndProblem,
  resolveDateRange,
  type AddProgressInput,
  type CurrentProgress,
  type DatePrecision,
  type DateRange,
  type EditionFormat,
  type EditionLength,
  type ProgressKind,
  type ProgressPointView,
  type SessionOutcome,
  type SessionProgressInfo,
  type UpdateProgressInput,
} from '@mylib/domain'
import type { Db } from '../client'
import { editions, readingProgress, readingSessions, works } from '../schema'
import { assertVisibleWork, type UserScope } from './scope'
import { rebuildDailyStats, type DateSpan } from './stats'
import { editionOfPoint, loadEditionContexts, type EditionContext } from './volume-context'

/** `now` is the server's clock, injectable so tests can pin the server's UTC date. */
export interface ProgressWriteOptions {
  now?: Date | undefined
}

interface LockedSession {
  id: string
  workId: string
  outcome: SessionOutcome
  /** an abandoned session's fraction (#7: a corrected point can't go past it) */
  fractionCompleted: number | null
  started: DateRange
  finished: DateRange | null
  /** the session's current edition (volume, #66): a new point is stored against it */
  editionId: string | null
  edition: { format: EditionFormat; pageCount: number | null; durationSec: number | null } | null
  /** the days this session's stats could cover before this change: they are rebuilt too, so none keep stale numbers */
  oldSpan: DateSpan
}

const later = (a: string, b: string) => (a > b ? a : b)

function check(problem: string | null): void {
  if (problem !== null) throw new DomainError('INVALID', problem)
}

/** Spec: the client's local "today" is the truth, but one more than two days from the server's UTC date is refused. */
function checkClientToday(today: string, now: Date): void {
  check(clientTodayProblem(today, now.toISOString().slice(0, 10)))
}

const NO_LENGTH: EditionLength = { pageCount: null, durationSec: null }

/**
 * #69: the volume a point is entered against must be an edition of the session's volume set: same work, format and
 * language as the session's edition, both with a volume. The session's own edition always qualifies. Read without a lock.
 */
async function chooseVolume(tx: Db, sessionEditionId: string | null, editionId: string): Promise<EditionContext | null> {
  if (sessionEditionId === null) throw new DomainError('INVALID', 'Pick a volume of this book')
  const contexts = await loadEditionContexts(tx, [sessionEditionId, editionId])
  const session = contexts.get(sessionEditionId)
  const chosen = contexts.get(editionId)
  if (editionId === sessionEditionId) return chosen ?? null
  const inSet =
    session?.ctx != null && chosen?.ctx != null && chosen.workId === session.workId && chosen.format === session.format && chosen.language === session.language
  if (!inSet) throw new DomainError('INVALID', 'Pick a volume of this book')
  return chosen
}

const editionOfContext = (e: EditionContext) => ({ format: e.format, ...e.length })

function finishedRange(on: string | null, precision: DatePrecision | null): DateRange | null {
  return on === null || precision === null ? null : resolveDateRange(on, precision)
}

/** The session's owner check without a lock: NOT_FOUND unless it is this user's, on a work they can see. */
async function ownSession(tx: Db, scope: UserScope, sessionId: string): Promise<{ workId: string; editionId: string | null }> {
  const [row] = await tx
    .select({ userId: readingSessions.userId, workId: readingSessions.workId, editionId: readingSessions.editionId })
    .from(readingSessions)
    .where(eq(readingSessions.id, sessionId))
  if (!row || row.userId !== scope.userId) throw notFound('Session')
  await assertVisibleWork(tx, scope, row.workId)
  return row
}

/**
 * The session row locked for update (so a point and a finish/abandon of the same session serialise), after checking
 * it is this user's and on a work they can see. Anything else is NOT_FOUND, so nothing about it leaks. The edition is
 * read without a lock: catalog writes lock an edition before its sessions, so locking it here would invert that order.
 */
async function lockOwnSession(tx: Db, scope: UserScope, sessionId: string): Promise<LockedSession> {
  const [row] = await tx
    .select({
      userId: readingSessions.userId,
      workId: readingSessions.workId,
      outcome: readingSessions.outcome,
      fractionCompleted: readingSessions.fractionCompleted,
      startedOn: readingSessions.startedOn,
      startedPrecision: readingSessions.startedPrecision,
      finishedOn: readingSessions.finishedOn,
      finishedPrecision: readingSessions.finishedPrecision,
      editionId: readingSessions.editionId,
    })
    .from(readingSessions)
    .where(eq(readingSessions.id, sessionId))
    .for('update')
  if (!row || row.userId !== scope.userId) throw notFound('Session')
  await assertVisibleWork(tx, scope, row.workId)
  const [edition] =
    row.editionId === null
      ? []
      : await tx
          .select({ format: editions.format, pageCount: editions.pageCount, durationSec: editions.durationSec })
          .from(editions)
          .where(eq(editions.id, row.editionId))
  const [last] = await tx
    .select({ on: max(readingProgress.occurredOn) })
    .from(readingProgress)
    .where(eq(readingProgress.sessionId, sessionId))
  const started = resolveDateRange(row.startedOn, row.startedPrecision)
  const finished = finishedRange(row.finishedOn, row.finishedPrecision)
  // a session's stats span runs from its start through its latest point or the end of its finish range; a read
  // without a usable point spreads over the union of its start and finish ranges, so the end of an imprecise start's
  // range (Dec 31 for a "year" start) is included too
  let to = later(started.to, last?.on ?? started.to)
  if (finished !== null) to = later(to, finished.to)
  return {
    id: sessionId,
    workId: row.workId,
    outcome: row.outcome,
    fractionCompleted: row.fractionCompleted,
    started,
    finished,
    editionId: row.editionId,
    edition: edition ?? null,
    oldSpan: { from: started.from, to },
  }
}

/**
 * Spec §2: the one-time "of how many pages / how long" answer becomes the chosen edition's length (the session's, or another volume of its set, #69), marked manual
 * and locked, only where that length is still missing (never overwriting a known one). A conditional UPDATE, run
 * before the session lock so this transaction takes edition → session like the catalog writes do; the provenance is
 * merged in SQL so a concurrent provenance change is not lost.
 */
async function saveMissingLength(tx: Db, sessionId: string, editionId: string, kind: ProgressKind, length: number, now: Date): Promise<void> {
  const field = kind === 'page' ? 'pageCount' : kind === 'seconds' ? 'durationSec' : null
  if (field === null) return
  const column = field === 'pageCount' ? editions.pageCount : editions.durationSec
  const provenance = sql`${editions.provenance} || ${JSON.stringify(markManual({}, [field], now))}::jsonb`
  await tx
    .update(editions)
    .set(field === 'pageCount' ? { pageCount: length, provenance } : { durationSec: length, provenance })
    .where(
      and(
        eq(editions.id, editionId),
        // a stored 0 counts as missing, like the domain's usable-length rule
        or(isNull(column), lte(column, 0)),
        // still this session's edition, or another volume of its set
        sql`exists (
          select 1 from reading_session rs join edition se on se.id = rs.edition_id
          where rs.id = ${sessionId}
            and (se.id = ${editions.id}
              or (se.volume is not null and ${editions.volume} is not null and se.work_id = ${editions.workId}
                and se.format = ${editions.format} and se.language is not distinct from ${editions.language}))
        )`,
      ),
    )
}

export async function addProgressPoint(db: Db, scope: UserScope, input: AddProgressInput, options: ProgressWriteOptions = {}): Promise<string> {
  const now = options.now ?? new Date()
  return db.transaction(async (tx) => {
    checkClientToday(input.today, now)
    if (input.editionLength !== undefined) {
      const own = await ownSession(tx, scope, input.sessionId)
      if (input.editionId !== undefined) await chooseVolume(tx, own.editionId, input.editionId)
      const target = input.editionId ?? own.editionId
      if (target !== null) await saveMissingLength(tx, input.sessionId, target, input.kind, input.editionLength, now)
    }
    const s = await lockOwnSession(tx, scope, input.sessionId)
    if (s.outcome !== 'in_progress') throw new DomainError('CONFLICT', 'This read has already ended — refresh to see the latest.')
    // a chosen volume (#69) is read again under the lock: the session may have moved
    const chosen = input.editionId === undefined ? null : await chooseVolume(tx, s.editionId, input.editionId)
    const edition = chosen === null ? s.edition : editionOfContext(chosen)
    check(progressKindProblem(input.kind, edition?.format ?? null))
    // read after saveMissingLength, so a one-time length answer counts; a refusal rolls that answer back too
    check(progressPastEndProblem(input.kind, input.value, edition ?? NO_LENGTH))
    const on = input.on ?? input.today
    check(progressDateProblem(on, input.today, s.started, null))

    // one point per session, volume and day: the last entry wins (the session lock serialises two adds for the same day)
    const [row] = await tx
      .insert(readingProgress)
      .values({ sessionId: s.id, occurredOn: on, kind: input.kind, value: input.value, editionId: input.editionId ?? s.editionId })
      .onConflictDoUpdate({
        target: [readingProgress.sessionId, readingProgress.editionId, readingProgress.occurredOn],
        set: { kind: input.kind, value: input.value, createdAt: sql`now()` },
      })
      .returning({ id: readingProgress.id })
    if (!row) throw new Error('progress insert failed')
    // the old span too: replacing the latest point with one that has no fraction shrinks the session's span
    await rebuildDailyStats(tx, scope, { workIds: [s.workId], include: s.oldSpan })
    return row.id
  })
}

const presentIds = (list: readonly (string | null)[]): string[] => list.filter((id) => id !== null)

/**
 * #7: a session's book high-water mark, read in the caller's transaction (under its session lock). Each point counts
 * in its own edition (volume, #66), or the session's when the point's is gone. Editions are read without a lock.
 */
export async function sessionHighWater(tx: Db, sessionId: string): Promise<number | null> {
  const [session] = await tx.select({ editionId: readingSessions.editionId }).from(readingSessions).where(eq(readingSessions.id, sessionId))
  const points = await tx
    .select({ kind: readingProgress.kind, value: readingProgress.value, editionId: readingProgress.editionId })
    .from(readingProgress)
    .where(eq(readingProgress.sessionId, sessionId))
  const sessionEditionId = session?.editionId ?? null
  const contexts = await loadEditionContexts(tx, presentIds([sessionEditionId, ...points.map((p) => p.editionId)]))
  return bookHighest(
    points.flatMap((p) => {
      const e = editionOfPoint(p.editionId, sessionEditionId, contexts)
      return e === null ? [] : [{ kind: p.kind, value: p.value, length: e?.length ?? NO_LENGTH, ctx: e?.ctx ?? null }]
    }),
  )
}

async function sessionOfPoint(tx: Db, pointId: string): Promise<string> {
  const [point] = await tx.select({ sessionId: readingProgress.sessionId }).from(readingProgress).where(eq(readingProgress.id, pointId))
  if (!point) throw notFound('Progress update')
  return point.sessionId
}

export async function updateProgressPoint(db: Db, scope: UserScope, input: UpdateProgressInput, options: ProgressWriteOptions = {}): Promise<void> {
  const now = options.now ?? new Date()
  await db.transaction(async (tx) => {
    checkClientToday(input.today, now)
    const s = await lockOwnSession(tx, scope, await sessionOfPoint(tx, input.pointId))
    // read again under the session lock: a concurrent change may have moved it
    const [point] = await tx
      .select({ on: readingProgress.occurredOn, kind: readingProgress.kind, editionId: readingProgress.editionId })
      .from(readingProgress)
      .where(and(eq(readingProgress.id, input.pointId), eq(readingProgress.sessionId, s.id)))
    if (!point) throw notFound('Progress update')
    // an unchanged kind is not re-checked: the edition it was entered against may since have changed or gone
    if (input.kind !== point.kind) check(progressKindProblem(input.kind, s.edition?.format ?? null))
    // the point stays in its own volume unless another is chosen (#66, #69): its length bounds it, and its fraction is the share of the book there
    if (input.editionId !== undefined) await chooseVolume(tx, s.editionId, input.editionId)
    const editionId = input.editionId ?? point.editionId
    const contexts = await loadEditionContexts(tx, presentIds([editionId, s.editionId]))
    const own = editionOfPoint(editionId, s.editionId, contexts)
    // a point whose volume can't be known has no length to check against
    check(progressPastEndProblem(input.kind, input.value, own === null ? NO_LENGTH : (own?.length ?? s.edition ?? NO_LENGTH)))
    if (s.outcome === 'abandoned' && s.fractionCompleted !== null && own !== null) {
      check(pastAbandonProblem(bookFraction(input.kind, input.value, own?.length ?? NO_LENGTH, own?.ctx ?? null), s.fractionCompleted))
    }
    check(progressDateProblem(input.on, input.today, s.started, s.finished))
    if (input.on !== point.on || editionId !== point.editionId) {
      const [clash] = await tx
        .select({ id: readingProgress.id })
        .from(readingProgress)
        .where(
          and(
            eq(readingProgress.sessionId, s.id),
            ne(readingProgress.id, input.pointId),
            eq(readingProgress.occurredOn, input.on),
            sql`${readingProgress.editionId} is not distinct from ${editionId}`,
          ),
        )
      if (clash) throw new DomainError('CONFLICT', 'There is already an update on that day — edit that one instead')
    }
    const updated = await tx
      .update(readingProgress)
      .set({ occurredOn: input.on, kind: input.kind, value: input.value, editionId })
      .where(and(eq(readingProgress.id, input.pointId), eq(readingProgress.sessionId, s.id)))
      .returning({ id: readingProgress.id })
    if (updated.length === 0) throw notFound('Progress update')
    await rebuildDailyStats(tx, scope, { workIds: [s.workId], include: s.oldSpan })
  })
}

export async function removeProgressPoint(db: Db, scope: UserScope, pointId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const s = await lockOwnSession(tx, scope, await sessionOfPoint(tx, pointId))
    const removed = await tx
      .delete(readingProgress)
      .where(and(eq(readingProgress.id, pointId), eq(readingProgress.sessionId, s.id)))
      .returning({ id: readingProgress.id })
    if (removed.length === 0) throw notFound('Progress update')
    await rebuildDailyStats(tx, scope, { workIds: [s.workId], include: s.oldSpan })
  })
}

/** Points of one day: the later volume first, a point without a volume last, then the newest entry. */
const newestFirst = [
  desc(readingProgress.occurredOn),
  sql`(select ${editions.volume} from ${editions} where ${editions.id} = ${readingProgress.editionId}) desc nulls last`,
  desc(readingProgress.createdAt),
]

const pointColumns = {
  id: readingProgress.id,
  sessionId: readingProgress.sessionId,
  on: readingProgress.occurredOn,
  kind: readingProgress.kind,
  value: readingProgress.value,
  editionId: readingProgress.editionId,
}

type PointRow = { id: string; sessionId: string; on: string; kind: ProgressKind; value: number; editionId: string | null }

/** `e`: the point's edition per `editionOfPoint`; null (volume unknown) gives no volume and no fraction. */
function toView(p: PointRow, e: EditionContext | null | undefined): ProgressPointView {
  if (e === null) return { id: p.id, sessionId: p.sessionId, on: p.on, kind: p.kind, value: p.value, editionId: p.editionId, volume: null, fraction: null }
  return {
    id: p.id,
    sessionId: p.sessionId,
    on: p.on,
    kind: p.kind,
    value: p.value,
    editionId: p.editionId,
    volume: e?.ctx?.volume ?? null,
    fraction: bookFraction(p.kind, p.value, e?.length ?? NO_LENGTH, e?.ctx ?? null),
  }
}

/** A session's points, newest day first. */
export async function listProgressPoints(db: Db, scope: UserScope, sessionId: string): Promise<ProgressPointView[]> {
  const [s] = await db
    .select({ userId: readingSessions.userId, workId: readingSessions.workId, editionId: readingSessions.editionId })
    .from(readingSessions)
    .where(eq(readingSessions.id, sessionId))
  if (!s || s.userId !== scope.userId) throw notFound('Session')
  await assertVisibleWork(db, scope, s.workId)
  const rows = await db.select(pointColumns).from(readingProgress).where(eq(readingProgress.sessionId, sessionId)).orderBy(...newestFirst)
  const contexts = await loadEditionContexts(db, presentIds([s.editionId, ...rows.map((r) => r.editionId)]))
  return rows.map((r) => toView(r, editionOfPoint(r.editionId, s.editionId, contexts)))
}

export interface SessionEditionRow {
  id: string
  editionId: string | null
  editionFormat: EditionFormat | null
  editionPageCount: number | null
  editionDurationSec: number | null
}

/** Progress info for sessions the caller has already scope-filtered (listInProgressSessions, listSessionsForWork). */
export async function progressInfoFor(db: Db, sessions: readonly SessionEditionRow[]): Promise<Map<string, SessionProgressInfo>> {
  const info = new Map<string, SessionProgressInfo>()
  if (sessions.length === 0) return info
  const ids = sessions.map((s) => s.id)
  // every point, for the count and the high-water mark (#7); the newest first, so each session's first is its latest
  const points = await db
    .select(pointColumns)
    .from(readingProgress)
    .where(inArray(readingProgress.sessionId, ids))
    .orderBy(readingProgress.sessionId, ...newestFirst)
  const bySession = new Map<string, PointRow[]>()
  for (const p of points) {
    const own = bySession.get(p.sessionId)
    if (own === undefined) bySession.set(p.sessionId, [p])
    else own.push(p)
  }
  const contexts = await loadEditionContexts(db, presentIds([...sessions.map((s) => s.editionId), ...points.map((p) => p.editionId)]))
  for (const s of sessions) {
    const length = { pageCount: s.editionPageCount, durationSec: s.editionDurationSec }
    const sessionEdition = s.editionId === null ? undefined : contexts.get(s.editionId)
    const editionOf = (p: PointRow) => editionOfPoint(p.editionId, s.editionId, contexts)
    const own = bySession.get(s.id) ?? []
    const point = own[0]
    const ctx = sessionEdition?.ctx ?? null
    // waiting (#66): on volume k < N, no volume k+1 in the catalog, and the latest point (in this volume) is its end
    const waiting =
      ctx !== null && point !== undefined && ctx.volume < ctx.size && !nextVolumePresent(ctx) && point.editionId === s.editionId && atVolumeEnd(point.kind, point.value, length)
    info.set(s.id, {
      editionFormat: s.editionFormat,
      ...length,
      latest: point === undefined ? null : toView(point, editionOf(point)),
      pointCount: own.length,
      highest: bookHighest(
        own.flatMap((p) => {
          const e = editionOf(p)
          return e === null ? [] : [{ kind: p.kind, value: p.value, length: e?.length ?? NO_LENGTH, ctx: e?.ctx ?? null }]
        }),
      ),
      volume: ctx === null ? null : { ...ctx, waiting },
    })
  }
  return info
}

/**
 * Home "Currently reading": per work, the newest point that has a fraction among this user's in-progress sessions
 * on visible works. A newer point without a fraction (its edition has no length) is skipped, not a gap.
 */
export async function listCurrentProgress(db: Db, scope: UserScope): Promise<CurrentProgress[]> {
  // the point's own edition (volume, #66), else the session's current one
  const pointEdition = sql<string | null>`coalesce(${readingProgress.editionId}, ${readingSessions.editionId})`
  // the SQL form of progressFraction's "has a fraction": a percent, or a page / time whose edition length is positive
  const hasFraction = or(
    eq(readingProgress.kind, 'percent'),
    and(eq(readingProgress.kind, 'page'), gt(editions.pageCount, 0)),
    and(eq(readingProgress.kind, 'seconds'), gt(editions.durationSec, 0)),
  )
  // every point that may have a fraction, newest first per session: a point whose volume can't be known (see
  // editionOfPoint) is skipped in code, so the session falls back to its next newest
  const candidates = await db
    .select({
      ...pointColumns,
      workId: readingSessions.workId,
      sessionEditionId: readingSessions.editionId,
      pageCount: editions.pageCount,
      durationSec: editions.durationSec,
    })
    .from(readingProgress)
    .innerJoin(readingSessions, eq(readingSessions.id, readingProgress.sessionId))
    .innerJoin(works, eq(works.id, readingSessions.workId))
    .leftJoin(editions, sql`${editions.id} = ${pointEdition}`)
    .where(and(eq(readingSessions.userId, scope.userId), eq(readingSessions.outcome, 'in_progress'), scope.visible, hasFraction))
    .orderBy(readingProgress.sessionId, ...newestFirst)
  const contexts = await loadEditionContexts(db, presentIds(candidates.flatMap((r) => [r.editionId, r.sessionEditionId])))
  const rows: { sessionId: string; workId: string; on: string; fraction: number }[] = []
  const seen = new Set<string>()
  for (const r of candidates) {
    if (seen.has(r.sessionId)) continue
    const e = editionOfPoint(r.editionId, r.sessionEditionId, contexts)
    if (e === null) continue
    const fraction = bookFraction(r.kind, r.value, e?.length ?? r, e?.ctx ?? null)
    if (fraction === null) continue
    seen.add(r.sessionId)
    rows.push({ sessionId: r.sessionId, workId: r.workId, on: r.on, fraction })
  }
  // a work read and listened to at once has two sessions: the newer point wins (ties: the lower session id)
  rows.sort((a, b) => (a.on !== b.on ? (a.on > b.on ? -1 : 1) : a.sessionId < b.sessionId ? -1 : 1))
  const byWork = new Map<string, CurrentProgress>()
  for (const r of rows) {
    if (byWork.has(r.workId)) continue
    byWork.set(r.workId, { workId: r.workId, sessionId: r.sessionId, on: r.on, fraction: r.fraction })
  }
  return [...byWork.values()]
}
