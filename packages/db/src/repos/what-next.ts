import { and, asc, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import {
  WHAT_NEXT,
  autoKindApplies,
  firstUnreadBook,
  normalizeText,
  onePerSeries,
  notFound,
  sameTitleAndAuthor,
  titleAuthorIndex,
  editionFormats,
  isHeavy,
  isHooked,
  isLight,
  lightMoodScore,
  nextPosition,
  preselectMood,
  type AiPick,
  type EditionFormat,
  type WishPage,
  type WorkKind,
  type WhatNextFormat,
  type WhatNextMood,
  type WhatNextPromptInput,
} from '@mylib/domain'
import type { Db } from '../client'
import {
  authorFollows,
  contributorNames,
  contributors,
  editions,
  hardcoverAuthors,
  hardcoverBooks,
  hardcoverExternalBooks,
  hardcoverReads,
  hardcoverRecommendations,
  hardcoverSeries,
  queueEntries,
  readingSessions,
  series,
  seriesNames,
  userWorks,
  whatNextHidden,
  whatNextPrefs,
  wishes,
  workContributors,
  workSeries,
  workTitles,
  works,
} from '../schema'
import { getHardcoverAccount } from './hardcover'
import { createWishWork, upsertWish } from './wishlist'
import { getWorkCards } from './library'
import { shownSeriesName } from './series-names'
import { shownTitleField } from './titles'
import { getContinuationForWork, listContinuationsForUser, listHiddenContinuations } from './series'
import type { UserScope } from './scope'
import { MATCHED, displayedSeriesEntry, favoriteAuthors, hardcoverAuthorOf, hardcoverSeriesOf, matchedSeries, memberSeries } from './what-next-cache'

export interface WhatNextLastFinished {
  workId: string
  title: string
  authors: string[]
  coverAssetId: string | null
  pages: number | null
  audioSec: number | null
  moods: string[]
  heavy: boolean
  finishedOn: string
}
export type PickSource = 'shelf' | 'series' | 'author' | 'hardcover' | 'similar'
export interface WhatNextPick {
  /** 'work:<uuid>' or 'hc:<id>' */
  key: string
  source: PickSource
  reason: string
  workId: string | null
  hardcoverId: number | null
  title: string
  /** the library work's kind; a Hardcover pick that is not a wished work is a book */
  kind: WorkKind
  authors: string[]
  /** the same people with their ids, for following them: a library contributor, a Hardcover author, or both */
  authorRefs: { name: string; contributorId: string | null; hardcoverAuthorId: number | null }[]
  seriesName: string | null
  position: number | null
  pages: number | null
  audioSec: number | null
  coverAssetId: string | null
  imageUrl: string | null
  formats: EditionFormat[]
  audiobook: 'yes' | 'no' | 'unknown'
  onWishlist: boolean
  /** this person's first unread book of the pick's series, when it comes before the pick; null when the pick is it, or nothing earlier is known */
  firstUnread: { title: string; position: number } | null
}
export interface WhatNextView {
  lastFinished: WhatNextLastFinished | null
  preselected: WhatNextMood
  /** only non-empty lists, in the order shelf, series, author, hardcover, similar */
  lists: { source: PickSource; picks: WhatNextPick[] }[]
  /** a household Hardcover account exists and works */
  exploreEnabled: boolean
  personalLinked: boolean
  format: WhatNextFormat
  aiAnswer: { text: string; pastedAt: Date } | null
  favoriteAuthors: { name: string; contributorId: string | null; hardcoverAuthorId: number | null; why: 'auto' | 'follow' }[]
}
export interface WhatNextInput {
  /** null: the preselected mood */
  mood: WhatNextMood | null
  /** null: the saved preference */
  format: WhatNextFormat | null
  /** the caller's date (YYYY-MM-DD) */
  today: string
}

const SOURCES: PickSource[] = ['shelf', 'series', 'author', 'hardcover', 'similar']
/** which moods show each list (the shelf and new-from-authors lists show for all) */
const MOODS_FOR: Record<PickSource, readonly WhatNextMood[]> = {
  shelf: ['keep_going', 'light', 'surprise'],
  series: ['keep_going', 'surprise'],
  author: ['keep_going', 'light', 'surprise'],
  hardcover: ['surprise', 'light'],
  similar: ['keep_going', 'surprise'],
}
const formatRank = (f: EditionFormat) => editionFormats.indexOf(f)

function shift(today: string, unit: 'day' | 'month', n: number): string {
  const d = new Date(`${today}T00:00:00Z`)
  if (unit === 'day') {
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }
  // whole months, the day clamped to the target month's length (31 Aug + 6 months is 28 Feb, not 3 Mar)
  const moved = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
  const lastDay = new Date(Date.UTC(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 0)).getUTCDate()
  moved.setUTCDate(Math.min(d.getUTCDate(), lastDay))
  return moved.toISOString().slice(0, 10)
}

const maxOf = (values: (number | null)[]): number | null => values.reduce<number | null>((m, v) => (v !== null && (m === null || v > m) ? v : m), null)
const lengthText = (len: { pages: number | null; audioSec: number | null }) => (len.audioSec !== null ? `${Math.round(len.audioSec / 3600)} h` : `${len.pages} pages`)
const lightReason = (len: { pages: number | null; audioSec: number | null }, moods: string[]) => {
  const mood = moods.find((m) => (WHAT_NEXT.lightMoods as readonly string[]).includes(m))
  return `Shorter and lighter: ${lengthText(len)}${mood ? `, ${mood}` : ''}`
}

const matchedTags = (workIds: string[], db: Db) =>
  db.select({ workId: hardcoverBooks.workId, hardcoverId: hardcoverBooks.hardcoverId, tags: hardcoverBooks.tags, similarIds: hardcoverBooks.similarIds }).from(hardcoverBooks).where(and(inArray(hardcoverBooks.workId, workIds), inArray(hardcoverBooks.match, MATCHED), isNotNull(hardcoverBooks.hardcoverId)))

/** Every title the books have in any language (#145), by work: for matching a book against outside lists, whatever language it names the book in. */
async function titlesOfWorks(db: Db, ids: readonly string[]): Promise<Map<string, string[]>> {
  const rows = ids.length === 0 ? [] : await db.select({ workId: workTitles.workId, title: workTitles.title }).from(workTitles).where(inArray(workTitles.workId, [...ids])).orderBy(asc(workTitles.workId), desc(workTitles.primary), asc(workTitles.id))
  const by = new Map<string, string[]>()
  for (const r of rows) by.set(r.workId, [...(by.get(r.workId) ?? []), r.title])
  return by
}

interface SeriesRead {
  seriesId: string
  seriesName: string
  workId: string
  status: 'reading' | 'read'
  rating: number | null
  /** the last position of the work (the end of a range) */
  position: number | null
}

/** This person's books in series they have started (status reading or read). */
async function loadSeriesReads(db: Db, scope: UserScope): Promise<SeriesRead[]> {
  const rows = await db
    .select({ seriesId: series.id, seriesName: shownSeriesName(series.id, scope.languages), workId: userWorks.workId, status: userWorks.status, rating: userWorks.rating, position: workSeries.position, positionEnd: workSeries.positionEnd })
    .from(userWorks)
    .innerJoin(workSeries, eq(workSeries.workId, userWorks.workId))
    .innerJoin(series, eq(series.id, workSeries.seriesId))
    .where(and(eq(userWorks.userId, scope.userId), inArray(userWorks.status, ['reading', 'read'])))
  return rows.map((r) => ({ seriesId: r.seriesId, seriesName: r.seriesName, workId: r.workId, status: r.status === 'read' ? 'read' : 'reading', rating: r.rating, position: r.positionEnd ?? r.position }))
}

interface LastFinished extends WhatNextLastFinished {
  similarIds: number[]
}

/** The latest finished session within the window (by completion time, not the backdatable finish date), of a book this person can see. An unknown finish date is stored as the day it was entered, so it never counts. */
async function loadLastFinished(db: Db, scope: UserScope, today: string): Promise<LastFinished | null> {
  const since = shift(today, 'day', -WHAT_NEXT.lastFinishedDays)
  const [row] = await db
    .select({ workId: readingSessions.workId, finishedOn: readingSessions.finishedOn, pages: editions.pageCount, audioSec: editions.durationSec })
    .from(readingSessions)
    .innerJoin(works, eq(works.id, readingSessions.workId))
    .leftJoin(editions, eq(editions.id, readingSessions.editionId))
    .where(and(eq(readingSessions.userId, scope.userId), eq(readingSessions.outcome, 'finished'), isNotNull(readingSessions.finishedOn), ne(readingSessions.finishedPrecision, 'unknown'), gte(readingSessions.finishedOn, since), scope.visible))
    .orderBy(desc(readingSessions.updatedAt))
    .limit(1)
  if (!row?.finishedOn) return null
  const [[card], [hc]] = await Promise.all([getWorkCards(db, scope, [row.workId]).then((c) => [c[0]]), matchedTags([row.workId], db)])
  if (!card) return null
  let { pages, audioSec } = row
  if (pages === null && audioSec === null) {
    const all = await db.select({ pages: editions.pageCount, audioSec: editions.durationSec }).from(editions).where(eq(editions.workId, row.workId))
    pages = maxOf(all.map((e) => e.pages))
    audioSec = maxOf(all.map((e) => e.audioSec))
  }
  const moods = hc?.tags.mood ?? []
  return {
    workId: row.workId,
    title: card.title,
    authors: card.authors,
    coverAssetId: card.coverAssetId,
    pages,
    audioSec,
    moods,
    heavy: isHeavy({ pages, audioSec }, moods),
    finishedOn: row.finishedOn,
    similarIds: hc?.similarIds ?? [],
  }
}

interface FavoriteView {
  name: string
  contributorId: string | null
  hardcoverAuthorId: number | null
  why: 'auto' | 'follow'
}

async function loadFavorites(db: Db, scope: UserScope): Promise<FavoriteView[]> {
  const favorites = await favoriteAuthors(db, scope.userId)
  const list: FavoriteView[] = [
    ...favorites.contributors.map((c) => ({ name: c.name, contributorId: c.contributorId, hardcoverAuthorId: hardcoverAuthorOf(c).authorId, why: c.why })),
    ...favorites.hardcoverFollows.map((f) => ({ name: f.name, contributorId: null, hardcoverAuthorId: f.id, why: 'follow' as const })),
  ]
  return list.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------- the shelf ----------

interface ShelfCandidate {
  id: string
  createdAt: Date
  pages: number | null
  audioSec: number | null
  formats: EditionFormat[]
  moods: string[]
}

/** The person's unread works they can see with a held copy (an audiobook one under audio), ranked by the spec's rules. */
async function shelfPicks(db: Db, scope: UserScope, mood: WhatNextMood, format: WhatNextFormat, hidden: Set<string>, favorites: FavoriteView[]): Promise<WhatNextPick[]> {
  const rows = await db
    .select({ id: works.id, createdAt: works.createdAt })
    .from(works)
    .where(
      and(
        scope.visible,
        sql`coalesce((select ${userWorks.status}::text from ${userWorks} where ${userWorks.userId} = ${scope.userId} and ${userWorks.workId} = ${works.id}), 'none') in ('none', 'want_to_read')`,
        sql`exists (select 1 from ${editions} where ${editions.workId} = ${works.id} and ${editions.inPossession} and (${format === 'audio' ? sql`${editions.format} = 'audiobook'` : sql`true`}))`,
      ),
    )
  const ids = rows.map((r) => r.id).filter((id) => !hidden.has(`work:${id}`))
  if (ids.length === 0) return []
  const [held, authorRows, tagRows, seriesRows, queueRows, continuations, wishRows] = await Promise.all([
    db.select({ workId: editions.workId, format: editions.format, pages: editions.pageCount, audioSec: editions.durationSec }).from(editions).where(and(inArray(editions.workId, ids), eq(editions.inPossession, true))),
    db
      .select({ workId: workContributors.workId, contributorId: workContributors.contributorId, name: contributors.name })
      .from(workContributors)
      .innerJoin(contributors, eq(contributors.id, workContributors.contributorId))
      .where(inArray(workContributors.workId, ids))
      .orderBy(asc(workContributors.position)),
    matchedTags(ids, db),
    db
      .select({ workId: workSeries.workId, seriesId: workSeries.seriesId, name: shownSeriesName(series.id, scope.languages), position: workSeries.position })
      .from(workSeries)
      .innerJoin(series, eq(series.id, workSeries.seriesId))
      .where(inArray(workSeries.workId, ids))
      .orderBy(asc(workSeries.sortIndex)),
    db.select({ workId: queueEntries.workId, position: queueEntries.position }).from(queueEntries).where(eq(queueEntries.userId, scope.userId)),
    listContinuationsForUser(db, scope),
    db.select({ workId: wishes.workId }).from(wishes).where(eq(wishes.userId, scope.userId)),
  ])
  const favoriteIds = new Map(favorites.flatMap((f) => (f.contributorId ? [[f.contributorId, f.name] as const] : [])))
  const queued = new Map(queueRows.map((q) => [q.workId, q.position]))
  const nextOf = new Map(continuations.map((c) => [c.nextWorkId, c]))
  const wished = new Set(wishRows.map((w) => w.workId))

  const candidates = new Map<string, ShelfCandidate>()
  for (const r of rows) {
    const mine = held.filter((e) => e.workId === r.id)
    const audio = mine.filter((e) => e.format === 'audiobook')
    if (mine.length === 0 || (format === 'audio' && audio.length === 0)) continue
    candidates.set(r.id, {
      id: r.id,
      createdAt: r.createdAt,
      // under audio the length is the audiobook's: a long print edition doesn't make the audio heavy
      pages: format === 'audio' ? null : maxOf(mine.map((e) => e.pages)),
      audioSec: maxOf(audio.map((e) => e.audioSec)),
      formats: [...new Set(mine.map((e) => e.format))].sort((a, b) => formatRank(a) - formatRank(b)),
      moods: tagRows.find((t) => t.workId === r.id)?.tags.mood ?? [],
    })
  }

  const ranked = [...candidates.values()].flatMap((c) => {
    const len = { pages: c.pages, audioSec: c.audioSec }
    if (mood === 'light' && !isLight(len, c.moods)) return []
    const next = nextOf.get(c.id)
    const nextPos = next ? seriesRows.find((s) => s.workId === c.id && s.seriesId === next.seriesId)?.position ?? null : null
    const favorite = authorRows.find((a) => a.workId === c.id && favoriteIds.has(a.contributorId))
    const [rank, reason] =
      next !== undefined
        ? ([1, `Next in ${next.seriesName}${nextPos === null ? '' : ` (#${nextPos})`}`] as const)
        : queued.has(c.id)
          ? ([2, 'In your Up next'] as const)
          : favorite !== undefined
            ? ([3, `By ${favoriteIds.get(favorite.contributorId)}`] as const)
            : mood === 'light'
              ? ([4, lightReason(len, c.moods)] as const)
              : ([5, 'Waiting on your shelf'] as const)
    return [{ c, rank, reason, queuePosition: queued.get(c.id) ?? 0 }]
  })
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      (mood === 'light' ? lightMoodScore(b.c.moods) - lightMoodScore(a.c.moods) : 0) ||
      a.queuePosition - b.queuePosition ||
      a.c.createdAt.getTime() - b.c.createdAt.getTime() ||
      a.c.id.localeCompare(b.c.id),
  )
  // the card's series is the work's first one: one pick per series, the lowest position, before the list is cut
  const cardSeries = (workId: string) => seriesRows.find((r) => r.workId === workId)
  const top = onePerSeries(ranked, (r) => ({ series: cardSeries(r.c.id)?.name ?? null, position: cardSeries(r.c.id)?.position ?? null })).slice(0, WHAT_NEXT.maxPerList)
  const cards = new Map((await getWorkCards(db, scope, top.map((r) => r.c.id))).map((c) => [c.id, c]))
  return top.flatMap(({ c, reason }): WhatNextPick[] => {
    const card = cards.get(c.id)
    if (!card) return []
    return [
      {
        key: `work:${c.id}`,
        source: 'shelf',
        reason,
        workId: c.id,
        hardcoverId: null,
        title: card.title,
        kind: card.kind,
        authors: card.authors,
        authorRefs: authorRows.filter((a) => a.workId === c.id).map((a) => ({ name: a.name, contributorId: a.contributorId, hardcoverAuthorId: null })),
        seriesName: card.series?.name ?? null,
        position: card.series?.position ?? null,
        pages: c.pages,
        audioSec: c.audioSec,
        coverAssetId: card.coverAssetId,
        imageUrl: null,
        formats: c.formats,
        audiobook: c.formats.includes('audiobook') ? 'yes' : 'no',
        onWishlist: wished.has(c.id),
        firstUnread: null,
      },
    ]
  })
}

// ---------- exploration ----------

/** A Hardcover book that might be picked, before its cached details are looked up. */
interface Candidate {
  id: number
  reason: string
  /** what the series or author list knows about it, for when no details are cached */
  listed: { title: string; position: number | null; releaseDate: string | null } | null
  seriesName?: string
  position?: number | null
  /** the Hardcover series the candidate was found in */
  hardcoverSeriesId?: number
}

interface Exploration {
  series: (Candidate & { seriesId: string })[]
  author: Candidate[]
  hardcover: Candidate[]
  similar: Candidate[]
}

const nobody: Exploration = { series: [], author: [], hardcover: [], similar: [] }

/** Hardcover ids this person must not be offered: books of the library (held or read), their Hardcover Read list, and works they read. */
async function loadExclusions(db: Db, scope: UserScope, readIds: number[]): Promise<{ excluded: Set<number>; wishedWork: Map<number, string> }> {
  // written out: drizzle drops the table qualifier in a single-table select, and the subqueries have a work_id of their own
  const bookWork = sql`"hardcover_book"."work_id"`
  const rows = await db
    .select({
      id: hardcoverBooks.hardcoverId,
      workId: hardcoverBooks.workId,
      held: sql<boolean>`exists (select 1 from ${editions} where ${editions.workId} = ${bookWork})`,
      read: sql<boolean>`exists (select 1 from ${userWorks} where ${userWorks.userId} = ${scope.userId} and ${userWorks.workId} = ${bookWork} and ${userWorks.status} = 'read')`,
      wished: sql<boolean>`exists (select 1 from ${wishes} where ${wishes.userId} = ${scope.userId} and ${wishes.workId} = ${bookWork})`,
    })
    .from(hardcoverBooks)
    .where(and(inArray(hardcoverBooks.match, MATCHED), isNotNull(hardcoverBooks.hardcoverId)))
  // a work without a copy that is only wished is not "in the library" yet: it stays offerable, with its Wishlist badge
  const excluded = new Set([...readIds, ...rows.flatMap((r) => (r.id !== null && (r.held || r.read) ? [r.id] : []))])
  const wishedWork = new Map(rows.flatMap((r) => (r.id !== null && r.wished ? [[r.id, r.workId] as const] : [])))
  return { excluded, wishedWork }
}

/** A visible work the person holds, read or wishes, with every title, author name and series the app knows for it. */
interface LibraryWork {
  workId: string
  held: boolean
  read: boolean
  titles: string[]
  authors: string[]
  series: string[]
}

/**
 * The visible works that matter for hiding a pick (held, read by this person, or wished by them), loaded once per page. Hardcover
 * links alone miss a work that is unmatched or matched to another entry of the same book, so picks are also compared by title and author.
 */
async function loadLibraryWorks(db: Db, scope: UserScope): Promise<LibraryWork[]> {
  const [workRows, editionRows, readRows, wishRows] = await Promise.all([
    db.select({ id: works.id, title: works.title }).from(works).where(scope.visible).orderBy(asc(works.id)),
    db.select({ workId: editions.workId, title: editions.title }).from(editions).innerJoin(works, eq(works.id, editions.workId)).where(scope.visible),
    db.select({ workId: userWorks.workId }).from(userWorks).where(and(eq(userWorks.userId, scope.userId), eq(userWorks.status, 'read'))),
    db.select({ workId: wishes.workId }).from(wishes).where(eq(wishes.userId, scope.userId)),
  ])
  const held = new Set(editionRows.map((e) => e.workId))
  const read = new Set(readRows.map((r) => r.workId))
  const wished = new Set(wishRows.map((w) => w.workId))
  const relevant = workRows.filter((w) => held.has(w.id) || read.has(w.id) || wished.has(w.id))
  if (relevant.length === 0) return []
  const ids = relevant.map((w) => w.id)
  const [nameRows, seriesRows, allTitles] = await Promise.all([
    db
      .select({ workId: workContributors.workId, name: contributorNames.name })
      .from(workContributors)
      .innerJoin(contributorNames, eq(contributorNames.contributorId, workContributors.contributorId))
      .where(inArray(workContributors.workId, ids)),
    db
      // every name of the series, so a Hardcover (English) series name matches whichever name is primary (#145)
      .select({ workId: workSeries.workId, name: seriesNames.name })
      .from(workSeries)
      .innerJoin(seriesNames, eq(seriesNames.seriesId, workSeries.seriesId))
      .where(inArray(workSeries.workId, ids)),
    titlesOfWorks(db, ids),
  ])
  const group = <R extends { workId: string }, V>(rows: R[], pick: (r: R) => V | null): Map<string, V[]> => {
    const by = new Map<string, V[]>()
    for (const r of rows) {
      const v = pick(r)
      if (v !== null) by.set(r.workId, [...(by.get(r.workId) ?? []), v])
    }
    return by
  }
  const editionTitles = group(editionRows, (e) => e.title)
  const authorsOf = group(nameRows, (n) => n.name)
  const seriesOf = group(seriesRows, (s) => s.name)
  return relevant.map((w) => ({
    workId: w.id,
    held: held.has(w.id),
    read: read.has(w.id),
    titles: [...new Set([w.title, ...(allTitles.get(w.id) ?? []), ...(editionTitles.get(w.id) ?? [])])],
    authors: [...new Set(authorsOf.get(w.id) ?? [])],
    series: [...new Set(seriesOf.get(w.id) ?? [])],
  }))
}

/** The library work a pick is the same book as, by title and author: held or read ones first (they hide the pick), else a wished one. */
type LibraryMatcher = (book: { title: string; authors: string[]; seriesName: string | null }) => { hide: boolean; wishedWork: string | null }

function libraryMatcher(libraryWorks: LibraryWork[]): LibraryMatcher {
  const find = titleAuthorIndex(libraryWorks)
  return (book) => {
    const same = find({ title: book.title, authors: book.authors, series: book.seriesName === null ? [] : [book.seriesName] })
    return { hide: same.some((w) => w.held || w.read), wishedWork: same[0]?.workId ?? null }
  }
}

/** The next book of each series the person is in, from the cached Hardcover series (never one that is in the library or read). */
async function seriesCandidates(db: Db, scope: UserScope, reads: SeriesRead[], readList: Set<number>, isExcluded: (id: number) => boolean): Promise<Exploration['series']> {
  const [groups, hiddenSeries] = await Promise.all([memberSeries(db, scope.languages, scope.userId), listHiddenContinuations(db, scope)])
  const hidden = new Set(hiddenSeries)
  const wanted = groups.flatMap((g) => (hidden.has(g.seriesId) ? [] : [{ group: g, entry: hardcoverSeriesOf(g).entry }]))
  const ids = wanted.flatMap((w) => (w.entry ? [w.entry.id] : []))
  if (ids.length === 0) return []
  const rows = await db.select().from(hardcoverSeries).where(inArray(hardcoverSeries.hardcoverSeriesId, ids))
  const out: Exploration['series'] = []
  for (const { group, entry } of wanted) {
    const row = rows.find((r) => r.hardcoverSeriesId === entry?.id)
    if (!row) continue
    // read in the library, or on the person's Hardcover Read list (a cached book at its Hardcover position)
    const readPositions = [
      ...reads.flatMap((r) => (r.seriesId === group.seriesId && r.status === 'read' && r.position !== null ? [r.position] : [])),
      ...row.books.flatMap((b) => (b.position !== null && readList.has(b.id) ? [b.position] : [])),
    ]
    const position = nextPosition(
      readPositions,
      row.books.flatMap((b) => (b.position === null ? [] : [b.position])),
    )
    const book = position === null ? undefined : row.books.find((b) => b.position === position)
    if (!book || isExcluded(book.id)) continue
    out.push({ id: book.id, seriesId: group.seriesId, seriesName: group.name, position, hardcoverSeriesId: row.hardcoverSeriesId, listed: { title: book.title, position, releaseDate: book.releaseDate }, reason: `Next in ${group.name} (#${position})` })
  }
  return out
}

async function authorCandidates(db: Db, today: string, favorites: FavoriteView[], isExcluded: (id: number) => boolean): Promise<Candidate[]> {
  const ids = [...new Set(favorites.flatMap((f) => (f.hardcoverAuthorId === null ? [] : [f.hardcoverAuthorId])))]
  if (ids.length === 0) return []
  const rows = await db.select().from(hardcoverAuthors).where(inArray(hardcoverAuthors.hardcoverAuthorId, ids))
  const from = shift(today, 'month', -WHAT_NEXT.newPastMonths)
  const to = shift(today, 'month', WHAT_NEXT.newFutureMonths)
  const found = new Map<number, Candidate & { releaseDate: string }>()
  for (const f of favorites) {
    const row = rows.find((r) => r.hardcoverAuthorId === f.hardcoverAuthorId)
    for (const b of row?.bookIds ?? []) {
      if (!b.releaseDate || b.releaseDate < from || b.releaseDate > to || isExcluded(b.id) || found.has(b.id)) continue
      const reason = b.releaseDate > today ? `Coming ${b.releaseDate}` : `New from ${f.name} · ${b.releaseDate.slice(0, 4)}`
      found.set(b.id, { id: b.id, reason, releaseDate: b.releaseDate, listed: { title: b.title, position: null, releaseDate: b.releaseDate } })
    }
  }
  return [...found.values()].sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.id - b.id)
}

/** Everything the exploration lists could show, from the cache only; none of it calls Hardcover. */
async function explore(db: Db, scope: UserScope, input: { today: string; reads: SeriesRead[]; favorites: FavoriteView[]; last: LastFinished | null; personalAccountId: string | null }) {
  const { personalAccountId } = input
  const [readRow, recRow] = personalAccountId
    ? await Promise.all([
        db.select({ ids: hardcoverReads.bookIds }).from(hardcoverReads).where(eq(hardcoverReads.accountId, personalAccountId)),
        db.select({ ids: hardcoverRecommendations.hardcoverIds }).from(hardcoverRecommendations).where(eq(hardcoverRecommendations.accountId, personalAccountId)),
      ]).then(([a, b]) => [a[0], b[0]] as const)
    : [undefined, undefined]
  const { excluded, wishedWork } = await loadExclusions(db, scope, readRow?.ids ?? [])
  const isExcluded = (id: number) => excluded.has(id)
  const [seriesList, author] = await Promise.all([seriesCandidates(db, scope, input.reads, new Set(readRow?.ids ?? []), isExcluded), authorCandidates(db, input.today, input.favorites, isExcluded)])
  const listedIds = (ids: number[], reason: string): Candidate[] => ids.filter((id) => !isExcluded(id)).map((id) => ({ id, reason, listed: null }))
  const exploration: Exploration = {
    series: seriesList,
    author,
    hardcover: listedIds(recRow?.ids ?? [], 'Hardcover recommends'),
    similar: input.last ? listedIds(input.last.similarIds, `Like ${input.last.title}`) : [],
  }
  return { exploration, wishedWork }
}

/** A Hardcover pick that is a wished work of the library carries that work's kind. */
async function withWishedKinds(db: Db, scope: UserScope, picks: WhatNextPick[]): Promise<void> {
  const ids = [...new Set(picks.flatMap((p) => (p.workId === null ? [] : [p.workId])))]
  if (ids.length === 0) return
  const rows = await db.select({ id: works.id, kind: works.kind }).from(works).where(and(inArray(works.id, ids), scope.visible))
  const kinds = new Map(rows.map((r) => [r.id, r.kind]))
  for (const p of picks) if (p.workId !== null) p.kind = kinds.get(p.workId) ?? 'book'
}

type ExternalRow = typeof hardcoverExternalBooks.$inferSelect

function explorePick(source: PickSource, c: Candidate, ext: ExternalRow | undefined, wishedWork: string | undefined, contributorOf: Map<string, string>): WhatNextPick | null {
  const title = ext?.title ?? c.listed?.title
  if (title === undefined) return null
  return {
    key: `hc:${c.id}`,
    source,
    reason: c.reason,
    workId: wishedWork ?? null,
    hardcoverId: c.id,
    title,
    // a wished work's own kind is filled in by withWishedKinds
    kind: 'book',
    authors: ext?.authors ?? [],
    // authors and author_ids are parallel lists; a name the library knows also carries its contributor
    authorRefs: (ext?.authors ?? []).map((name, i) => ({ name, contributorId: contributorOf.get(normalizeText(name)) ?? null, hardcoverAuthorId: ext?.authorIds[i] ?? null })),
    seriesName: c.seriesName ?? ext?.seriesName ?? null,
    position: c.position !== undefined ? c.position : (ext?.position ?? c.listed?.position ?? null),
    pages: ext?.pages ?? null,
    audioSec: null,
    coverAssetId: null,
    imageUrl: ext?.imageUrl ?? null,
    formats: ext?.hasAudiobook ? ['audiobook'] : [],
    audiobook: ext?.hasAudiobook === true ? 'yes' : ext?.hasAudiobook === false ? 'no' : 'unknown',
    onWishlist: wishedWork !== undefined,
    firstUnread: null,
  }
}

/** The key a series is compared by across lists; null for a pick without one. */
const seriesKeyOf = (name: string | null) => (name === null ? null : normalizeText(name) || null)

/**
 * The exploration lists. "taken" holds the series the shelf already shows: a series shows in one list only, so a pick in one of
 * them is dropped before each list is cut to size. The Hardcover series each pick sits in (for its "first unread" line) is returned too.
 */
async function explorePicks(
  db: Db,
  scope: UserScope,
  exploration: Exploration,
  wishedWork: Map<number, string>,
  hidden: Set<string>,
  mood: WhatNextMood,
  format: WhatNextFormat,
  taken: Set<string>,
): Promise<{ lists: Map<PickSource, WhatNextPick[]>; hardcoverSeriesOf: Map<string, number> }> {
  const ids = [...new Set([...exploration.series, ...exploration.author, ...exploration.hardcover, ...exploration.similar].map((c) => c.id))]
  const ext = new Map((ids.length === 0 ? [] : await db.select().from(hardcoverExternalBooks).where(inArray(hardcoverExternalBooks.hardcoverId, ids))).map((e) => [e.hardcoverId, e]))
  const names = [...new Set([...ext.values()].flatMap((e) => e.authors.map(normalizeText)))]
  const contributorOf = new Map(
    (names.length === 0 ? [] : await db.select({ normalized: contributorNames.normalizedName, id: contributorNames.contributorId }).from(contributorNames).where(inArray(contributorNames.normalizedName, names))).map((r) => [r.normalized, r.id]),
  )
  // only a candidate with cached details is compared by title, so without any there is nothing to load
  const matchLibrary = libraryMatcher(ext.size === 0 ? [] : await loadLibraryWorks(db, scope))
  const seen = new Set<number>()
  const out = new Map<PickSource, WhatNextPick[]>()
  const hardcoverSeriesIds = new Map<string, number>()
  for (const source of ['series', 'author', 'hardcover', 'similar'] as const) {
    // a list this mood hides is not a list that shows: it must not take books or series from the ones that do
    if (!MOODS_FOR[source].includes(mood)) continue
    const picks: { pick: WhatNextPick; moods: string[] }[] = []
    for (const c of exploration[source]) {
      const details = ext.get(c.id)
      if (hidden.has(`hc:${c.id}`) || seen.has(c.id) || (format === 'audio' && details?.hasAudiobook === false)) continue
      const moods = details?.tags.mood ?? []
      if (mood === 'light' && !isLight({ pages: details?.pages ?? null, audioSec: null }, moods)) continue
      // by title and author too: a library work without this Hardcover id (unmatched, or matched to another entry of the book) is still the book
      const same = details ? matchLibrary({ title: details.title, authors: details.authors, seriesName: c.seriesName ?? details.seriesName }) : null
      if (same?.hide) continue
      const pick = explorePick(source, c, details, wishedWork.get(c.id) ?? same?.wishedWork ?? undefined, contributorOf)
      if (pick) {
        picks.push({ pick, moods })
        const hcSeries = c.hardcoverSeriesId ?? displayedSeriesEntry(pick.seriesName, details?.series ?? [])?.id
        if (hcSeries !== undefined) hardcoverSeriesIds.set(pick.key, hcSeries)
      }
    }
    if (mood === 'light') picks.sort((a, b) => lightMoodScore(b.moods) - lightMoodScore(a.moods))
    const open = picks.filter(({ pick }) => !taken.has(seriesKeyOf(pick.seriesName) ?? ''))
    const shown = onePerSeries(open, ({ pick }) => ({ series: pick.seriesName, position: pick.position }))
      .slice(0, WHAT_NEXT.maxPerList)
      .map((p) => p.pick)
    for (const p of shown) {
      if (p.hardcoverId !== null) seen.add(p.hardcoverId)
      const key = seriesKeyOf(p.seriesName)
      if (key !== null) taken.add(key)
    }
    out.set(source, shown)
  }
  await withWishedKinds(db, scope, [...out.values()].flat())
  return { lists: out, hardcoverSeriesOf: hardcoverSeriesIds }
}

/** The earlier unread book the "first unread" line names, for each pick that sits in a series at a known position. */
async function withFirstUnread(db: Db, scope: UserScope, lists: { source: PickSource; picks: WhatNextPick[] }[], hardcoverSeriesIds: Map<string, number>, personalAccountId: string | null): Promise<void> {
  const picks = lists.flatMap((l) => l.picks).filter((p) => p.seriesName !== null && p.position !== null)
  if (picks.length === 0) return
  // a shelf pick's series is the work's first local one
  const shelfWorkIds = picks.flatMap((p) => (p.source === 'shelf' && p.workId !== null ? [p.workId] : []))
  const firstSeries = new Map<string, string>()
  if (shelfWorkIds.length > 0) {
    const rows = await db.select({ workId: workSeries.workId, seriesId: workSeries.seriesId }).from(workSeries).where(inArray(workSeries.workId, shelfWorkIds)).orderBy(asc(workSeries.sortIndex))
    for (const r of rows) if (!firstSeries.has(r.workId)) firstSeries.set(r.workId, r.seriesId)
  }
  const localIds = [...new Set(firstSeries.values())]
  const [localRows, groups] = await Promise.all([
    localIds.length === 0
      ? []
      : db
          .select({ seriesId: workSeries.seriesId, title: shownTitleField(works.id, scope.languages, 'title'), position: workSeries.position, positionEnd: workSeries.positionEnd, status: userWorks.status, hardcoverId: hardcoverBooks.hardcoverId })
          .from(workSeries)
          .innerJoin(works, eq(works.id, workSeries.workId))
          .leftJoin(userWorks, and(eq(userWorks.workId, works.id), eq(userWorks.userId, scope.userId)))
          .leftJoin(hardcoverBooks, and(eq(hardcoverBooks.workId, works.id), inArray(hardcoverBooks.match, MATCHED)))
          .where(and(inArray(workSeries.seriesId, localIds), scope.visible)),
    matchedSeries(db, scope.languages, localIds),
  ])
  // the cached Hardcover series of each local one (when its books name one), and of each Hardcover pick
  const hcOfLocal = new Map(
    groups.flatMap((g) => {
      const entry = hardcoverSeriesOf(g).entry
      return entry ? [[g.seriesId, entry.id] as const] : []
    }),
  )
  const hcIds = [...new Set([...hcOfLocal.values(), ...picks.flatMap((p) => hardcoverSeriesIds.get(p.key) ?? [])])]
  // the Read list also covers library works matched to a listed id, so it is read whether or not a cached series is
  const [hcRows, readRow, readWorks] = await Promise.all([
    hcIds.length === 0 ? [] : db.select().from(hardcoverSeries).where(inArray(hardcoverSeries.hardcoverSeriesId, hcIds)),
    personalAccountId === null ? undefined : db.select({ ids: hardcoverReads.bookIds }).from(hardcoverReads).where(eq(hardcoverReads.accountId, personalAccountId)).then((r) => r[0]),
    hcIds.length === 0
      ? []
      : db
          .select({ id: hardcoverBooks.hardcoverId })
          .from(hardcoverBooks)
          .innerJoin(userWorks, and(eq(userWorks.workId, hardcoverBooks.workId), eq(userWorks.userId, scope.userId), eq(userWorks.status, 'read')))
          .where(and(inArray(hardcoverBooks.match, MATCHED), isNotNull(hardcoverBooks.hardcoverId))),
  ])
  const read = new Set([...(readRow?.ids ?? []), ...readWorks.flatMap((r) => (r.id === null ? [] : [r.id]))])
  const cached = (hcId: number | undefined) => hcRows.find((r) => r.hardcoverSeriesId === hcId)?.books ?? []
  for (const pick of picks) {
    if (pick.source === 'shelf') {
      const localId = pick.workId === null ? undefined : firstSeries.get(pick.workId)
      if (localId === undefined) continue
      const local = localRows.filter((r) => r.seriesId === localId)
      // the library's own books are the last word on the positions they cover; Hardcover fills in the rest
      const covered = (p: number) => local.some((l) => l.position !== null && p >= l.position && p <= (l.positionEnd ?? l.position))
      const books = [
        ...local.map((l) => ({ title: l.title, position: l.position, positionEnd: l.positionEnd, read: l.status === 'read' || (l.hardcoverId !== null && read.has(l.hardcoverId)) })),
        ...cached(hcOfLocal.get(localId)).flatMap((b) => (b.position === null || covered(b.position) ? [] : [{ title: b.title, position: b.position, read: read.has(b.id) }])),
      ]
      pick.firstUnread = firstUnreadBook(books, pick.position)
    } else {
      pick.firstUnread = firstUnreadBook(
        cached(hardcoverSeriesIds.get(pick.key)).map((b) => ({ title: b.title, position: b.position, read: read.has(b.id) })),
        pick.position,
      )
    }
  }
}

// ---------- the page ----------

function withoutSimilar(l: LastFinished): WhatNextLastFinished {
  return { workId: l.workId, title: l.title, authors: l.authors, coverAssetId: l.coverAssetId, pages: l.pages, audioSec: l.audioSec, moods: l.moods, heavy: l.heavy, finishedOn: l.finishedOn }
}

async function loadHidden(db: Db, scope: UserScope): Promise<Set<string>> {
  const rows = await db.select({ key: whatNextHidden.pickKey }).from(whatNextHidden).where(eq(whatNextHidden.userId, scope.userId))
  return new Set(rows.map((r) => r.key))
}

export async function getWhatNext(db: Db, scope: UserScope, input: WhatNextInput): Promise<WhatNextView> {
  const [prefs, household, personal, hidden, reads, last, favorites] = await Promise.all([
    db.select().from(whatNextPrefs).where(eq(whatNextPrefs.userId, scope.userId)).then((r) => r[0]),
    getHardcoverAccount(db, { kind: 'household' }),
    getHardcoverAccount(db, { kind: 'user', userId: scope.userId }),
    loadHidden(db, scope),
    loadSeriesReads(db, scope),
    loadLastFinished(db, scope, input.today),
    loadFavorites(db, scope),
  ])
  const exploreEnabled = household?.status === 'ok'
  const format = input.format ?? prefs?.format ?? 'audio'
  const { exploration, wishedWork } = exploreEnabled ? await explore(db, scope, { today: input.today, reads, favorites, last, personalAccountId: personal?.id ?? null }) : { exploration: nobody, wishedWork: new Map<number, string>() }

  // "mid-series": the finished book's series has a next book, in the library or (not yet owned) on Hardcover
  let nextInSeries: { hooked: boolean } | null = null
  if (last) {
    const [memberships, continuations] = await Promise.all([
      db.select({ seriesId: workSeries.seriesId }).from(workSeries).where(eq(workSeries.workId, last.workId)).orderBy(asc(workSeries.sortIndex)),
      getContinuationForWork(db, scope, last.workId),
    ])
    const hasNext = new Set([...continuations.map((c) => c.seriesId), ...exploration.series.map((c) => c.seriesId)])
    const seriesId = memberships.find((m) => hasNext.has(m.seriesId))?.seriesId
    if (seriesId) nextInSeries = { hooked: isHooked(reads.filter((r) => r.seriesId === seriesId && r.status === 'read')) }
  }
  const preselected = preselectMood({ lastFinished: last, nextInSeries })
  const mood = input.mood ?? preselected

  // lists are owned in page order: the shelf first, and its series are not shown again below
  const shelf = await shelfPicks(db, scope, mood, format, hidden, favorites)
  const explored = await explorePicks(db, scope, exploration, wishedWork, hidden, mood, format, new Set(shelf.flatMap((p) => seriesKeyOf(p.seriesName) ?? [])))
  const lists = SOURCES.flatMap((source) => {
    const picks = source === 'shelf' ? shelf : (explored.lists.get(source) ?? [])
    return MOODS_FOR[source].includes(mood) && picks.length > 0 ? [{ source, picks }] : []
  })
  await withFirstUnread(db, scope, lists, explored.hardcoverSeriesOf, personal?.id ?? null)
  return {
    lastFinished: last ? withoutSimilar(last) : null,
    preselected,
    lists,
    exploreEnabled,
    personalLinked: personal?.status === 'ok',
    format,
    aiAnswer: prefs?.aiAnswer != null && prefs.aiPastedAt != null ? { text: prefs.aiAnswer, pastedAt: prefs.aiPastedAt } : null,
    favoriteAuthors: favorites,
  }
}

// ---------- the Ask AI prompt ----------

interface ReadBook {
  workId: string
  title: string
  rating: number | null
  /** other titles of its editions */
  otherTitles: string[]
  /** the credited names, then every other name of those people */
  authors: string[]
  aliases: string[]
}

/** This person's read works, newest finish first. */
async function readBooks(db: Db, scope: UserScope): Promise<ReadBook[]> {
  const rows = await db
    .select({ workId: works.id, title: shownTitleField(works.id, scope.languages, 'title'), primaryTitle: works.title, rating: userWorks.rating })
    .from(userWorks)
    .innerJoin(works, eq(works.id, userWorks.workId))
    .where(and(eq(userWorks.userId, scope.userId), eq(userWorks.status, 'read')))
    .orderBy(
      desc(sql`coalesce((select max(${readingSessions.updatedAt}) from ${readingSessions} where ${readingSessions.userId} = ${scope.userId} and ${readingSessions.workId} = ${works.id} and ${readingSessions.outcome} = 'finished'), ${userWorks.updatedAt})`),
      asc(works.id),
    )
  const ids = rows.map((r) => r.workId)
  if (ids.length === 0) return []
  const [titleRows, nameRows, allTitles] = await Promise.all([
    db.select({ workId: editions.workId, title: editions.title }).from(editions).where(and(inArray(editions.workId, ids), isNotNull(editions.title))),
    db
      .select({ workId: workContributors.workId, primary: contributors.name, name: contributorNames.name })
      .from(workContributors)
      .innerJoin(contributors, eq(contributors.id, workContributors.contributorId))
      .innerJoin(contributorNames, eq(contributorNames.contributorId, workContributors.contributorId))
      .where(inArray(workContributors.workId, ids))
      .orderBy(asc(workContributors.position), asc(contributorNames.name)),
    titlesOfWorks(db, ids),
  ])
  return rows.map(({ primaryTitle, ...r }) => {
    const names = nameRows.filter((n) => n.workId === r.workId)
    // the picked title is the book's name for this reader; every other title it has still matches an answer
    const others = [primaryTitle, ...(allTitles.get(r.workId) ?? []), ...titleRows.flatMap((t) => (t.workId === r.workId && t.title !== null ? [t.title] : []))]
    return {
      ...r,
      otherTitles: [...new Set(others.filter((t) => t !== r.title))],
      authors: [...new Set(names.map((n) => n.primary))],
      aliases: [...new Set(names.map((n) => n.name))],
    }
  })
}

/** Every title and author name the app knows for each read work (original titles, author aliases), newest finish first: what the AI answer is checked against. */
export async function readTitlesFor(db: Db, scope: UserScope): Promise<{ title: string; authors: string[] }[]> {
  const books = await readBooks(db, scope)
  return books.flatMap((b) => [b.title, ...b.otherTitles].map((title) => ({ title, authors: b.aliases })))
}

export async function promptInputFor(db: Db, scope: UserScope, mood: WhatNextMood, format: WhatNextFormat, today: string = new Date().toISOString().slice(0, 10)): Promise<WhatNextPromptInput> {
  const [books, last, favorites, reads, hiddenSeries] = await Promise.all([readBooks(db, scope), loadLastFinished(db, scope, today), loadFavorites(db, scope), loadSeriesReads(db, scope), listHiddenContinuations(db, scope)])
  const [lastRating] = last ? await db.select({ rating: userWorks.rating }).from(userWorks).where(and(eq(userWorks.userId, scope.userId), eq(userWorks.workId, last.workId))) : []
  const seriesIds = [...new Set(reads.map((r) => r.seriesId))].filter((id) => !hiddenSeries.includes(id))
  const inSeries = seriesIds.length === 0 ? [] : await db.select({ seriesId: workSeries.seriesId, position: workSeries.position }).from(workSeries).innerJoin(works, eq(works.id, workSeries.workId)).where(and(inArray(workSeries.seriesId, seriesIds), scope.visible))
  const seriesInProgress = seriesIds.flatMap((seriesId) => {
    const mine = reads.filter((r) => r.seriesId === seriesId)
    const next = nextPosition(
      mine.flatMap((r) => (r.status === 'read' && r.position !== null ? [r.position] : [])),
      inSeries.flatMap((s) => (s.seriesId === seriesId && s.position !== null ? [s.position] : [])),
    )
    return next === null ? [] : [{ series: mine[0]?.seriesName ?? '', nextPosition: next }]
  })
  return {
    mood,
    format,
    lastFinished: last ? { title: last.title, authors: last.authors, rating: lastRating?.rating ?? null } : null,
    seriesInProgress,
    favoriteAuthors: favorites.map((f) => f.name),
    topRated: books
      .flatMap((b) => (b.rating === null ? [] : [{ title: b.title, authors: b.authors, rating: b.rating }]))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, WHAT_NEXT.promptTopRated),
    read: books.map((b) => ({ title: b.title, authors: b.authors })),
  }
}

export async function hidePick(db: Db, scope: UserScope, key: string): Promise<void> {
  await db.insert(whatNextHidden).values({ userId: scope.userId, pickKey: key }).onConflictDoNothing()
}

export async function unhidePick(db: Db, scope: UserScope, key: string): Promise<void> {
  await db.delete(whatNextHidden).where(and(eq(whatNextHidden.userId, scope.userId), eq(whatNextHidden.pickKey, key)))
}

/** Follow or unfollow an author (a library contributor or a Hardcover author); null removes the row, back to the automatic behavior. */
export async function setAuthorFollow(
  db: Db,
  scope: UserScope,
  author: { contributorId: string } | { hardcoverAuthorId: number; name: string },
  mode: 'follow' | 'unfollow' | null,
): Promise<void> {
  if ('contributorId' in author) {
    const { contributorId } = author
    if (mode === null) {
      await db.delete(authorFollows).where(and(eq(authorFollows.userId, scope.userId), eq(authorFollows.contributorId, contributorId)))
      return
    }
    const [person] = await db.select({ name: contributors.name }).from(contributors).where(eq(contributors.id, contributorId))
    if (!person) throw notFound('Author')
    await db
      .insert(authorFollows)
      .values({ userId: scope.userId, contributorId, mode, name: person.name })
      .onConflictDoUpdate({ target: [authorFollows.userId, authorFollows.contributorId], targetWhere: sql`${authorFollows.contributorId} is not null`, set: { mode } })
    return
  }
  const { hardcoverAuthorId, name } = author
  if (mode === null) {
    await db.delete(authorFollows).where(and(eq(authorFollows.userId, scope.userId), eq(authorFollows.hardcoverAuthorId, hardcoverAuthorId)))
    return
  }
  await db
    .insert(authorFollows)
    .values({ userId: scope.userId, hardcoverAuthorId, mode, name })
    .onConflictDoUpdate({ target: [authorFollows.userId, authorFollows.hardcoverAuthorId], targetWhere: sql`${authorFollows.hardcoverAuthorId} is not null`, set: { mode, name } })
}

export async function listAuthorFollows(db: Db, scope: UserScope): Promise<{ contributorId: string | null; hardcoverAuthorId: number | null; name: string; mode: 'follow' | 'unfollow' }[]> {
  return db
    .select({ contributorId: authorFollows.contributorId, hardcoverAuthorId: authorFollows.hardcoverAuthorId, name: authorFollows.name, mode: authorFollows.mode })
    .from(authorFollows)
    .where(eq(authorFollows.userId, scope.userId))
    .orderBy(asc(authorFollows.name), asc(authorFollows.id))
}

export async function saveWhatNextFormat(db: Db, scope: UserScope, format: WhatNextFormat): Promise<void> {
  await db
    .insert(whatNextPrefs)
    .values({ userId: scope.userId, format })
    .onConflictDoUpdate({ target: whatNextPrefs.userId, set: { format, updatedAt: new Date() } })
}

/** Store the pasted AI answer for this person; null clears it. */
export async function saveAiAnswer(db: Db, scope: UserScope, text: string | null, now: Date): Promise<void> {
  const set = { aiAnswer: text, aiPastedAt: text === null ? null : now, updatedAt: now }
  await db
    .insert(whatNextPrefs)
    .values({ userId: scope.userId, ...set })
    .onConflictDoUpdate({ target: whatNextPrefs.userId, set })
}

/** The titles and authors this person has wished for, every title and author alias as separate entries (like readTitlesFor). */
export async function wishedTitles(db: Db, scope: UserScope): Promise<{ title: string; authors: string[] }[]> {
  const rows = await db
    .select({ workId: works.id, title: shownTitleField(works.id, scope.languages, 'title'), primaryTitle: works.title })
    .from(wishes)
    .innerJoin(works, eq(works.id, wishes.workId))
    .where(eq(wishes.userId, scope.userId))
    .orderBy(desc(wishes.createdAt), asc(works.id))
  const ids = rows.map((r) => r.workId)
  if (ids.length === 0) return []
  const [titleRows, nameRows, allTitles] = await Promise.all([
    db.select({ workId: editions.workId, title: editions.title }).from(editions).where(and(inArray(editions.workId, ids), isNotNull(editions.title))),
    db
      .select({ workId: workContributors.workId, name: contributorNames.name })
      .from(workContributors)
      .innerJoin(contributorNames, eq(contributorNames.contributorId, workContributors.contributorId))
      .where(inArray(workContributors.workId, ids)),
    titlesOfWorks(db, ids),
  ])
  return rows.flatMap((r) => {
    const authors = [...new Set(nameRows.flatMap((n) => (n.workId === r.workId ? [n.name] : [])))]
    const others = [r.primaryTitle, ...(allTitles.get(r.workId) ?? []), ...titleRows.flatMap((x) => (x.workId === r.workId && x.title !== null ? [x.title] : []))]
    const titles = [r.title, ...new Set(others.filter((t) => t !== r.title))]
    return titles.map((title) => ({ title, authors }))
  })
}

/** A visible work already standing for this book: by its Hardcover id, else by the same title and author. */
async function findWorkFor(tx: Db, scope: UserScope, book: { hardcoverId: number | null; title: string; authors: string[]; seriesName: string | null }): Promise<string | null> {
  if (book.hardcoverId !== null) {
    const [linked] = await tx
      .select({ workId: hardcoverBooks.workId })
      .from(hardcoverBooks)
      .innerJoin(works, eq(works.id, hardcoverBooks.workId))
      .where(and(eq(hardcoverBooks.hardcoverId, book.hardcoverId), scope.visible))
      .orderBy(asc(hardcoverBooks.workId))
      .limit(1)
    if (linked) return linked.workId
  }
  // sameTitleAndAuthor normalizes both sides in JS, so compare against every visible work (a household library is small)
  const [titleRows, nameRows, seriesRows] = await Promise.all([
    tx.select({ id: works.id, title: works.title }).from(works).where(scope.visible).orderBy(asc(works.id)),
    tx
      .select({ workId: workContributors.workId, name: contributorNames.name })
      .from(workContributors)
      .innerJoin(contributorNames, eq(contributorNames.contributorId, workContributors.contributorId))
      .innerJoin(works, eq(works.id, workContributors.workId))
      .where(scope.visible),
    tx
      // every name of the series, so a Hardcover (English) series name matches whichever name is primary (#145)
      .select({ workId: workSeries.workId, name: seriesNames.name })
      .from(workSeries)
      .innerJoin(seriesNames, eq(seriesNames.seriesId, workSeries.seriesId))
      .innerJoin(works, eq(works.id, workSeries.workId))
      .where(scope.visible),
  ])
  const allTitles = await titlesOfWorks(tx, titleRows.map((w) => w.id))
  const theirs = { title: book.title, authors: book.authors, series: book.seriesName === null ? [] : [book.seriesName] }
  // a title in any language names the book (#145)
  const found = titleRows.find((w) =>
    [...new Set([w.title, ...(allTitles.get(w.id) ?? [])])].some((title) =>
      sameTitleAndAuthor(
        { title, authors: nameRows.flatMap((n) => (n.workId === w.id ? [n.name] : [])), series: seriesRows.flatMap((s) => (s.workId === w.id ? [s.name] : [])) },
        theirs,
      ),
    ),
  )
  return found?.id ?? null
}

function blankPage(provider: string, url: string): WishPage {
  return { provider, url, publisher: null, translators: [], year: null, isbn13: null, isbn10: null, pageCount: null, language: null, coverUrl: null, volume: null, volumeCount: null }
}

/** Put an exploration pick on the person's Wishlist, on the library's own copy of the book when there is one. */
export async function wishFromPick(
  db: Db,
  scope: UserScope,
  input: { kind: 'hardcover'; hardcoverId: number; reason?: string } | { kind: 'ai'; pick: AiPick },
): Promise<{ workId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    let book: { hardcoverId: number | null; title: string; authors: string[]; seriesName: string | null; position: number | null }
    let page: WishPage | null
    let reason: string | null = null
    let aiKind: WorkKind = 'book'
    if (input.kind === 'hardcover') {
      const [row] = await tx.select().from(hardcoverExternalBooks).where(eq(hardcoverExternalBooks.hardcoverId, input.hardcoverId))
      if (!row) throw notFound('Book')
      book = { hardcoverId: row.hardcoverId, title: row.title, authors: row.authors, seriesName: row.seriesName, position: row.position }
      page = blankPage('hardcover', `https://hardcover.app/id/book/${row.hardcoverId}`)
      reason = input.reason ?? null
    } else {
      const { pick } = input
      book = { hardcoverId: null, title: pick.title, authors: pick.authors, seriesName: pick.series, position: pick.position }
      page = pick.url === null ? null : blankPage('ai', pick.url)
      reason = pick.reason
      aiKind = pick.kind
    }
    let workId = await findWorkFor(tx, scope, book)
    const created = workId === null
    if (workId === null) {
      workId = await createWishWork(tx, {
        title: book.title,
        authors: book.authors,
        series: book.seriesName === null ? null : { name: book.seriesName, position: book.position },
        language: null,
        description: null,
        aiKind,
      })
      if (book.hardcoverId !== null) await tx.insert(hardcoverBooks).values({ workId, hardcoverId: book.hardcoverId, match: 'manual' })
    } else {
      // a found work only takes the pick's kind while it is an unset book
      if (aiKind !== 'book') {
        const [found] = await tx.select({ kind: works.kind, provenance: works.provenance }).from(works).where(eq(works.id, workId)).for('update')
        if (found && autoKindApplies(found)) {
          await tx.update(works).set({ kind: aiKind, provenance: { ...found.provenance, kind: { origin: 'ai', at: new Date().toISOString(), locked: false } } }).where(eq(works.id, workId))
        }
      }
      if (book.hardcoverId !== null) {
        // an existing work found by title: link it so the pick shows as wished; a work already matched (or rejected) keeps its row
        const [link] = await tx.select({ match: hardcoverBooks.match }).from(hardcoverBooks).where(eq(hardcoverBooks.workId, workId))
        if (link === undefined) await tx.insert(hardcoverBooks).values({ workId, hardcoverId: book.hardcoverId, match: 'manual' })
        else if (link.match === 'none') await tx.update(hardcoverBooks).set({ hardcoverId: book.hardcoverId, match: 'manual' }).where(eq(hardcoverBooks.workId, workId))
      }
    }
    // no format by default: the person sets it on the Wishlist, and a second add leaves what they set alone (the note too, when there is one)
    const [existing] = await tx.select({ formats: wishes.formats, language: wishes.language, note: wishes.note }).from(wishes).where(and(eq(wishes.userId, scope.userId), eq(wishes.workId, workId)))
    await upsertWish(tx, scope, workId, { formats: existing?.formats ?? [], language: existing?.language ?? null, note: existing?.note?.trim() ? existing.note : reason }, page)
    return { workId, created }
  })
}
