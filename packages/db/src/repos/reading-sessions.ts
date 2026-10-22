import { and, asc, desc, eq, gte, inArray, isNull, max, ne, sql } from 'drizzle-orm'
import {
  DomainError,
  abandonFractionProblem,
  deriveIsReread,
  editionFormatsForMode,
  futureDateProblem,
  isRereadOfPastRead,
  markedReadDates,
  notFound,
  progressDateProblem,
  resolveDateRange,
  resolveFractionCompleted,
  statusAfterCompletion,
  type CompleteSessionInput,
  type DatePrecision,
  type EditionFormat,
  type MarkFinishedInput,
  type NextVolumeInput,
  type ReadingStatus,
  type SessionDates,
  type SessionMode,
  type SessionOutcome,
  type SessionProgressInfo,
  type StartSessionInput,
} from '@mylib/domain'
import type { Db } from '../client'
import { checkinMarks, checkinSnoozes, checkinStates, editions, queueEntries, readingProgress, readingSessions, works } from '../schema'
import { progressInfoFor, sessionHighWater } from './progress'
import { assertVisibleWork, type UserScope } from './scope'
import { rebuildDailyStats } from './stats'
import { shownTitleField } from './titles'
import { loadEditionContexts } from './volume-context'
import { setRating, setStatus } from './tracking'

const sessionColumns = (scope: UserScope) => ({
  id: readingSessions.id,
  workId: readingSessions.workId,
  workTitle: shownTitleField(works.id, scope.languages, 'title'),
  editionId: readingSessions.editionId,
  mode: readingSessions.mode,
  startedOn: readingSessions.startedOn,
  startedPrecision: readingSessions.startedPrecision,
  finishedOn: readingSessions.finishedOn,
  finishedPrecision: readingSessions.finishedPrecision,
  outcome: readingSessions.outcome,
  fractionCompleted: readingSessions.fractionCompleted,
  isReread: readingSessions.isReread,
  createdAt: readingSessions.createdAt,
  editionFormat: editions.format,
  editionPageCount: editions.pageCount,
  editionDurationSec: editions.durationSec,
})

export interface SessionView {
  id: string
  workId: string
  workTitle: string
  editionId: string | null
  mode: SessionMode
  startedOn: string
  startedPrecision: DatePrecision
  finishedOn: string | null
  finishedPrecision: DatePrecision | null
  outcome: SessionOutcome
  fractionCompleted: number | null
  isReread: boolean
  createdAt: Date
  progress: SessionProgressInfo
}

type SessionRow = Omit<SessionView, 'progress'> & {
  editionFormat: EditionFormat | null
  editionPageCount: number | null
  editionDurationSec: number | null
}

const NO_PROGRESS: SessionProgressInfo = { editionFormat: null, pageCount: null, durationSec: null, latest: null, pointCount: 0, highest: null, volume: null }

/** Attaches progress info and drops the edition columns it was built from. */
async function withProgress(db: Db, rows: readonly SessionRow[]): Promise<SessionView[]> {
  const info = await progressInfoFor(db, rows)
  return rows.map(
    (r): SessionView => ({
      id: r.id,
      workId: r.workId,
      workTitle: r.workTitle,
      editionId: r.editionId,
      mode: r.mode,
      startedOn: r.startedOn,
      startedPrecision: r.startedPrecision,
      finishedOn: r.finishedOn,
      finishedPrecision: r.finishedPrecision,
      outcome: r.outcome,
      fractionCompleted: r.fractionCompleted,
      isReread: r.isReread,
      createdAt: r.createdAt,
      progress: info.get(r.id) ?? NO_PROGRESS,
    }),
  )
}

/**
 * The edition a new session of `mode` uses: the picked one (NOT_FOUND unless it is an edition of this work), else the
 * only edition of the matching format(s), if there is exactly one, or volume 1 when they are all one volume set (#66).
 */
