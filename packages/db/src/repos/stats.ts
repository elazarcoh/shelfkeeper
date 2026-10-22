import { and, asc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm'
import {
  bookFraction,
  progressFraction,
  progressStatsSpan,
  sessionStatsRange,
  setAmountSource,
  spreadProgressStats,
  spreadSessionStats,
  type DailyAmount,
  type DatePrecision,
  type EditionFormat,
  type ProgressCheckpoint,
  type ProgressSessionForStats,
  type SessionMode,
  type SessionOutcome,
} from '@mylib/domain'
import type { Db } from '../client'
import { dailyStats, editions, readingProgress, readingSessions, works } from '../schema'
import { getWorkCards } from './library'
import type { UserScope } from './scope'
import { editionOfPoint, loadEditionContexts } from './volume-context'
import { shownTitleField } from './titles'

interface StatSessionRow {
  workId: string
  title: string
  mode: SessionMode
  outcome: SessionOutcome
  startedOn: string
  startedPrecision: DatePrecision
  finishedOn: string | null
  finishedPrecision: DatePrecision | null
  fractionCompleted: number | null
  durationSec: number | null
  durationEstimated: boolean
  editionWordCount: number | null
  workWordCount: number | null
  pageCount: number | null
  editionId: string | null
  /** the session's progress points that have a fraction (reading progress spec §4) */
  checkpoints: ProgressCheckpoint[]
}

/**
 * Every session of this user on a visible work that can contribute to stats: completed sessions, and in-progress
 * sessions with at least one usable progress point. A point's fraction uses the session's own edition's length.
 * `amountsFor: 'open'` (the day drill-down) loads the work-level sizes and fallbacks only for open sessions with points,
 * the only ones whose amounts the drill-down computes; the other rows then have no work-level fallbacks.
 */
async function loadStatSessions(db: Db, scope: UserScope, amountsFor: 'all' | 'open' = 'all'): Promise<StatSessionRow[]> {
  const rows = await db
    .select({
      id: readingSessions.id,
      workId: readingSessions.workId,
      title: shownTitleField(works.id, scope.languages, 'title'),
      mode: readingSessions.mode,
      outcome: readingSessions.outcome,
      startedOn: readingSessions.startedOn,
      startedPrecision: readingSessions.startedPrecision,
      finishedOn: readingSessions.finishedOn,
      finishedPrecision: readingSessions.finishedPrecision,
      fractionCompleted: readingSessions.fractionCompleted,
      durationSec: editions.durationSec,
      editionPageCount: editions.pageCount,
      editionWordCount: editions.wordCount,
      editionId: readingSessions.editionId,
    })
    .from(readingSessions)
    .innerJoin(works, eq(works.id, readingSessions.workId))
    .leftJoin(editions, eq(editions.id, readingSessions.editionId))
    .where(and(eq(readingSessions.userId, scope.userId), scope.visible))

  // this user's points only; the session rows above already carry visibility
  const points = await db
    .select({ sessionId: readingProgress.sessionId, on: readingProgress.occurredOn, kind: readingProgress.kind, value: readingProgress.value, editionId: readingProgress.editionId })
    .from(readingProgress)
    .innerJoin(readingSessions, eq(readingSessions.id, readingProgress.sessionId))
    .where(eq(readingSessions.userId, scope.userId))
  const pointsBySession = new Map<string, typeof points>()
  for (const p of points) {
    const list = pointsBySession.get(p.sessionId)
    if (list === undefined) pointsBySession.set(p.sessionId, [p])
    else list.push(p)
  }

  // each point counts in its own volume, and a session's amounts span its whole volume set (#66)
  const contexts = await loadEditionContexts(db, [...new Set([...rows.map((r) => r.editionId), ...points.map((p) => p.editionId)].filter((id) => id !== null))])

  const candidates = rows.flatMap((r) => {
    const length = { pageCount: r.editionPageCount, durationSec: r.durationSec }
    const checkpoints = (pointsBySession.get(r.id) ?? []).flatMap((p) => {
      const e = editionOfPoint(p.editionId, r.editionId, contexts)
      if (e === null) return [] // a point whose volume can't be known has no book fraction
      const fraction = e === undefined ? progressFraction(p.kind, p.value, length) : bookFraction(p.kind, p.value, e.length, e.ctx)
      return fraction === null ? [] : [{ on: p.on, fraction }]
    })
    // a completed session without a fraction contributes no amounts but still shows in the day drill-down, as before
    const completed = r.outcome !== 'in_progress' && r.finishedOn !== null && r.finishedPrecision !== null
    if (!completed && checkpoints.length === 0) return []
    // open: in progress, or a legacy completed row without a fraction (forProgress treats both as having no end)
    const open = checkpoints.length > 0 && (r.outcome === 'in_progress' || r.finishedOn === null || r.finishedPrecision === null || r.fractionCompleted === null)
    return [{ r, checkpoints, open }]
  })

  const workIds = [...new Set(candidates.filter((c) => amountsFor === 'all' || c.open).map((c) => c.r.workId))]
  const workStats =
    workIds.length === 0
      ? []
      : await db
          .select({
            workId: editions.workId,
            wordCount: sql<number | null>`max(${editions.wordCount})`,
            pageCount: sql<number | null>`max(${editions.pageCount})`,
            audioDurationSec: sql<number | null>`max(${editions.durationSec}) filter (where ${editions.format} = 'audiobook')`,
          })
          .from(editions)
          .where(inArray(editions.workId, workIds))
          .groupBy(editions.workId)
  const byWork = new Map(workStats.map((w) => [w.workId, w]))

  return candidates.map(({ r, checkpoints }): StatSessionRow => {
    const work = byWork.get(r.workId)
    // in a volume set the amounts are the whole set's: every volume's length, else this one's times the set's size
    const sc = contexts.get(r.editionId ?? '')?.ctx ?? null
    const amount = setAmountSource(sc, { pageCount: r.editionPageCount, durationSec: r.durationSec, wordCount: r.editionWordCount })
    // no duration on the session's own edition (or no edition at all): use the work's best-known audiobook duration
    // (one volume's, in a volume set: times the set's size)
    const fallbackDuration = amount.durationSec === null && work?.audioDurationSec != null ? work.audioDurationSec * (sc?.size ?? 1) : null
    return {
      workId: r.workId,
      title: r.title,
      mode: r.mode,
      outcome: r.outcome,
      startedOn: r.startedOn,
      startedPrecision: r.startedPrecision,
      finishedOn: r.finishedOn,
      finishedPrecision: r.finishedPrecision,
      fractionCompleted: r.fractionCompleted,
      durationSec: amount.durationSec ?? fallbackDuration,
      durationEstimated: fallbackDuration !== null,
      editionWordCount: amount.wordCount,
      workWordCount: work?.wordCount ?? null,
      pageCount: sc === null ? (work?.pageCount ?? null) : (amount.pageCount ?? work?.pageCount ?? null),
      editionId: r.editionId,
      checkpoints,
    }
  })
}

const INSERT_CHUNK_ROWS = 1000

export interface DateSpan {
  from: string
  to: string
}

const wordCountSourceOf = (s: StatSessionRow) => ({ editionWordCount: s.editionWordCount, workWordCount: s.workWordCount, pageCount: s.pageCount })

function forProgress(s: StatSessionRow): ProgressSessionForStats {
  // A legacy completed row without a fraction (no write path makes one today) but with points has no usable end:
  // it is treated like an in-progress session and counts up to its latest point, not to its finish.
  const end =
    s.outcome === 'in_progress' || s.finishedOn === null || s.finishedPrecision === null || s.fractionCompleted === null
      ? null
      : { on: s.finishedOn, precision: s.finishedPrecision, fraction: s.fractionCompleted }
  return {
    mode: s.mode,
    startedOn: s.startedOn,
    startedPrecision: s.startedPrecision,
    end,
    checkpoints: s.checkpoints,
    durationSec: s.durationSec,
    durationEstimated: s.durationEstimated,
    wordCountSource: wordCountSourceOf(s),
  }
}

/**
 * The days a session covers: with usable points, start through its latest point or dated finish; else its start–finish
 * range (today's rule). None for a session without points finished on an unknown date: it is read, but on no day.
 */
function coveredSpanOf(s: StatSessionRow): DateSpan | null {
  if (s.checkpoints.length > 0) return progressStatsSpan(forProgress(s))
  if (s.finishedOn === null || s.finishedPrecision === null) return null
  const range = sessionStatsRange({ startedOn: s.startedOn, startedPrecision: s.startedPrecision, finishedOn: s.finishedOn, finishedPrecision: s.finishedPrecision })
  return range === null ? null : { from: range.from, to: range.to }
}

/** The days a session's stats cover, or null when it contributes nothing (spec: sessions without usable points keep today's rule). */
function spanOf(s: StatSessionRow): DateSpan | null {
  if (s.checkpoints.length === 0 && s.fractionCompleted === null) return null
  return coveredSpanOf(s)
}

function dailyAmountsOf(s: StatSessionRow): DailyAmount[] {
  if (s.checkpoints.length > 0) return spreadProgressStats(forProgress(s))
  if (s.finishedOn === null || s.finishedPrecision === null || s.fractionCompleted === null) return []
  return spreadSessionStats({
    mode: s.mode,
    startedOn: s.startedOn,
    startedPrecision: s.startedPrecision,
    finishedOn: s.finishedOn,
    finishedPrecision: s.finishedPrecision,
    fractionCompleted: s.fractionCompleted,
    durationSec: s.durationSec,
    durationEstimated: s.durationEstimated,
    wordCountSource: wordCountSourceOf(s),
  })
}

const overlaps = (a: DateSpan, b: DateSpan) => a.from <= b.to && b.from <= a.to
const widen = (a: DateSpan, b: DateSpan): DateSpan => ({ from: a.from < b.from ? a.from : b.from, to: a.to > b.to ? a.to : b.to })

/**
 * Recomputes this user's daily_stat from their sessions.
 * - With `workIds`, only the days covered by this user's sessions on those works, plus `include`, are rebuilt.
 *   `include` is for a change that can shrink a session's span (removing or back-dating a progress point): the
 *   days it used to cover must be rebuilt too, or their old numbers stay.
 * - Without `workIds`, everything is rebuilt (`include` is ignored).
 */
export async function rebuildDailyStats(
  db: Db,
  scope: UserScope,
  options: { workIds?: readonly string[] | undefined; include?: DateSpan | undefined } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    // one rebuild per user at a time
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.userId}))`)

    const sessions = await loadStatSessions(tx, scope)
    let span: DateSpan | null = null
    if (options.workIds !== undefined) {
      const affected = new Set(options.workIds)
      span = options.include ?? null
      for (const s of sessions) {
        if (!affected.has(s.workId)) continue
        const own = spanOf(s)
        if (own !== null) span = span === null ? own : widen(span, own)
      }
      // nothing on those works covers any day, and nothing asked to be included: no day's numbers changed
      if (span === null) return
    }
    const limit = span

    const totals = new Map<string, { minutes: number; words: number; estimated: boolean }>()
    for (const s of sessions) {
      const own = spanOf(s)
      if (own === null) continue
      if (limit !== null && !overlaps(own, limit)) continue
      for (const r of dailyAmountsOf(s)) {
        if (limit !== null && (r.date < limit.from || r.date > limit.to)) continue
        const key = `${r.date}|${s.mode}`
        const existing = totals.get(key) ?? { minutes: 0, words: 0, estimated: false }
        totals.set(key, {
          minutes: existing.minutes + r.minutes,
          words: existing.words + r.words,
          estimated: existing.estimated || r.estimated,
        })
      }
    }

    await tx
      .delete(dailyStats)
      .where(limit === null ? eq(dailyStats.userId, scope.userId) : and(eq(dailyStats.userId, scope.userId), gte(dailyStats.date, limit.from), lte(dailyStats.date, limit.to)))
    const values = [...totals.entries()].map(([key, v]) => {
      const [date, mode] = key.split('|') as [string, SessionMode]
      return { userId: scope.userId, date, mode, minutes: v.minutes, words: v.words, estimated: v.estimated }
    })
    // chunked: a long imprecise session spreads over many days, and one huge insert would hit the bind-parameter limit
    for (let i = 0; i < values.length; i += INSERT_CHUNK_ROWS) {
      await tx.insert(dailyStats).values(values.slice(i, i + INSERT_CHUNK_ROWS))
    }
  })
}

export interface DailyStatRow {
  date: string
  mode: SessionMode
  minutes: number
  words: number
  estimated: boolean
}

export interface StatsRange {
  from: string
  to: string
}

async function queryDailyStats(db: Db, userId: string, range: StatsRange): Promise<DailyStatRow[]> {
  return db
    .select({
      date: dailyStats.date,
      mode: dailyStats.mode,
      minutes: dailyStats.minutes,
      words: dailyStats.words,
      estimated: dailyStats.estimated,
    })
    .from(dailyStats)
    .where(and(eq(dailyStats.userId, userId), gte(dailyStats.date, range.from), lte(dailyStats.date, range.to)))
    .orderBy(asc(dailyStats.date))
}

export async function getDailyStats(db: Db, scope: UserScope, range: StatsRange): Promise<DailyStatRow[]> {
  await rebuildDailyStats(db, scope)
  return queryDailyStats(db, scope.userId, range)
}

export interface StatsSummary {
  totalMinutes: number
  totalWords: number
  booksFinished: number
  byFormat: Record<EditionFormat | 'unspecified', number>
}

/**
 * This user's finished sessions on visible works whose finish counts in `range` — the SQL twin of the domain's
 * finishCountsInRange: a known finish date inside the range; a year-only finish only when the range covers that whole
 * year; an unknown finish date never.
 */
function finishedInRange(scope: UserScope, range: StatsRange) {
  const yearStart = sql`date_trunc('year', ${readingSessions.finishedOn})::date`
  return and(
    eq(readingSessions.userId, scope.userId),
    eq(readingSessions.outcome, 'finished'),
    ne(readingSessions.finishedPrecision, 'unknown'),
    gte(readingSessions.finishedOn, range.from),
    lte(readingSessions.finishedOn, range.to),
    or(
      ne(readingSessions.finishedPrecision, 'year'),
      and(sql`${yearStart} >= ${range.from}::date`, sql`(${yearStart} + interval '1 year - 1 day')::date <= ${range.to}::date`),
    ),
    scope.visible,
  )
}

/**
 * A finished session's format: its own edition's, else the work's when all its editions share one format,
 * else 'unspecified'. Shared by the summary's format split and the finished-books list so they always agree.
 */
async function sessionFormatResolver(
  db: Db,
  rows: readonly { workId: string; editionFormat: EditionFormat | null }[],
): Promise<(row: { workId: string; editionFormat: EditionFormat | null }) => EditionFormat | 'unspecified'> {
  const workIds = [...new Set(rows.map((r) => r.workId))]
  const workEditions =
    workIds.length === 0
      ? []
      : await db.select({ workId: editions.workId, format: editions.format }).from(editions).where(inArray(editions.workId, workIds))
  const formatByWork = new Map<string, EditionFormat | null>()
  for (const workId of workIds) {
    const unique = [...new Set(workEditions.filter((e) => e.workId === workId).map((e) => e.format))]
    formatByWork.set(workId, unique.length === 1 ? (unique[0] ?? null) : null)
  }
  return (row) => row.editionFormat ?? formatByWork.get(row.workId) ?? 'unspecified'
}

export async function getStatsSummary(db: Db, scope: UserScope, range: StatsRange): Promise<StatsSummary> {
  await rebuildDailyStats(db, scope)
  return summarizeStats(db, scope, range)
}

/** getStatsSummary without the rebuild — for callers that already rebuilt (e.g. listGoals, once for every goal). */
export async function summarizeStats(db: Db, scope: UserScope, range: StatsRange): Promise<StatsSummary> {
  const daily = await queryDailyStats(db, scope.userId, range)
  const totalMinutes = daily.reduce((sum, r) => sum + r.minutes, 0)
  const totalWords = daily.reduce((sum, r) => sum + r.words, 0)

  const rows = await db
    .select({ workId: readingSessions.workId, editionFormat: editions.format })
    .from(readingSessions)
    .innerJoin(works, eq(works.id, readingSessions.workId))
    .leftJoin(editions, eq(editions.id, readingSessions.editionId))
    .where(finishedInRange(scope, range))

  const formatOf = await sessionFormatResolver(db, rows)
  const byFormat: Record<EditionFormat | 'unspecified', number> = { physical: 0, ebook: 0, audiobook: 0, unspecified: 0 }
  for (const r of rows) byFormat[formatOf(r)] += 1

  return { totalMinutes, totalWords, booksFinished: rows.length, byFormat }
}

export interface DateCoveredSession {
  workId: string
  title: string
  mode: SessionMode
}

/**
 * Sessions whose stats cover `date` — the heatmap's day drill-down. An open session with points (no usable end) is
 * listed only on days it adds a positive amount, so a 0% point or a lower point held back by the high-water mark
 * never lists a book on a day the heatmap shows empty. Every other session keeps its span rule.
 */
export async function getSessionsOnDate(db: Db, scope: UserScope, date: string): Promise<DateCoveredSession[]> {
  const sessions = await loadStatSessions(db, scope, 'open')
  return sessions.flatMap((s) => {
    const span = coveredSpanOf(s)
    if (span === null || date < span.from || date > span.to) return []
    if (s.checkpoints.length > 0 && forProgress(s).end === null) {
      const adds = dailyAmountsOf(s).some((a) => a.date === date && (a.minutes > 0 || a.words > 0))
      if (!adds) return []
    }
    return [{ workId: s.workId, title: s.title, mode: s.mode }]
  })
}

export interface FinishedBook {
  sessionId: string
  workId: string
  title: string
  authors: string[]
  coverAssetId: string | null
  /** the user's current rating of the work (not of this particular read) */
  rating: number | null
  format: EditionFormat | 'unspecified'
  mode: SessionMode
  startedOn: string
  startedPrecision: DatePrecision
  finishedOn: string
  finishedPrecision: DatePrecision
  isReread: boolean
  /** the read edition's page count, else the work's largest known */
  pageCount: number | null
  /** the listened edition's duration, else the work's longest audiobook */
  durationSec: number | null
}

/** Every finished session in `range` (one per read, so a reread appears twice), oldest finish first — the Stats page's shelf, timeline and highlights. */
export async function getFinishedBooks(db: Db, scope: UserScope, range: StatsRange): Promise<FinishedBook[]> {
  const rows = await db
    .select({
      sessionId: readingSessions.id,
      workId: readingSessions.workId,
      mode: readingSessions.mode,
      startedOn: readingSessions.startedOn,
      startedPrecision: readingSessions.startedPrecision,
      finishedOn: readingSessions.finishedOn,
      finishedPrecision: readingSessions.finishedPrecision,
      isReread: readingSessions.isReread,
      editionFormat: editions.format,
      editionPages: editions.pageCount,
      editionDuration: editions.durationSec,
    })
    .from(readingSessions)
    .innerJoin(works, eq(works.id, readingSessions.workId))
    .leftJoin(editions, eq(editions.id, readingSessions.editionId))
    .where(finishedInRange(scope, range))
    .orderBy(asc(readingSessions.finishedOn), asc(readingSessions.id))
  if (rows.length === 0) return []

  const workIds = [...new Set(rows.map((r) => r.workId))]
  const [formatOf, cards, sizes] = await Promise.all([
    sessionFormatResolver(db, rows),
    getWorkCards(db, scope, workIds),
    db
      .select({
        workId: editions.workId,
        pageCount: sql<number | null>`max(${editions.pageCount})`,
        durationSec: sql<number | null>`max(${editions.durationSec}) filter (where ${editions.format} = 'audiobook')`,
      })
      .from(editions)
      .where(inArray(editions.workId, workIds))
      .groupBy(editions.workId),
  ])
  const cardById = new Map(cards.map((c) => [c.id, c]))
  const sizeById = new Map(sizes.map((w) => [w.workId, w]))

  return rows.flatMap((r): FinishedBook[] => {
    const card = cardById.get(r.workId)
    if (!card || r.finishedOn === null || r.finishedPrecision === null) return []
    const size = sizeById.get(r.workId)
    return [
      {
        sessionId: r.sessionId,
        workId: r.workId,
        title: card.title,
        authors: card.authors,
        coverAssetId: card.coverAssetId,
        rating: card.rating,
        format: formatOf(r),
        mode: r.mode,
        startedOn: r.startedOn,
        startedPrecision: r.startedPrecision,
        finishedOn: r.finishedOn,
        finishedPrecision: r.finishedPrecision,
        isReread: r.isReread,
        pageCount: r.editionPages ?? size?.pageCount ?? null,
        durationSec: r.editionDuration ?? size?.durationSec ?? null,
      },
    ]
  })
}
