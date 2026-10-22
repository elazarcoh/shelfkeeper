import { and, asc, count, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm'
import {
  deriveAvailability,
  mentionsAvailability,
  editionFormats,
  pickCoverAssetId,
  type EditionFormat,
  type LibraryEntry,
  type LibraryPage,
  type LibraryQuery,
  type SeriesGroupCard,
  type WorkCard,
} from '@mylib/domain'
import type { Db } from '../client'
import {
  contributorNames,
  contributors,
  editions,
  queueEntries,
  series,
  setItems,
  tags,
  userWorks,
  users,
  wishes,
  workContributors,
  workSearch,
  workSeries,
  workTags,
  works,
} from '../schema'
import { compileFilter } from './filter-sql'
import { shownWorkName } from './person-names'
import type { UserScope } from './scope'
import { buildSearch } from './search'
import { shownSeriesName } from './series-names'
import { shownTitleField } from './titles'
import { getSetForUser } from './sets'

async function setCondition(db: Db, scope: UserScope, setId: string): Promise<SQL> {
  const set = await getSetForUser(db, scope, setId)
  if (set.kind === 'smart' && set.filter) return compileFilter(set.filter, scope.userId)
  return sql`exists (select 1 from ${setItems} where ${setItems.setId} = ${set.id} and ${setItems.workId} = ${works.id})`
}

/** The work's first series (by its own series order), correlated to "work"."id". */
const firstSeriesId = sql`(select ${workSeries.seriesId} from ${workSeries} where ${workSeries.workId} = ${works.id} order by ${workSeries.sortIndex} limit 1)`

/**
 * A series name as a sort key, exactly as sortTitle keys a title: normalized_name is normalizeText(name) (accents and
 * points stripped, apostrophes dropped, punctuation to spaces, lower case), then the same leading article goes.
 */
function seriesSortKey(normalizedName: SQL | typeof series.normalizedName): SQL {
  return sql`regexp_replace(${normalizedName}, '^(the|a|an) ', '')`
}

/** The sort name of the work's first author. */
const authorKey = sql`(select ${contributors.sortName} from ${workContributors} join ${contributors} on ${contributors.id} = ${workContributors.contributorId} where ${workContributors.workId} = ${works.id} order by ${workContributors.position} limit 1)`

/** The sort key of the title this person sees (#145); every title sort ends on works.id, so equal keys still page stably. */
const titleKey = (scope: Pick<UserScope, 'languages'>): SQL => shownTitleField(works.id, scope.languages, 'sort_title')

function ratingKey(scope: UserScope): SQL {
  return sql`(select ${userWorks.rating} from ${userWorks} where ${userWorks.userId} = ${scope.userId} and ${userWorks.workId} = ${works.id})`
}

function sortOrder(q: Pick<LibraryQuery, 'sort' | 'seriesId'>, scope: UserScope): SQL[] {
  switch (q.sort) {
    case 'series':
      if (q.seriesId !== null) {
        return [
          sql`(select ${workSeries.position} from ${workSeries} where ${workSeries.workId} = ${works.id} and ${workSeries.seriesId} = ${q.seriesId}) asc nulls last`,
          asc(titleKey(scope)),
          asc(works.id),
        ]
      }
      return [
        sql`${seriesSortKey(shownSeriesName(firstSeriesId, scope.languages, 'normalized_name'))} asc nulls last`,
        sql`(select ${workSeries.position} from ${workSeries} where ${workSeries.workId} = ${works.id} and ${workSeries.seriesId} = ${firstSeriesId}) asc nulls last`,
        asc(titleKey(scope)),
        asc(works.id),
      ]
    // works.id last: a stable order, so no book shows on two pages or none
    case 'title':
      return [asc(titleKey(scope)), asc(works.id)]
    case 'added':
      return [desc(works.createdAt), asc(titleKey(scope)), asc(works.id)]
    case 'author':
      return [sql`${authorKey} asc nulls last`, asc(titleKey(scope)), asc(works.id)]
    case 'rating':
      return [sql`${ratingKey(scope)} desc nulls last`, asc(titleKey(scope)), asc(works.id)]
  }
}

async function queryConditions(db: Db, scope: UserScope, q: LibraryQuery) {
  const conditions: SQL[] = [q.scope === 'library' ? scope.inLibrary : scope.visible]
  // wished books nobody owns live on the Wishlist page; asking for an availability shows them as asked (#53)
  if (!q.includeWanted && !mentionsAvailability(q.filter)) {
    conditions.push(sql`exists (select 1 from ${editions} where ${editions.workId} = ${works.id})`)
  }
  if (q.setId !== null) conditions.push(await setCondition(db, scope, q.setId))
  if (q.seriesId !== null) {
    conditions.push(sql`exists (select 1 from ${workSeries} where ${workSeries.workId} = ${works.id} and ${workSeries.seriesId} = ${q.seriesId})`)
  }
  if (q.filter !== null) conditions.push(compileFilter(q.filter, scope.userId))
  const search = buildSearch(q.search)
  if (search) conditions.push(search.match)
  return { where: and(...conditions), search }
}

export async function listWorks(db: Db, scope: UserScope, q: LibraryQuery): Promise<{ items: WorkCard[]; total: number }> {
  return pageWorks(db, scope, q, await queryConditions(db, scope, q))
}

type Conditions = Awaited<ReturnType<typeof queryConditions>>

async function pageWorks(db: Db, scope: UserScope, q: LibraryQuery, { where, search }: Conditions): Promise<{ items: WorkCard[]; total: number }> {
  const orderBy = search
    ? [
        desc(q.scope === 'catalog' ? sql`${search.score} + (case when ${scope.inLibrary} then 1 else 0 end)` : search.score),
        asc(titleKey(scope)),
        asc(works.id),
      ]
    : sortOrder(q, scope)

  const [rows, totals] = await Promise.all([
    db
      .select({ id: works.id })
      .from(works)
      .leftJoin(workSearch, eq(workSearch.workId, works.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(q.limit)
      .offset(q.offset),
    db.select({ n: count() }).from(works).leftJoin(workSearch, eq(workSearch.workId, works.id)).where(where),
  ])
  return { items: await getWorkCards(db, scope, rows.map((r) => r.id)), total: totals[0]?.n ?? 0 }
}

interface EntryRow extends Record<string, unknown> {
  work_id: string | null
  series_id: string | null
  series_name: string | null
  n: number | null
  read_n: number | null
  /** up to three work ids, comma-separated, in series order */
  cover_ids: string | null
  total: number
  books: number
}

/** The order of collapsed entries (columns of `entries` below); the id last makes it stable across pages. */
function entryOrder(sort: LibraryQuery['sort']): SQL {
  const tie = sql`coalesce(work_id, series_id) asc`
  switch (sort) {
    case 'title':
      return sql`k_title asc, ${tie}`
    case 'added':
      return sql`k_added desc, k_title asc, ${tie}`
    case 'author':
      return sql`k_author asc nulls last, k_title asc, ${tie}`
    case 'rating':
      return sql`k_rating desc nulls last, k_title asc, ${tie}`
    case 'series':
      return sql`(series_id is null) asc, k_title asc, ${tie}`
  }
}

/**
 * The Library page: works, or with `collapseSeries` (and no search text, outside a series) one entry per series
 * standing in for its works that pass the scope, set, filters and visibility. A work in several series counts under its
 * first. Pagination, `total` (entries) and `books` (works) come from the same grouped query.
 */
export async function listLibrary(db: Db, scope: UserScope, q: LibraryQuery): Promise<LibraryPage> {
  const conditions = await queryConditions(db, scope, q)
  if (!q.collapseSeries || conditions.search || q.seriesId !== null) {
    const page = await pageWorks(db, scope, q, conditions)
    return { items: page.items.map((work) => ({ kind: 'work', work })), total: page.total, books: page.total }
  }

  const isRead = sql`exists (select 1 from ${userWorks} where ${userWorks.userId} = ${scope.userId} and ${userWorks.workId} = ${works.id} and ${userWorks.status} = 'read')`
  // the author and rating lookups only for the sort that orders by them
  const author = q.sort === 'author' ? authorKey : sql`null::text`
  const rating = q.sort === 'rating' ? ratingKey(scope) : sql`null::double precision`
  // no work_search join: this path never has search text
  const rows = await db.execute<EntryRow>(sql`
    with matched as (
      select ${works.id} as id, ${titleKey(scope)} as sort_title, ${works.createdAt} as created_at,
        ${author} as author_key, ${rating} as rating, ${isRead} as is_read,
        fs.series_id, fs.position
      from ${works}
      left join lateral (
        select ${workSeries.seriesId} as series_id, ${workSeries.position} as position
        from ${workSeries} where ${workSeries.workId} = ${works.id} order by ${workSeries.sortIndex} limit 1
      ) fs on true
      where ${conditions.where}
    ),
    entries as (
      select m.id as work_id, null::uuid as series_id, null::text as series_name,
        m.sort_title as k_title, m.created_at as k_added, m.author_key as k_author, m.rating as k_rating,
        1 as n, 0 as read_n, null::text as cover_ids
      from matched m where m.series_id is null
      union all
      select null::uuid, m.series_id, ${shownSeriesName(sql`m.series_id`, scope.languages)},
        ${seriesSortKey(shownSeriesName(sql`m.series_id`, scope.languages, 'normalized_name'))}, max(m.created_at), min(m.author_key), max(m.rating),
        count(*)::int, (count(*) filter (where m.is_read))::int,
        array_to_string((array_agg(m.id::text order by m.position asc nulls last, m.sort_title, m.id))[1:3], ',')
      from matched m where m.series_id is not null
      group by m.series_id
    ),
    ranked as (
      select e.*, row_number() over (order by ${entryOrder(q.sort)}) as rn from entries e
    )
    select r.work_id, r.series_id, r.series_name, r.n, r.read_n, r.cover_ids, t.total, t.books
    from (select (select count(*) from entries)::int as total, (select count(*) from matched)::int as books) t
    left join ranked r on r.rn > ${q.offset} and r.rn <= ${q.offset + q.limit}
    order by r.rn
  `)

  const list = [...rows]
  const coverIds = (row: EntryRow) => row.cover_ids?.split(',') ?? []
  const [cardList, coverList] = await Promise.all([
    getWorkCards(db, scope, list.flatMap((r) => (r.work_id !== null ? [r.work_id] : []))),
    loadCovers(db, scope, [...new Set(list.flatMap(coverIds))]),
  ])
  const cards = new Map(cardList.map((c) => [c.id, c]))
  const coverBy = new Map(coverList.map((c) => [c.workId, c]))
  const items = list.flatMap((row): LibraryEntry[] => {
    if (row.work_id !== null) {
      const work = cards.get(row.work_id)
      return work ? [{ kind: 'work', work }] : []
    }
    if (row.series_id === null) return []
    const covers = coverIds(row).flatMap((id) => {
      const cover = coverBy.get(id)
      return cover ? [cover] : []
    })
    return [
      {
        kind: 'series',
        series: { id: row.series_id, name: row.series_name ?? '', bookCount: row.n ?? 0, readCount: row.read_n ?? 0, covers },
      },
    ]
  })
  return { items, total: list[0]?.total ?? 0, books: list[0]?.books ?? 0 }
}

/**
 * A series card's covers: title and cover only (no authors, holdings or tracking), picked as a book card picks its
 * cover. The ids come from the grouped query, which already applied visibility.
 */
async function loadCovers(db: Db, scope: UserScope, ids: readonly string[]): Promise<SeriesGroupCard['covers']> {
  if (ids.length === 0) return []
  const idList = [...ids]
  const [titles, covered] = await Promise.all([
    db.select({ id: works.id, title: shownTitleField(works.id, scope.languages, 'title') }).from(works).where(inArray(works.id, idList)),
    db
      .select({ workId: editions.workId, id: editions.id, format: editions.format, coverAssetId: editions.coverAssetId, createdAt: editions.createdAt })
      .from(editions)
      .where(and(inArray(editions.workId, idList), isNotNull(editions.coverAssetId))),
  ])
  const byWork = groupBy(covered)
  return titles.map((w) => ({ workId: w.id, title: w.title, coverAssetId: pickCoverAssetId(byWork.get(w.id) ?? []) }))
}

function groupBy<T extends { workId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const list = map.get(row.workId)
    if (list) list.push(row)
    else map.set(row.workId, [row])
  }
  return map
}

export async function getWorkCards(db: Db, scope: UserScope, ids: readonly string[]): Promise<WorkCard[]> {
  if (ids.length === 0) return []
  const idList = [...ids]
  const [base, authorRows, seriesRows, formatRows, mineRows, queueRows, wishRows] = await Promise.all([
    db
      .select({
        id: works.id,
        title: shownTitleField(works.id, scope.languages, 'title'),
        subtitle: shownTitleField(works.id, scope.languages, 'subtitle'),
        kind: works.kind,
      })
      .from(works)
      .where(and(inArray(works.id, idList), scope.visible)),
    db
      .select({ workId: workContributors.workId, name: shownWorkName(workContributors.nameId, workContributors.contributorId, scope.languages) })
      .from(workContributors)
      .where(inArray(workContributors.workId, idList))
      .orderBy(asc(workContributors.position)),
    db
      .select({ workId: workSeries.workId, name: shownSeriesName(series.id, scope.languages), position: workSeries.position, positionEnd: workSeries.positionEnd })
      .from(workSeries)
      .innerJoin(series, eq(series.id, workSeries.seriesId))
      .where(inArray(workSeries.workId, idList))
      .orderBy(asc(workSeries.sortIndex)),
    db
      .select({
        workId: editions.workId,
        id: editions.id,
        format: editions.format,
        ownership: editions.ownership,
        inPossession: editions.inPossession,
        coverAssetId: editions.coverAssetId,
        createdAt: editions.createdAt,
      })
      .from(editions)
      .where(inArray(editions.workId, idList))
      // deterministic cover pick (R19): earliest-created, then lowest id, within each format
      .orderBy(asc(editions.createdAt), asc(editions.id)),
    db
      .select({ workId: userWorks.workId, status: userWorks.status, rating: userWorks.rating })
      .from(userWorks)
      .where(and(eq(userWorks.userId, scope.userId), inArray(userWorks.workId, idList))),
    db
      .select({ workId: queueEntries.workId })
      .from(queueEntries)
      .where(and(eq(queueEntries.userId, scope.userId), inArray(queueEntries.workId, idList))),
    db
      .select({ workId: wishes.workId, userId: wishes.userId, name: users.displayName })
      .from(wishes)
      .innerJoin(users, eq(users.id, wishes.userId))
      .where(inArray(wishes.workId, idList))
      .orderBy(asc(wishes.createdAt), asc(wishes.id)),
  ])

  const byId = new Map(base.map((b) => [b.id, b]))
  const authors = groupBy(authorRows)
  const seriesBy = groupBy(seriesRows)
  const formats = groupBy(formatRows)
  const mine = new Map(mineRows.map((m) => [m.workId, m]))
  const queued = new Set(queueRows.map((q) => q.workId))
  const wishedBy = groupBy(wishRows)
  const formatOrder = (f: EditionFormat) => editionFormats.indexOf(f)

  return ids.flatMap((id): WorkCard[] => {
    const work = byId.get(id)
    if (!work) return []
    const firstSeries = seriesBy.get(id)?.[0]
    return [
      {
        id,
        title: work.title,
        subtitle: work.subtitle,
        kind: work.kind,
        authors: (authors.get(id) ?? []).map((a) => a.name),
        series: firstSeries ? { name: firstSeries.name, position: firstSeries.position, positionEnd: firstSeries.positionEnd } : null,
        formats: [...new Set((formats.get(id) ?? []).map((f) => f.format))].sort((a, b) => formatOrder(a) - formatOrder(b)),
        availability: deriveAvailability(formats.get(id) ?? []),
        status: mine.get(id)?.status ?? 'none',
        rating: mine.get(id)?.rating ?? null,
        inQueue: queued.has(id),
        wishedBy: (wishedBy.get(id) ?? []).map(({ userId, name }) => ({ userId, name })),
        coverAssetId: pickCoverAssetId(formats.get(id) ?? []),
      },
    ]
  })
}

export interface Facets {
  authors: { id: string; name: string; otherNames: string[] }[]
  series: { id: string; name: string }[]
  tags: { id: string; name: string }[]
  languages: string[]
}

const FACET_LIMIT = 1000

export async function listFacets(db: Db, scope: UserScope): Promise<Facets> {
  const [authorRows, seriesRows, tagRows, languageRows] = await Promise.all([
    db
      .selectDistinct({ id: contributors.id, name: contributors.name, sortName: contributors.sortName })
      .from(contributors)
      .innerJoin(workContributors, eq(workContributors.contributorId, contributors.id))
      .innerJoin(works, eq(works.id, workContributors.workId))
      .where(scope.visible)
      .orderBy(asc(contributors.sortName))
      .limit(FACET_LIMIT),
    db
      .selectDistinct({ id: series.id, name: shownSeriesName(series.id, scope.languages).as('series_name') })
      .from(series)
      .innerJoin(workSeries, eq(workSeries.seriesId, series.id))
      .innerJoin(works, eq(works.id, workSeries.workId))
      .where(scope.visible)
      .orderBy(asc(sql`series_name`))
      .limit(FACET_LIMIT),
    db
      .selectDistinct({ id: tags.id, name: tags.name })
      .from(tags)
      .innerJoin(workTags, eq(workTags.tagId, tags.id))
      .innerJoin(works, eq(works.id, workTags.workId))
      .where(scope.visible)
      .orderBy(asc(tags.name))
      .limit(FACET_LIMIT),
    db
      .selectDistinct({ language: editions.language })
      .from(editions)
      .innerJoin(works, eq(works.id, editions.workId))
      .where(and(scope.visible, isNotNull(editions.language)))
      .orderBy(asc(editions.language)),
  ])
  const others =
    authorRows.length === 0
      ? []
      : await db
          .select({ contributorId: contributorNames.contributorId, name: contributorNames.name })
          .from(contributorNames)
          .innerJoin(contributors, eq(contributors.id, contributorNames.contributorId))
          .where(and(inArray(contributorNames.contributorId, authorRows.map((a) => a.id)), sql`${contributorNames.normalizedName} <> ${contributors.normalizedName}`))
          .orderBy(asc(contributorNames.name))
  return {
    authors: authorRows.map(({ id, name }) => ({ id, name, otherNames: others.filter((o) => o.contributorId === id).map((o) => o.name) })),
    series: seriesRows,
    tags: tagRows,
    languages: languageRows.flatMap((r) => (r.language === null ? [] : [r.language])),
  }
}