async function sessionEdition(tx: Db, workId: string, mode: SessionMode, picked: string | null): Promise<string | null> {
  if (picked !== null) {
    const [edition] = await tx
      .select({ id: editions.id })
      .from(editions)
      .where(and(eq(editions.id, picked), eq(editions.workId, workId)))
    if (!edition) throw notFound('Edition')
    return picked
  }
  const matching = await tx
    .select({ id: editions.id, format: editions.format, language: editions.language, volume: editions.volume, inPossession: editions.inPossession })
    .from(editions)
    .where(and(eq(editions.workId, workId), inArray(editions.format, editionFormatsForMode(mode))))
  if (matching.length === 1) return matching[0]?.id ?? null
  // several editions that are all volumes of one set: the book starts on volume 1 (a copy in possession first)
  const [head] = matching
  if (head && matching.every((e) => e.volume !== null && e.format === head.format && e.language === head.language)) {
    const byVolume = [...matching].sort(
      (a, b) => (a.volume ?? 0) - (b.volume ?? 0) || Number(b.inPossession) - Number(a.inPossession) || (a.id < b.id ? -1 : 1),
    )
    return byVolume[0]?.id ?? null
  }
  return null
}

export interface PastRead {
  workId: string
  editionId: string | null
  mode: SessionMode
  /** pastReadDates (CSV) or markedReadDates ("Mark as read") */
  dates: SessionDates
  isReread: boolean
}

/**
 * Records a finished read after the fact — the CSV import and "Mark as read": one finished session with the given
 * dates, then the status a finish implies given the user's other sessions of the work. The caller holds the user:work
 * lock, has checked the work is visible, and rebuilds the stats.
 */
export async function insertPastRead(tx: Db, scope: UserScope, read: PastRead): Promise<string> {
  const others = await tx
    .select({ outcome: readingSessions.outcome })
    .from(readingSessions)
    .where(and(eq(readingSessions.userId, scope.userId), eq(readingSessions.workId, read.workId)))
  const [row] = await tx
    .insert(readingSessions)
    .values({
      userId: scope.userId,
      workId: read.workId,
      editionId: read.editionId,
      mode: read.mode,
      ...read.dates,
      outcome: 'finished',
      fractionCompleted: resolveFractionCompleted('finished', null),
      isReread: read.isReread,
    })
    .returning({ id: readingSessions.id })
  if (!row) throw new Error('session insert failed')
  await setStatus(tx, scope, read.workId, statusAfterCompletion('finished', others.map((o) => o.outcome)))
  return row.id
}

export interface SessionWriteOptions {
  /** the server's clock, for the future-date check (tests pin it) */
  now?: Date | undefined
}

/** INVALID when a start or finish range begins in the future (futureDateProblem; an unknown date is exempt). */
function checkNotFuture(on: string, precision: DatePrecision, now: Date): void {
  const problem = futureDateProblem(on, precision, now.toISOString().slice(0, 10))
  if (problem !== null) throw new DomainError('INVALID', problem)
}

/** An identical "Mark as read" this soon after the first is a double submit or a retry, not a second read. */
const MARK_REPEAT_WINDOW_MS = 5 * 60_000

/**
 * "Mark as read / listened": a finished read the user remembers only roughly (a day, a month, a year) or not at all.
 * Same lock key as startSession. An unknown date counts as read but never in a dated stat (sessionStatsRange), so the
 * range rebuild below changes no day for it. An exact day gets an unknown start (markedReadDates). The optional rating
 * saves in the same transaction. An identical submit within a few minutes returns the session it already made.
 */
