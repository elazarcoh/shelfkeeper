import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm'
import { firstUnreadInSeries, nextInSeries, notFound, type SeriesEntry, type WorkCard } from '@mylib/domain'
import type { Db } from '../client'
import { series, userHiddenContinuations, userWorks, workSeries, works } from '../schema'
import { getWorkCards } from './library'
import { assertVisibleWork, type UserScope } from './scope'
import { shownSeriesName } from './series-names'
import { shownTitleField } from './titles'

export interface SeriesEntryView extends WorkCard {
  position: number | null
  positionEnd: number | null
}

async function loadEntries(db: Db, scope: UserScope, seriesId: string): Promise<SeriesEntryView[]> {
  const rows = await db
    .select({ workId: workSeries.workId, position: workSeries.position, positionEnd: workSeries.positionEnd })
    .from(workSeries)
    .innerJoin(works, eq(works.id, workSeries.workId))
    .where(and(eq(workSeries.seriesId, seriesId), scope.visible))
    // sortIndex orders one work's series, not a series' works (#125)
    .orderBy(sql`${workSeries.position} asc nulls last`, asc(shownTitleField(works.id, scope.languages, 'sort_title')), asc(works.id))
  const cards = new Map((await getWorkCards(db, scope, rows.map((r) => r.workId))).map((c) => [c.id, c]))
  return rows.flatMap((r) => {
    const card = cards.get(r.workId)
    return card ? [{ ...card, position: r.position, positionEnd: r.positionEnd }] : []
  })
}

export async function listSeriesEntries(db: Db, scope: UserScope, seriesId: string): Promise<SeriesEntryView[]> {
  return loadEntries(db, scope, seriesId)
}

function toSeriesEntry(view: SeriesEntryView): SeriesEntry {
  return { workId: view.id, position: view.position, status: view.status }
}

export interface SeriesContinuation {
  seriesId: string
  seriesName: string
  nextWorkId: string
  nextTitle: string
  nextAuthors: string[]
  nextCoverAssetId: string | null
}

/** Series continuation leaves out the series this user hid from it. */
function notHidden(db: Db, scope: UserScope) {
  return notExists(
    db
      .select({ one: userHiddenContinuations.seriesId })
      .from(userHiddenContinuations)
      .where(and(eq(userHiddenContinuations.userId, scope.userId), eq(userHiddenContinuations.seriesId, series.id))),
  )
}

function toContinuation(seriesId: string, seriesName: string, entries: SeriesEntryView[], nextWorkId: string | null): SeriesContinuation | null {
  if (nextWorkId === null) return null
  const next = entries.find((e) => e.id === nextWorkId)
  if (!next) return null
  return { seriesId, seriesName, nextWorkId, nextTitle: next.title, nextAuthors: next.authors, nextCoverAssetId: next.coverAssetId }
}

/** The continuation(s) for the series `workId` belongs to, relative to that specific work (e.g. "just finished"). */
export async function getContinuationForWork(db: Db, scope: UserScope, workId: string): Promise<SeriesContinuation[]> {
  await assertVisibleWork(db, scope, workId)
  const memberships = await db
    .select({ seriesId: workSeries.seriesId, seriesName: shownSeriesName(series.id, scope.languages) })
    .from(workSeries)
    .innerJoin(series, eq(series.id, workSeries.seriesId))
    .where(and(eq(workSeries.workId, workId), notHidden(db, scope)))

  const out: SeriesContinuation[] = []
  for (const m of memberships) {
    const entries = await loadEntries(db, scope, m.seriesId)
    const continuation = toContinuation(m.seriesId, m.seriesName, entries, nextInSeries(entries.map(toSeriesEntry), workId))
    if (continuation) out.push(continuation)
  }
  return out
}

/** Household-wide "what's next": one continuation per series the user has started (status reading or read on any entry) and not hidden. */
export async function listContinuationsForUser(db: Db, scope: UserScope): Promise<SeriesContinuation[]> {
  const started = await db
    .selectDistinct({ seriesId: workSeries.seriesId, seriesName: shownSeriesName(series.id, scope.languages) })
    .from(workSeries)
    .innerJoin(series, eq(series.id, workSeries.seriesId))
    .innerJoin(userWorks, and(eq(userWorks.workId, workSeries.workId), eq(userWorks.userId, scope.userId)))
    .innerJoin(works, eq(works.id, workSeries.workId))
    .where(and(inArray(userWorks.status, ['reading', 'read']), scope.visible, notHidden(db, scope)))

  const out: SeriesContinuation[] = []
  for (const s of started) {
    const entries = await loadEntries(db, scope, s.seriesId)
    const continuation = toContinuation(s.seriesId, s.seriesName, entries, firstUnreadInSeries(entries.map(toSeriesEntry)))
    if (continuation) out.push(continuation)
  }
  return out
}

/** Hides a series from this user's Series continuation, or brings it back. Only a series with a book the user can see. */
export async function setContinuationHidden(db: Db, scope: UserScope, seriesId: string, hidden: boolean): Promise<void> {
  const [visible] = await db
    .select({ id: works.id })
    .from(workSeries)
    .innerJoin(works, eq(works.id, workSeries.workId))
    .where(and(eq(workSeries.seriesId, seriesId), scope.visible))
    .limit(1)
  if (!visible) throw notFound('Series')
  if (hidden) await db.insert(userHiddenContinuations).values({ userId: scope.userId, seriesId }).onConflictDoNothing()
  else
    await db
      .delete(userHiddenContinuations)
      .where(and(eq(userHiddenContinuations.userId, scope.userId), eq(userHiddenContinuations.seriesId, seriesId)))
}

/** The ids of the series this user hid from Series continuation. */
export async function listHiddenContinuations(db: Db, scope: UserScope): Promise<string[]> {
  const rows = await db
    .select({ seriesId: userHiddenContinuations.seriesId })
    .from(userHiddenContinuations)
    .where(eq(userHiddenContinuations.userId, scope.userId))
  return rows.map((r) => r.seriesId)
}
