import { and, eq, sql, type SQL } from 'drizzle-orm'
import { DomainError, sqlHealthChecks, KIND_SUGGESTION_SQL_PATTERNS, notFound, type SqlHealthCheck, type HealthCounts, type HealthIgnoreInput, type HealthItem, type HealthListInput } from '@mylib/domain'
import type { Db } from '../client'
import { healthIgnores, series } from '../schema'
import { countAbsOutOfSync } from './abs-push'
import { updateWork } from './catalog'
import type { UserScope } from './scope'

// Each check is a query of rows (key text, sort text, item jsonb). `item` is the HealthItem the page shows,
// and `key` is what health_ignore stores for it. The checks see the whole catalog (no scope.visible):
// Admin → Health is admin-only, and a book someone hid for themselves is still a catalog problem.
const PRINTED = sql`('physical', 'ebook')`
const WORK = sql`jsonb_build_object('id', w.id, 'title', w.title)`

function workRow(check: SqlHealthCheck, where: SQL): SQL {
  return sql`select w.id::text as key, w.sort_title as sort, jsonb_build_object('check', ${check}::text, 'key', w.id::text, 'work', ${WORK}) as item
    from work w where ${where}`
}

function subjects(check: SqlHealthCheck, today: string): SQL {
  switch (check) {
    case 'no_cover':
      return workRow(check, sql`exists (select 1 from edition e where e.work_id = w.id)
        and not exists (select 1 from edition e where e.work_id = w.id and e.cover_asset_id is not null)`)
    case 'no_isbn':
      return workRow(check, sql`exists (select 1 from edition e where e.work_id = w.id and e.format in ${PRINTED})
        and not exists (select 1 from edition e where e.work_id = w.id and e.format in ${PRINTED} and (e.isbn13 is not null or e.isbn10 is not null))`)
    case 'no_author':
      return workRow(check, sql`not exists (select 1 from work_contributor c where c.work_id = w.id)`)
    case 'no_length':
      return sql`select e.id::text as key, w.sort_title as sort,
          jsonb_build_object('check', 'no_length', 'key', e.id::text, 'work', ${WORK},
            'edition', jsonb_build_object('id', e.id, 'format', e.format, 'volume', e.volume)) as item
        from edition e join work w on w.id = e.work_id
        where (e.format in ${PRINTED} and e.page_count is null) or (e.format = 'audiobook' and e.duration_sec is null)`
    case 'duplicates':
      // a.work_id < b.work_id: uuid order is the order of their text, so key = pairKey(a, b).
      // Two branches, unioned (a pair found by both counts once). The split avoids an n² OR-join scan: similarity (%) is
      // only computed for pairs that share an author, and exact title equality is checked on its own.
      // Similar titles are expected inside a series ("Blood of Liscor" / "Rains of Liscor") and between numbered books
      // ("Beware of Chicken 2" / "3"), so the similar branch skips pairs that share a series or whose digits differ.
      return sql`select p.a_id::text || ':' || p.b_id::text as key, wa.sort_title as sort,
          jsonb_build_object('check', 'duplicates', 'key', p.a_id::text || ':' || p.b_id::text,
            'works', jsonb_build_array(jsonb_build_object('id', wa.id, 'title', wa.title), jsonb_build_object('id', wb.id, 'title', wb.title))) as item
        from (
          select a.work_id as a_id, b.work_id as b_id from work_search a
            join work_search b on a.work_id < b.work_id and a.title_text = b.title_text
            where a.title_text <> ''
          union
          select a.work_id, b.work_id from work_search a
            join work_search b on a.work_id < b.work_id and a.title_text % b.title_text
            where a.title_text <> '' and b.title_text <> ''
              and exists (
                select 1 from work_contributor ca join work_contributor cb on cb.contributor_id = ca.contributor_id
                where ca.work_id = a.work_id and cb.work_id = b.work_id)
              and regexp_replace(a.title_text, '\\D', '', 'g') = regexp_replace(b.title_text, '\\D', '', 'g')
              and not exists (
                select 1 from work_series sa join work_series sb on sb.series_id = sa.series_id
                where sa.work_id = a.work_id and sb.work_id = b.work_id)
        ) p
        join work wa on wa.id = p.a_id
        join work wb on wb.id = p.b_id`
    case 'empty_series':
      return sql`select s.id::text as key, s.normalized_name as sort,
          jsonb_build_object('check', 'empty_series', 'key', s.id::text, 'series', jsonb_build_object('id', s.id, 'name', s.name)) as item
        from series s where not exists (select 1 from work_series ws where ws.series_id = s.id)`
    case 'series_gaps':
      // whole positions >= 1, and ranges (#122); looks no further than 1000 so a typo like 20001 stays cheap.
      // least() skips nulls, so a series with no whole position is filtered out before it (#123).
      return sql`select s.id::text as key, s.normalized_name as sort,
          jsonb_build_object('check', 'series_gaps', 'key', s.id::text, 'series', jsonb_build_object('id', s.id, 'name', s.name),
            'missing', to_jsonb(g.missing),
            'unnumbered', (select count(*) from work_series ws where ws.series_id = s.id and ws.position is null)) as item
        from series s
        join lateral (
          select max(floor(coalesce(ws.position_end, ws.position)))::int as top from work_series ws
          where ws.series_id = s.id and coalesce(ws.position_end, ws.position) >= 1
            and (ws.position_end is not null or ws.position = trunc(ws.position))
        ) h on h.top is not null
        join lateral (
          select array_agg(n order by n) as missing
          from generate_series(1, least(h.top, 1000)) n
          -- a range holds every whole number between its ends (#122); a single fractional position holds none
          where not exists (select 1 from work_series ws where ws.series_id = s.id and n between ws.position and coalesce(ws.position_end, ws.position))
        ) g on g.missing is not null`
    case 'kind_suggestions': {
      // Only an unlocked book: a kind someone set (even Book) is never second-guessed. The text is the work's own
      // description plus the descriptions of its source items; fanfiction signals win over serial ones.
      const p = KIND_SUGGESTION_SQL_PATTERNS
      return sql`select w.id::text as key, w.sort_title as sort,
          jsonb_build_object('check', 'kind_suggestions', 'key', w.id::text, 'work', ${WORK}, 'suggested', g.suggested) as item
        from work w
        cross join lateral (select coalesce(w.description, '') || ' ' || coalesce((
          select string_agg(si.normalized->>'description', ' ') from source_item si
          where si.work_id = w.id or si.edition_id in (select e.id from edition e where e.work_id = w.id)), '') as txt) d
        cross join lateral (select w.title || ' ' || coalesce((
          select string_agg(sr.name, ' ') from work_series ws join series sr on sr.id = ws.series_id where ws.work_id = w.id), '') as names) n
        cross join lateral (select case
          when d.txt ~* ${p.fanfictionText}::text
            or (n.names ~* ${p.fanfictionTitle}::text and not exists (
              select 1 from work_contributor wc join contributor_name cn on cn.contributor_id = wc.contributor_id
              where wc.work_id = w.id and cn.name ~* 'rowling')) then 'fanfiction'
          when d.txt ~* ${p.serialText}::text then 'web_serial' end as suggested) g
        where w.kind = 'book' and not coalesce((w.provenance->'kind'->>'locked')::boolean, false) and g.suggested is not null`
    }
    case 'long_loans':
      return sql`select l.id::text as key, l.lent_on::text as sort,
          jsonb_build_object('check', 'long_loans', 'key', l.id::text, 'work', ${WORK},
            'loan', jsonb_build_object('id', l.id, 'borrower', coalesce(u.display_name, l.borrower_name), 'lentOn', l.lent_on::text, 'dueOn', l.due_on::text)) as item
        from loan l
        join edition e on e.id = l.edition_id
        join work w on w.id = e.work_id
        left join app_user u on u.id = l.borrower_user_id
        where l.returned_on is null and (
          (l.due_on is not null and l.due_on < ${today}::date)
          or (l.due_on is null and l.lent_on < ${today}::date - 90))`
  }
}