export async function markFinished(
  db: Db,
  scope: UserScope,
  input: Omit<MarkFinishedInput, 'rating'> & { rating?: number | null | undefined },
  options: SessionWriteOptions = {},
): Promise<string> {
  const now = options.now ?? new Date()
  checkNotFuture(input.finishedOn, input.finishedPrecision, now)
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.userId} || ':' || ${input.workId}))`)
    await assertVisibleWork(tx, scope, input.workId)
    const editionId = await sessionEdition(tx, input.workId, input.mode, input.editionId)
    const dates = markedReadDates(input.finishedOn, input.finishedPrecision)
    const [repeat] = await tx
      .select({ id: readingSessions.id })
      .from(readingSessions)
      .where(
        and(
          eq(readingSessions.userId, scope.userId),
          eq(readingSessions.workId, input.workId),
          eq(readingSessions.mode, input.mode),
          editionId === null ? isNull(readingSessions.editionId) : eq(readingSessions.editionId, editionId),
          eq(readingSessions.outcome, 'finished'),
          eq(readingSessions.finishedOn, dates.finishedOn),
          eq(readingSessions.finishedPrecision, dates.finishedPrecision),
          gte(readingSessions.createdAt, new Date(now.getTime() - MARK_REPEAT_WINDOW_MS)),
        ),
      )
      .limit(1)
    const prior = await tx
      .select({ outcome: readingSessions.outcome, finishedOn: readingSessions.finishedOn, finishedPrecision: readingSessions.finishedPrecision })
      .from(readingSessions)
      .where(and(eq(readingSessions.userId, scope.userId), eq(readingSessions.workId, input.workId)))
    const id =
      repeat?.id ??
      (await insertPastRead(tx, scope, {
        workId: input.workId,
        editionId,
        mode: input.mode,
        dates,
        isReread: isRereadOfPastRead(prior, dates.finishedOn, dates.finishedPrecision),
      }))
    if (input.rating !== undefined && input.rating !== null) await setRating(tx, scope, input.workId, input.rating)
    if (repeat === undefined) await rebuildDailyStats(tx, scope, { workIds: [input.workId] })
    return id
  })
}

/**
 * #152 The book page's status menu. Read also records a finished read with an unknown date (as "Mark as read" does),
 * unless the person already has one for this work: listened for a book with only audiobook editions, read otherwise.
 * The status stays the one picked, even with a read still open.
 */
export async function setStatusFromMenu(db: Db, scope: UserScope, workId: string, status: ReadingStatus, options: SessionWriteOptions = {}): Promise<void> {
  if (status !== 'read') return setStatus(db, scope, workId, status)
  const today = (options.now ?? new Date()).toISOString().slice(0, 10)
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.userId} || ':' || ${workId}))`)
    await assertVisibleWork(tx, scope, workId)
    const [finished] = await tx
      .select({ id: readingSessions.id })
      .from(readingSessions)
      .where(and(eq(readingSessions.userId, scope.userId), eq(readingSessions.workId, workId), eq(readingSessions.outcome, 'finished')))
      .limit(1)
    if (finished === undefined) {
      const formats = await tx.select({ format: editions.format }).from(editions).where(eq(editions.workId, workId))
      const mode: SessionMode = formats.length > 0 && formats.every((e) => editionFormatsForMode('listen').includes(e.format)) ? 'listen' : 'read'
      const editionId = await sessionEdition(tx, workId, mode, null)
      await insertPastRead(tx, scope, { workId, editionId, mode, dates: markedReadDates(today, 'unknown'), isReread: false })
      await rebuildDailyStats(tx, scope, { workIds: [workId] })
    }
    await setStatus(tx, scope, workId, 'read')
  })
}

