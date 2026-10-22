import { and, asc, desc, eq, gt, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import { isFavoriteAuthor, normalizeText, pickHardcoverSeries, WHAT_NEXT } from '@mylib/domain'
import type { HardcoverAuthorBooks, HardcoverBookSeries, HardcoverExternalBook, HardcoverSeriesBooks } from '@mylib/domain'
import type { Db } from '../client'
import {
  authorFollows,
  contributors,
  hardcoverAuthors,
  hardcoverBooks,
  hardcoverExternalBooks,
  hardcoverMissingBooks,
  hardcoverReads,
  hardcoverRecommendations,
  hardcoverSeries,
  readingSessions,
  series,
  userWorks,
  workContributors,
  workSeries,
} from '../schema'
import { HARDCOVER_RECHECK_DAYS } from './hardcover'
import { shownSeriesName } from './series-names'

const DAY_MS = 86_400_000
export const MATCHED = ['isbn', 'title', 'openlibrary', 'manual'] as const

export interface ExploreTargets {
  /** one matched Hardcover id per series a member reads, whose Hardcover series is unknown or not fresh: ask for its details to learn the series */
  seriesBookIds: number[]
  /** the same for each favorite or followed author */
  authorBookIds: number[]
  /** Hardcover ids the page may show (cached series and author books, recommendations, similar books of the last finished) that lack fresh details */
  detailIds: number[]
}

/** A matched book of the library with whatever details the cache holds for it. */
export interface MatchedBook {
  hardcoverId: number
  details: { series: HardcoverBookSeries[]; authors: string[]; authorIds: number[] } | null
}

const freshSince = (now: Date) => new Date(now.getTime() - HARDCOVER_RECHECK_DAYS * DAY_MS)
const sorted = (ids: Iterable<number>, limit: number) => [...new Set(ids)].sort((a, b) => a - b).slice(0, limit)

const detailColumns = {
  hardcoverId: hardcoverBooks.hardcoverId,
  detailsId: hardcoverExternalBooks.hardcoverId,
  series: hardcoverExternalBooks.series,
  authors: hardcoverExternalBooks.authors,
  authorIds: hardcoverExternalBooks.authorIds,
}

function matchedBook(r: { hardcoverId: number | null; detailsId: number | null; series: HardcoverBookSeries[] | null; authors: string[] | null; authorIds: number[] | null }): MatchedBook | null {
  if (r.hardcoverId === null) return null
  const details = r.detailsId === null ? null : { series: r.series ?? [], authors: r.authors ?? [], authorIds: r.authorIds ?? [] }
  return { hardcoverId: r.hardcoverId, details }
}

/** Local series any member (or only `userId`) is reading or has read, each with its matched books, in Hardcover id order. */
export async function memberSeries(db: Db, languages: readonly string[], userId?: string): Promise<SeriesGroup[]> {
  const rows = await db
    .selectDistinct({ seriesId: series.id, ...pickedNames(languages), ...detailColumns })
    .from(userWorks)
    .innerJoin(workSeries, eq(workSeries.workId, userWorks.workId))
    .innerJoin(series, eq(series.id, workSeries.seriesId))
    .innerJoin(hardcoverBooks, eq(hardcoverBooks.workId, userWorks.workId))
    .leftJoin(hardcoverExternalBooks, eq(hardcoverExternalBooks.hardcoverId, hardcoverBooks.hardcoverId))
    .where(and(inArray(userWorks.status, ['reading', 'read']), inArray(hardcoverBooks.match, MATCHED), isNotNull(hardcoverBooks.hardcoverId), userId === undefined ? undefined : eq(userWorks.userId, userId)))
    .orderBy(asc(series.id), asc(hardcoverBooks.hardcoverId))
  return groupBySeries(rows)
}

/**
 * `name` is what the reader sees (their title languages, #145). `matchName` picks the Hardcover series for the group and
 * ignores the reader: Hardcover names are English, and the nightly fetch (no reader) must choose the same series the page does,
 * so what the shared cache holds never depends on anyone's language order.
 */
type SeriesGroup = { seriesId: string; name: string; matchName: string; books: MatchedBook[] }

const pickedNames = (languages: readonly string[]) => ({
  seriesName: shownSeriesName(series.id, languages),
  matchName: shownSeriesName(series.id, ['en']),
})

function groupBySeries(rows: (Parameters<typeof matchedBook>[0] & { seriesId: string; seriesName: string; matchName: string })[]): SeriesGroup[] {
  const bySeries = new Map<string, SeriesGroup>()
  for (const r of rows) {
    const book = matchedBook(r)
    if (!book) continue
    const group = bySeries.get(r.seriesId) ?? { seriesId: r.seriesId, name: r.seriesName, matchName: r.matchName, books: [] }
    group.books.push(book)
    bySeries.set(r.seriesId, group)
  }
  return [...bySeries.values()]
}

/** The given local series, each with its matched books (whoever reads them), in Hardcover id order. */
export async function matchedSeries(db: Db, languages: readonly string[], seriesIds: string[]): Promise<SeriesGroup[]> {
  if (seriesIds.length === 0) return []
  const rows = await db
    .selectDistinct({ seriesId: series.id, ...pickedNames(languages), ...detailColumns })
    .from(series)
    .innerJoin(workSeries, eq(workSeries.seriesId, series.id))
    .innerJoin(hardcoverBooks, eq(hardcoverBooks.workId, workSeries.workId))
    .leftJoin(hardcoverExternalBooks, eq(hardcoverExternalBooks.hardcoverId, hardcoverBooks.hardcoverId))
    .where(and(inArray(series.id, seriesIds), inArray(hardcoverBooks.match, MATCHED), isNotNull(hardcoverBooks.hardcoverId)))
    .orderBy(asc(series.id), asc(hardcoverBooks.hardcoverId))
  return groupBySeries(rows)
}

/** The Hardcover series standing for a local one, from the first matched book whose details name one; null while no details are cached or none fits. */
export function hardcoverSeriesOf(group: { matchName: string; books: MatchedBook[] }): { known: boolean; entry: HardcoverBookSeries | null } {
  const withDetails = group.books.flatMap((b) => (b.details ? [b.details] : []))
  for (const d of withDetails) {
    const entry = pickHardcoverSeries(group.matchName, d.series)
    if (entry) return { known: true, entry }
  }
  return { known: withDetails.length > 0, entry: null }
}

async function freshIds(db: Db, now: Date, table: 'series' | 'author'): Promise<Set<number>> {
  const since = freshSince(now)
  const rows =
    table === 'series'
      ? await db.select({ id: hardcoverSeries.hardcoverSeriesId }).from(hardcoverSeries).where(gt(hardcoverSeries.fetchedAt, since))
      : await db.select({ id: hardcoverAuthors.hardcoverAuthorId }).from(hardcoverAuthors).where(gt(hardcoverAuthors.fetchedAt, since))
  return new Set(rows.map((r) => r.id))
}

/** Hardcover author id of a library author within a matched book's details: by name at the same index, else the only author. */
function authorIdIn(name: string, details: { authors: string[]; authorIds: number[] }): number | null {
  const target = normalizeText(name)
  const i = details.authors.findIndex((a) => normalizeText(a) === target)
  const named = details.authorIds[i]
  if (i >= 0 && named !== undefined) return named
  return details.authorIds.length === 1 ? (details.authorIds[0] ?? null) : null
}

export interface FavoriteAuthors {
  /** library authors (contributors) a member follows or reads enough to favor, with their matched books (none when unmatched) */
  contributors: { contributorId: string; name: string; why: 'auto' | 'follow'; books: MatchedBook[] }[]
  /** Hardcover authors followed directly */
  hardcoverFollows: { id: number; name: string }[]
}

/** A member's favorites (every member's, or only `userId`'s): automatic ones (isFavoriteAuthor over their own reads) minus their unfollows, plus their follows. */
export async function favoriteAuthors(db: Db, userId?: string): Promise<FavoriteAuthors> {
  const [reads, follows] = await Promise.all([
    db
      .selectDistinct({ userId: userWorks.userId, workId: userWorks.workId, contributorId: workContributors.contributorId, rating: userWorks.rating })
      .from(userWorks)
      .innerJoin(workContributors, eq(workContributors.workId, userWorks.workId))
      .where(and(eq(userWorks.status, 'read'), userId === undefined ? undefined : eq(userWorks.userId, userId))),
    db
      .select({ userId: authorFollows.userId, contributorId: authorFollows.contributorId, hardcoverAuthorId: authorFollows.hardcoverAuthorId, mode: authorFollows.mode, name: authorFollows.name })
      .from(authorFollows)
      .where(userId === undefined ? undefined : eq(authorFollows.userId, userId)),
  ])
  const perMemberAuthor = new Map<string, { userId: string; contributorId: string; reads: { rating: number | null }[] }>()
  for (const r of reads) {
    const key = `${r.userId}:${r.contributorId}`
    const entry = perMemberAuthor.get(key) ?? { userId: r.userId, contributorId: r.contributorId, reads: [] }
    entry.reads.push({ rating: r.rating })
    perMemberAuthor.set(key, entry)
  }
  const unfollowed = new Set(follows.flatMap((f) => (f.mode === 'unfollow' && f.contributorId ? [`${f.userId}:${f.contributorId}`] : [])))
  const favorites = new Map<string, 'auto' | 'follow'>()
  for (const [key, a] of perMemberAuthor) if (!unfollowed.has(key) && isFavoriteAuthor(a.reads)) favorites.set(a.contributorId, 'auto')
  for (const f of follows) if (f.mode === 'follow' && f.contributorId) favorites.set(f.contributorId, 'follow')
  const hardcoverFollows = follows.flatMap((f) => (f.mode === 'follow' && f.hardcoverAuthorId !== null ? [{ id: f.hardcoverAuthorId, name: f.name }] : []))
  if (favorites.size === 0) return { contributors: [], hardcoverFollows }

  const ids = [...favorites.keys()]
  const [people, books] = await Promise.all([
    db.select({ id: contributors.id, name: contributors.name }).from(contributors).where(inArray(contributors.id, ids)),
    db
      .selectDistinct({ contributorId: contributors.id, ...detailColumns })
      .from(contributors)
      .innerJoin(workContributors, eq(workContributors.contributorId, contributors.id))
      .innerJoin(hardcoverBooks, eq(hardcoverBooks.workId, workContributors.workId))
      .leftJoin(hardcoverExternalBooks, eq(hardcoverExternalBooks.hardcoverId, hardcoverBooks.hardcoverId))
      .where(and(inArray(contributors.id, ids), inArray(hardcoverBooks.match, MATCHED), isNotNull(hardcoverBooks.hardcoverId)))
      .orderBy(asc(contributors.id), asc(hardcoverBooks.hardcoverId)),
  ])
  const byContributor = new Map<string, MatchedBook[]>()
  for (const r of books) {
    const book = matchedBook(r)
    if (book) byContributor.set(r.contributorId, [...(byContributor.get(r.contributorId) ?? []), book])
  }
  return {
    contributors: people.map((p) => ({ contributorId: p.id, name: p.name, why: favorites.get(p.id) ?? 'auto', books: byContributor.get(p.id) ?? [] })),
    hardcoverFollows,
  }
}

/** The Hardcover author id for a library author, from the first matched book whose details name them; `known` once any details exist. */
export function hardcoverAuthorOf(group: { name: string; books: MatchedBook[] }): { known: boolean; authorId: number | null } {
  const withDetails = group.books.flatMap((b) => (b.details ? [b.details] : []))
  for (const d of withDetails) {
    const authorId = authorIdIn(group.name, d)
    if (authorId !== null) return { known: true, authorId }
  }
  return { known: withDetails.length > 0, authorId: null }
}

/** The Hardcover series a book is shown in: the entry named like its displayed series, else its first entry (`featured` is not reliable). */
export function displayedSeriesEntry(seriesName: string | null, entries: HardcoverBookSeries[]): HardcoverBookSeries | null {
  const target = seriesName === null ? '' : normalizeText(seriesName)
  return (target === '' ? undefined : entries.find((e) => normalizeText(e.name) === target)) ?? entries[0] ?? null
}

/** Hardcover ids of the books the page may show besides the series' own: recommendations, similar books of the last finished, favorite authors' books. */
async function mayShowIds(db: Db, now: Date): Promise<number[]> {
  const [authorRows, recommendationRows, similarIds] = await Promise.all([
    db.select({ books: hardcoverAuthors.bookIds }).from(hardcoverAuthors),
    db.select({ ids: hardcoverRecommendations.hardcoverIds }).from(hardcoverRecommendations),
    lastFinishedSimilarIds(db, now),
  ])
  return [...authorRows.flatMap((r) => r.books.map((b) => b.id)), ...recommendationRows.flatMap((r) => r.ids), ...similarIds]
}

/**
 * Series ids to fetch: the Hardcover series chosen for each series a member reads, when not fresh; then the series of the
 * books the page may show that sit at position 2 or later (their "first unread" line), when not fresh. Member series come first.
 */
export async function listSeriesIdsToFetch(db: Db, now: Date, limit: number): Promise<number[]> {
  const [fresh, groups, shownIds] = await Promise.all([freshIds(db, now, 'series'), memberSeries(db, ['en']), mayShowIds(db, now)])
  const members: number[] = []
  for (const group of groups) {
    const { entry } = hardcoverSeriesOf(group)
    if (entry && !fresh.has(entry.id)) members.push(entry.id)
  }
  const shown = shownIds.length === 0 ? [] : await db.select({ seriesName: hardcoverExternalBooks.seriesName, position: hardcoverExternalBooks.position, series: hardcoverExternalBooks.series }).from(hardcoverExternalBooks).where(and(inArray(hardcoverExternalBooks.hardcoverId, [...new Set(shownIds)]), gt(hardcoverExternalBooks.position, 1)))
  const later = shown.flatMap((b) => {
    const entry = displayedSeriesEntry(b.seriesName, b.series)
    return entry && !fresh.has(entry.id) ? [entry.id] : []
  })
  const first = sorted(members, limit)
  return [...first, ...sorted(later.filter((id) => !first.includes(id) && !members.includes(id)), limit)].slice(0, limit)
}

/** Author ids to fetch: favorite or followed authors' Hardcover ids (from cached details of their matched books), when not fresh. */
export async function listAuthorIdsToFetch(db: Db, now: Date, limit: number): Promise<number[]> {
  const [fresh, favorites] = await Promise.all([freshIds(db, now, 'author'), favoriteAuthors(db)])
  const ids = favorites.hardcoverFollows.map((f) => f.id)
  for (const group of favorites.contributors) {
    const { authorId } = hardcoverAuthorOf(group)
    if (authorId !== null) ids.push(authorId)
  }
  return sorted(ids.filter((id) => !fresh.has(id)), limit)
}

/** Hardcover ids of the books similar to each member's last finished book (finished within the window, newest completion first). */
async function lastFinishedSimilarIds(db: Db, now: Date): Promise<number[]> {
  const since = new Date(now.getTime() - WHAT_NEXT.lastFinishedDays * DAY_MS).toISOString().slice(0, 10)
  const rows = await db
    .select({ userId: readingSessions.userId, similarIds: hardcoverBooks.similarIds })
    .from(readingSessions)
    .innerJoin(hardcoverBooks, eq(hardcoverBooks.workId, readingSessions.workId))
    .where(and(eq(readingSessions.outcome, 'finished'), ne(readingSessions.finishedPrecision, 'unknown'), gte(readingSessions.finishedOn, since), inArray(hardcoverBooks.match, MATCHED)))
    .orderBy(desc(readingSessions.updatedAt))
  const latest = new Map<string, number[]>()
  for (const r of rows) if (!latest.has(r.userId)) latest.set(r.userId, r.similarIds)
  return [...latest.values()].flat()
}

/**
 * What the nightly run should fetch from Hardcover for the What next page. `limit` caps each list.
 * Series and author book ids are fetched first: their details name the Hardcover series and author to fetch next.
 */
export async function listExploreTargets(db: Db, now: Date, limit: number): Promise<ExploreTargets> {
  const [freshSeries, freshAuthors, seriesGroups, favorites] = await Promise.all([freshIds(db, now, 'series'), freshIds(db, now, 'author'), memberSeries(db, ['en']), favoriteAuthors(db)])

  const seriesBookIds = seriesGroups.flatMap((group) => {
    const { known, entry } = hardcoverSeriesOf(group)
    const seed = group.books[0]?.hardcoverId
    return seed !== undefined && (!known || (entry !== null && !freshSeries.has(entry.id))) ? [seed] : []
  })
  const authorBookIds = favorites.contributors.flatMap((group) => {
    const { known, authorId } = hardcoverAuthorOf(group)
    const seed = group.books[0]?.hardcoverId
    return seed !== undefined && (!known || (authorId !== null && !freshAuthors.has(authorId))) ? [seed] : []
  })

  const [seriesRows, shownIds, matched, freshDetails, missing] = await Promise.all([
    db.select({ books: hardcoverSeries.books }).from(hardcoverSeries),
    mayShowIds(db, now),
    db.select({ id: hardcoverBooks.hardcoverId }).from(hardcoverBooks).where(isNotNull(hardcoverBooks.hardcoverId)),
    db.select({ id: hardcoverExternalBooks.hardcoverId }).from(hardcoverExternalBooks).where(gt(hardcoverExternalBooks.fetchedAt, freshSince(now))),
    db.select({ id: hardcoverMissingBooks.hardcoverId }).from(hardcoverMissingBooks).where(gt(hardcoverMissingBooks.checkedAt, freshSince(now))),
  ])
  // an id Hardcover did not return would keep a slot every night: it waits out the same window as cached details
  const skip = new Set([...matched.map((r) => r.id), ...freshDetails.map((r) => r.id), ...missing.map((r) => r.id)])
  const wanted = [...seriesRows.flatMap((r) => r.books.map((b) => b.id)), ...shownIds]


  return {
    seriesBookIds: sorted(seriesBookIds, limit),
    authorBookIds: sorted(authorBookIds, limit),
    detailIds: sorted(wanted.filter((id) => !skip.has(id)), limit),
  }
}

/** Details of Hardcover books (not necessarily in the library), as `HardcoverClient.bookDetails` returns them. A second save replaces the first. */
export async function saveExternalBooks(db: Db, books: (HardcoverExternalBook & { series: HardcoverBookSeries[]; authorIds: number[] })[], now: Date): Promise<void> {
  for (const b of books) {
    const values = {
      title: b.title,
      authors: b.authors,
      seriesName: b.seriesName,
      position: b.position,
      pages: b.pages,
      releaseDate: b.releaseDate,
      imageUrl: b.imageUrl,
      tags: b.tags,
      hasAudiobook: b.hasAudiobook,
      series: b.series,
      authorIds: b.authorIds,
      fetchedAt: now,
    }
    await db.insert(hardcoverExternalBooks).values({ hardcoverId: b.id, ...values }).onConflictDoUpdate({ target: hardcoverExternalBooks.hardcoverId, set: values })
  }
  if (books.length > 0) await db.delete(hardcoverMissingBooks).where(inArray(hardcoverMissingBooks.hardcoverId, books.map((b) => b.id)))
}

/** Ids a details request asked for and Hardcover did not return: `listExploreTargets` leaves them out until the cache window has passed. */
export async function saveMissingBooks(db: Db, ids: number[], now: Date): Promise<void> {
  if (ids.length === 0) return
  await db
    .insert(hardcoverMissingBooks)
    .values(ids.map((hardcoverId) => ({ hardcoverId, checkedAt: now })))
    .onConflictDoUpdate({ target: hardcoverMissingBooks.hardcoverId, set: { checkedAt: now } })
}

export async function saveHardcoverSeries(db: Db, list: HardcoverSeriesBooks[], now: Date): Promise<void> {
  for (const s of list) {
    const values = { name: s.name, books: s.books, fetchedAt: now }
    await db.insert(hardcoverSeries).values({ hardcoverSeriesId: s.seriesId, ...values }).onConflictDoUpdate({ target: hardcoverSeries.hardcoverSeriesId, set: values })
  }
}

/** The author's name comes from a cached book that lists them (`authors` at the index of their id in `author_ids`); without one the name stays as it was. */
export async function saveHardcoverAuthors(db: Db, list: HardcoverAuthorBooks[], now: Date): Promise<void> {
  for (const a of list) {
    const [book] = await db
      .select({ authors: hardcoverExternalBooks.authors, authorIds: hardcoverExternalBooks.authorIds })
      .from(hardcoverExternalBooks)
      .where(sql`${hardcoverExternalBooks.authorIds} @> ${JSON.stringify([a.authorId])}::jsonb`)
      .orderBy(asc(hardcoverExternalBooks.hardcoverId))
      .limit(1)
    const name = book?.authors[book.authorIds.indexOf(a.authorId)] ?? null
    const values = { bookIds: a.books, fetchedAt: now }
    await db
      .insert(hardcoverAuthors)
      .values({ hardcoverAuthorId: a.authorId, name, ...values })
      .onConflictDoUpdate({ target: hardcoverAuthors.hardcoverAuthorId, set: name === null ? values : { ...values, name } })
  }
}

export async function saveHardcoverRead(db: Db, accountId: string, bookIds: number[], now: Date): Promise<void> {
  await db.insert(hardcoverReads).values({ accountId, bookIds, fetchedAt: now }).onConflictDoUpdate({ target: hardcoverReads.accountId, set: { bookIds, fetchedAt: now } })
}