function ignoredFilter(check: SqlHealthCheck, showIgnored: boolean): SQL {
  const ignored = sql`exists (select 1 from health_ignore i where i.check_name = ${check} and i.subject_key = s.key)`
  return showIgnored ? ignored : sql`not ${ignored}`
}

/** The duplicates check uses the % operator, whose threshold is a session setting: set for this transaction only. */
async function withTrigram<T>(db: Db, run: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local pg_trgm.similarity_threshold = 0.6`)
    return run(tx)
  })
}

export async function healthCounts(db: Db, input: { today: string }): Promise<HealthCounts> {
  const counts = await withTrigram(db, async (tx) => {
    const counts = { abs_out_of_sync: 0 } as HealthCounts // filled in below: its count is computed in TS
    for (const check of sqlHealthChecks) {
      const [row] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from (${subjects(check, input.today)}) s where ${ignoredFilter(check, false)}`)
      counts[check] = row?.n ?? 0
    }
    return counts
  })
  counts.abs_out_of_sync = await countAbsOutOfSync(db)
  return counts
}

export async function listHealth(db: Db, input: HealthListInput): Promise<{ items: HealthItem[]; more: boolean }> {
  return withTrigram(db, async (tx) => {
    const rows = await tx.execute<{ item: HealthItem }>(sql`select s.item from (${subjects(input.check, input.today)}) s
      where ${ignoredFilter(input.check, input.showIgnored)} order by s.sort, s.key limit ${input.limit + 1}`)
    const items = [...rows].map((r) => r.item)
    return { items: items.slice(0, input.limit), more: items.length > input.limit }
  })
}

export async function ignoreHealth(db: Db, userId: string, input: HealthIgnoreInput): Promise<void> {
  await db.insert(healthIgnores).values({ checkName: input.check, subjectKey: input.subjectKey, ignoredBy: userId }).onConflictDoNothing()
}

/** "Not fanfiction": sets the book kind by hand (so no rule suggests it again) and drops the row, in one step. */
export async function dismissKindSuggestion(db: Db, scope: UserScope, workId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await updateWork(tx, scope, workId, { kind: 'book' })
    await ignoreHealth(tx, scope.userId, { check: 'kind_suggestions', subjectKey: workId })
  })
}

export async function unignoreHealth(db: Db, input: HealthIgnoreInput): Promise<void> {
  await db.delete(healthIgnores).where(and(eq(healthIgnores.checkName, input.check), eq(healthIgnores.subjectKey, input.subjectKey)))
}

/** Deletes a series only while it has no books; the row lock makes a concurrent "add to series" wait, then this sees it. */
export async function deleteEmptySeries(db: Db, seriesId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.execute<{ id: string }>(sql`select id from series where id = ${seriesId} for update`)
    if (!row) throw notFound('Series')
    const [used] = await tx.execute<{ one: number }>(sql`select 1 as one from work_series where series_id = ${seriesId} limit 1`)
    if (used) throw new DomainError('CONFLICT', 'This series has books now')
    await tx.delete(series).where(eq(series.id, seriesId))
  })
}