export async function startSession(db: Db, scope: UserScope, input: StartSessionInput, options: SessionWriteOptions = {}): Promise<string> {
  checkNotFuture(input.startedOn, input.startedPrecision, options.now ?? new Date())
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.userId} || ':' || ${input.workId}))`)
    await assertVisibleWork(tx, scope, input.workId)
    const editionId = await sessionEdition(tx, input.workId, input.mode, input.editionId)
    const [existing] = await tx
      .select({ id: readingSessions.id })
      .from(readingSessions)
      .where(
        and(
          eq(readingSessions.userId, scope.userId),
          eq(readingSessions.workId, input.workId),
          eq(readingSessions.mode, input.mode),
          eq(readingSessions.outcome, 'in_progress'),
        ),
      )
    if (existing) throw new DomainError('CONFLICT', `Already ${input.mode === 'listen' ? 'listening to' : 'reading'} this book`)

    const priorOutcomes = await tx
      .select({ outcome: readingSessions.outcome })
      .from(readingSessions)
      .where(and(eq(readingSessions.userId, scope.userId), eq(readingSessions.workId, input.workId)))

    const [row] = await tx
      .insert(readingSessions)
      .values({
        userId: scope.userId,
        workId: input.workId,
        editionId,
        mode: input.mode,
        startedOn: input.startedOn,
        startedPrecision: input.startedPrecision,
        isReread: deriveIsReread(priorOutcomes.map((o) => o.outcome)),
      })
      .returning({ id: readingSessions.id })
    if (!row) throw new Error('session insert failed')
    await setStatus(tx, scope, input.workId, 'reading')
    return row.id
  })
}

export type StartedReading = { sessionId: string; queuePosition: number | null }

/**
 * #85: starting a book takes it off Up next, in the same transaction as the start; `queuePosition` is where it was
 * (null when it was not in Up next), so an Undo can put it back with restoreToQueue.
 */
export async function startReading(db: Db, scope: UserScope, input: StartSessionInput, options: SessionWriteOptions = {}): Promise<StartedReading> {
  return db.transaction(async (tx) => {
    const sessionId = await startSession(tx, scope, input, options)
    const [removed] = await tx
      .delete(queueEntries)
      .where(and(eq(queueEntries.userId, scope.userId), eq(queueEntries.workId, input.workId)))
      .returning({ position: queueEntries.position })
    return { sessionId, queuePosition: removed?.position ?? null }
  })
}

export async function completeSession(
  db: Db,
  scope: UserScope,
  sessionId: string,
  input: CompleteSessionInput,
  options: SessionWriteOptions = {},
): Promise<void> {
  checkNotFuture(input.finishedOn, input.finishedPrecision, options.now ?? new Date())
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        userId: readingSessions.userId,
        workId: readingSessions.workId,
        outcome: readingSessions.outcome,
        startedOn: readingSessions.startedOn,
        startedPrecision: readingSessions.startedPrecision,
        editionId: readingSessions.editionId,
      })
      .from(readingSessions)
      .where(eq(readingSessions.id, sessionId))
      .for('update')
    if (!row || row.userId !== scope.userId) throw notFound('Session')
    await assertVisibleWork(tx, scope, row.workId)
    if (row.outcome !== 'in_progress') throw new DomainError('CONFLICT', 'This session was already completed')
    const started = resolveDateRange(row.startedOn, row.startedPrecision)
    const finished = resolveDateRange(input.finishedOn, input.finishedPrecision)
    if (finished.to < started.from) throw new DomainError('INVALID', 'The finish date is before the start date')
    // under the session lock, so no point can be added after this check and before the finish is saved
    const [lastPoint] = await tx
      .select({ on: max(readingProgress.occurredOn) })
      .from(readingProgress)
      .where(eq(readingProgress.sessionId, sessionId))
    const lastOn = lastPoint?.on ?? null
    if (lastOn !== null && finished.to < lastOn) {
      throw new DomainError('INVALID', 'The finish date is before your latest progress update')
    }

    // #7 (option C): an abandon never says less than the session's highest point, so the session and the stats agree.
    // The edition is read without a lock: catalog writes lock an edition before its sessions (see lockOwnSession).
    let highest: number | null = null
    if (input.outcome === 'abandoned') {
      highest = await sessionHighWater(tx, sessionId)
      if (input.fractionCompleted !== null) {
        const problem = abandonFractionProblem(input.fractionCompleted, highest)
        if (problem !== null) throw new DomainError('INVALID', problem)
      }
    }
    const fractionCompleted = resolveFractionCompleted(input.outcome, input.fractionCompleted, highest)
    await tx
      .update(readingSessions)
      .set({
        outcome: input.outcome,
        finishedOn: input.finishedOn,
        finishedPrecision: input.finishedPrecision,
        fractionCompleted,
      })
      .where(eq(readingSessions.id, sessionId))
    await tx.delete(checkinSnoozes).where(eq(checkinSnoozes.sessionId, sessionId))
    const others = await tx
      .select({ outcome: readingSessions.outcome })
      .from(readingSessions)
      .where(
        and(
          eq(readingSessions.userId, scope.userId),
          eq(readingSessions.workId, row.workId),
          ne(readingSessions.id, sessionId),
        ),
      )
    await setStatus(tx, scope, row.workId, statusAfterCompletion(input.outcome, others.map((o) => o.outcome)))
    await rebuildDailyStats(tx, scope)
  })
}

/**
 * "Finished this volume" (#66): ends the session's current volume with a point at its end, then moves the session to
 * the next volume of the set. Without that volume in the catalog the point is still saved and the session waits on
 * this one (check-in leaves it alone). Locks the session row only; editions are read, not locked.
 */
export async function nextVolume(
  db: Db,
  scope: UserScope,
  input: NextVolumeInput,
  options: SessionWriteOptions = {},
): Promise<{ moved: true; volume: number } | { moved: false; waitingFor: number }> {
  const on = input.on ?? input.today
  checkNotFuture(input.today, 'day', options.now ?? new Date())
  checkNotFuture(on, 'day', options.now ?? new Date())
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        userId: readingSessions.userId,
        workId: readingSessions.workId,
        outcome: readingSessions.outcome,
        startedOn: readingSessions.startedOn,
        startedPrecision: readingSessions.startedPrecision,
        editionId: readingSessions.editionId,
      })
      .from(readingSessions)
      .where(eq(readingSessions.id, input.sessionId))
      .for('update')
    if (!row || row.userId !== scope.userId) throw notFound('Session')
    await assertVisibleWork(tx, scope, row.workId)
    if (row.outcome !== 'in_progress') throw new DomainError('CONFLICT', 'This session was already completed')
    if (row.editionId !== input.editionId) throw new DomainError('CONFLICT', "You've already moved on from this volume")
    const e = (await loadEditionContexts(tx, [input.editionId])).get(input.editionId)
    if (!e?.ctx || e.ctx.volume >= e.ctx.size) throw new DomainError('INVALID', 'This is the last volume — finish the book instead')
    const problem = progressDateProblem(on, input.today, resolveDateRange(row.startedOn, row.startedPrecision), null)
    if (problem !== null) throw new DomainError('INVALID', problem)
    const [latest] = await tx
      .select({ on: max(readingProgress.occurredOn) })
      .from(readingProgress)
      .where(and(eq(readingProgress.sessionId, input.sessionId), eq(readingProgress.editionId, input.editionId)))
    if (latest?.on != null && latest.on > on) throw new DomainError('INVALID', 'You have an update on this volume after that day')

    const pages = e.length.pageCount
    const seconds = e.length.durationSec
    const end =
      e.format !== 'audiobook' && pages !== null && pages > 0
        ? { kind: 'page' as const, value: pages }
        : e.format === 'audiobook' && seconds !== null && seconds > 0
          ? { kind: 'seconds' as const, value: seconds }
          : { kind: 'percent' as const, value: 100 }
    // one point per session, volume and day: the end of the volume replaces an earlier entry of that day on that volume
    await tx
      .insert(readingProgress)
      .values({ sessionId: input.sessionId, occurredOn: on, ...end, editionId: input.editionId })
      .onConflictDoUpdate({
        target: [readingProgress.sessionId, readingProgress.editionId, readingProgress.occurredOn],
        set: { ...end, createdAt: sql`now()` },
      })

    const [current] = await tx.select({ format: editions.format, language: editions.language }).from(editions).where(eq(editions.id, input.editionId))
    const volume = e.ctx.volume + 1
    const [next] = current
      ? await tx
          .select({ id: editions.id })
          .from(editions)
          .where(
            and(
              eq(editions.workId, row.workId),
              eq(editions.format, current.format),
              sql`${editions.language} is not distinct from ${current.language}`,
              eq(editions.volume, volume),
            ),
          )
          .orderBy(desc(editions.inPossession), asc(editions.id))
          .limit(1)
      : []
    if (next) await tx.update(readingSessions).set({ editionId: next.id }).where(eq(readingSessions.id, input.sessionId))
    // the session's span only grows here
    await rebuildDailyStats(tx, scope, { workIds: [row.workId] })
    return next ? { moved: true as const, volume } : { moved: false as const, waitingFor: volume }
  })
}

/**
 * Removes one of the user's sessions (a mistaken entry). Snoozes go with it (FK cascade). The work's status then
 * follows the latest remaining session; with none left, the status is left as it is. Stats rebuild on the next read.
 */
export async function deleteReadingSession(db: Db, scope: UserScope, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ userId: readingSessions.userId, workId: readingSessions.workId })
      .from(readingSessions)
      .where(eq(readingSessions.id, sessionId))
      .for('update')
    if (!row || row.userId !== scope.userId) throw notFound('Session')
    // same key as startSession, so a start and a delete on one book can't interleave
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.userId} || ':' || ${row.workId}))`)
    await assertVisibleWork(tx, scope, row.workId)
    await tx.delete(readingSessions).where(eq(readingSessions.id, sessionId))
    const remaining = await tx
      .select({ outcome: readingSessions.outcome })
      .from(readingSessions)
      .where(and(eq(readingSessions.userId, scope.userId), eq(readingSessions.workId, row.workId)))
    if (remaining.length === 0) return
    const outcomes = remaining.map((r) => r.outcome)
    // reading while any session is in progress; otherwise read if any finished; otherwise abandoned
    const status = outcomes.includes('in_progress') ? 'reading' : statusAfterCompletion('abandoned', outcomes)
    await setStatus(tx, scope, row.workId, status)
  })
}

/**
 * `today` is the client's local date — a snooze "until X" hides the session through X. Deliberately
 * no filter on `startedOn`: spec §7 shows check-in a card "per in-progress session", including one
 * started today.
 */
export async function listInProgressSessions(db: Db, scope: UserScope, today: string): Promise<SessionView[]> {
  const rows = await db
    .select(sessionColumns(scope))
    .from(readingSessions)
    .innerJoin(works, eq(works.id, readingSessions.workId))
    .leftJoin(editions, eq(editions.id, readingSessions.editionId))
    .leftJoin(checkinSnoozes, eq(checkinSnoozes.sessionId, readingSessions.id))
    .where(
      and(
        eq(readingSessions.userId, scope.userId),
        eq(readingSessions.outcome, 'in_progress'),
        scope.visible,
        sql`(${checkinSnoozes.until} is null or ${checkinSnoozes.until} < ${today})`,
      ),
    )
    .orderBy(asc(readingSessions.startedOn))
  return withProgress(db, rows)
}

export async function listSessionsForWork(db: Db, scope: UserScope, workId: string): Promise<SessionView[]> {
  // visibility is enforced by the upfront assertVisibleWork call
  await assertVisibleWork(db, scope, workId)
  const rows = await db
    .select(sessionColumns(scope))
    .from(readingSessions)
    .innerJoin(works, eq(works.id, readingSessions.workId))
    .leftJoin(editions, eq(editions.id, readingSessions.editionId))
    .where(and(eq(readingSessions.userId, scope.userId), eq(readingSessions.workId, workId)))
    .orderBy(desc(readingSessions.createdAt))
  return withProgress(db, rows)
}

export async function snoozeCheckin(db: Db, scope: UserScope, sessionId: string, until: string): Promise<void> {
  const [row] = await db.select({ userId: readingSessions.userId, workId: readingSessions.workId }).from(readingSessions).where(eq(readingSessions.id, sessionId))
  if (!row || row.userId !== scope.userId) throw notFound('Session')
  await assertVisibleWork(db, scope, row.workId)
  await db
    .insert(checkinSnoozes)
    .values({ userId: scope.userId, sessionId, until })
    .onConflictDoUpdate({ target: [checkinSnoozes.userId, checkinSnoozes.sessionId], set: { until } })
}

/** Check-in leaves a book alone for this long after the reader last checked in on it (#45). */
export const CHECKIN_QUIET_MS = 12 * 60 * 60 * 1000

/**
 * The sessions among `sessionIds` the reader checked in on within CHECKIN_QUIET_MS of `now`: a "Still going"
 * answer, or a progress point saved (from check-in or the book page — a point's created_at moves with each save).
 */
async function recentlyCheckedIn(db: Db, sessionIds: string[], now: Date): Promise<string[]> {
  if (sessionIds.length === 0) return []
  const since = new Date(now.getTime() - CHECKIN_QUIET_MS)
  const [marks, points] = await Promise.all([
    db
      .select({ sessionId: checkinMarks.sessionId })
      .from(checkinMarks)
      .where(and(inArray(checkinMarks.sessionId, sessionIds), gte(checkinMarks.checkedInAt, since))),
    db
      .selectDistinct({ sessionId: readingProgress.sessionId })
      .from(readingProgress)
      .where(and(inArray(readingProgress.sessionId, sessionIds), gte(readingProgress.createdAt, since))),
  ])
  const recent = new Set([...marks, ...points].map((r) => r.sessionId))
  return sessionIds.filter((id) => recent.has(id))
}

/** "Still going" with nothing new to record: check-in won't ask about this book for the next 12 hours. */
export async function markCheckedIn(db: Db, scope: UserScope, sessionId: string): Promise<void> {
  const [row] = await db
    .select({ userId: readingSessions.userId, workId: readingSessions.workId, outcome: readingSessions.outcome })
    .from(readingSessions)
    .where(eq(readingSessions.id, sessionId))
  if (!row || row.userId !== scope.userId) throw notFound('Session')
  await assertVisibleWork(db, scope, row.workId)
  if (row.outcome !== 'in_progress') throw new DomainError('CONFLICT', 'This session was already completed')
  await db
    .insert(checkinMarks)
    .values({ sessionId, checkedInAt: sql`now()` })
    .onConflictDoUpdate({ target: checkinMarks.sessionId, set: { checkedInAt: sql`now()` } })
}

export interface CheckinState {
  /** check-in opens by itself: not yet today, and some book (or "started anything new?") is left to ask about */
  dueToday: boolean
  inProgress: SessionView[]
  /** sessions in `inProgress` checked in on within the last 12 hours: skipped when check-in opens by itself */
  recentlyCheckedIn: string[]
}

export async function getCheckinState(db: Db, scope: UserScope, today: string, now: Date = new Date()): Promise<CheckinState> {
  const [state] = await db
    .select({ lastPromptedOn: checkinStates.lastPromptedOn })
    .from(checkinStates)
    .where(eq(checkinStates.userId, scope.userId))
  // a session waiting for its next volume has nothing to report until that volume is in the catalog (#66)
  const inProgress = (await listInProgressSessions(db, scope, today)).filter((s) => !s.progress.volume?.waiting)
  const recent = await recentlyCheckedIn(db, inProgress.map((s) => s.id), now)
  // with every book checked in on lately, an automatic check-in would only ask "started anything new?": it waits
  const allRecent = inProgress.length > 0 && recent.length === inProgress.length
  return { dueToday: (state?.lastPromptedOn ?? null) !== today && !allRecent, inProgress, recentlyCheckedIn: recent }
}

export async function dismissCheckin(db: Db, scope: UserScope, today: string): Promise<void> {
  const lastPromptedOn = today
  await db
    .insert(checkinStates)
    .values({ userId: scope.userId, lastPromptedOn })
    .onConflictDoUpdate({ target: checkinStates.userId, set: { lastPromptedOn } })
}
