import { asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  DomainError,
  normalizeText,
  notFound,
  replaceSeriesInFilter,
  type AddSeriesNameInput,
  type ListSeriesAdminInput,
  type MergeSeriesInput,
  type RenameSeriesNameInput,
  type SetSeriesNameLanguageInput,
  type SplitSeriesNameInput,
} from '@mylib/domain'
import type { Db } from '../client'
import { series, seriesNames, sets, workSeries, works } from '../schema'
import { refreshSearchDocument } from './search-index'
import { requireAdmin, type UserScope } from './scope'
import { shownTitleField } from './titles'

export interface SeriesName {
  id: string
  name: string
  language: string | null
  primary: boolean
}
export interface SeriesRow {
  id: string
  name: string
  /** primary first, then by name */
  names: SeriesName[]
  bookCount: number
}
export interface SeriesBook {
  workId: string
  title: string
  position: number | null
  positionEnd: number | null
}
export interface SeriesDetail extends SeriesRow {
  /** in series order */
  books: SeriesBook[]
}

// written out: drizzle drops the table qualifier in a single-table select, and the subqueries have an "id" of their own
const seriesId = sql`"series"."id"`
const bookCount = sql<number>`(select count(*)::int from ${workSeries} where ${workSeries.seriesId} = ${seriesId})`

async function seriesRows(db: Db, where: SQL | undefined, limit: number): Promise<SeriesRow[]> {
  const rows = await db
    .select({ id: series.id, name: series.name, normalizedName: series.normalizedName, bookCount })
    .from(series)
    .where(where)
    .orderBy(asc(series.normalizedName), asc(series.id))
    .limit(limit)
  if (rows.length === 0) return []
  const names = await db
    .select({ id: seriesNames.id, seriesId: seriesNames.seriesId, name: seriesNames.name, normalizedName: seriesNames.normalizedName, language: seriesNames.language })
    .from(seriesNames)
    .where(inArray(seriesNames.seriesId, rows.map((r) => r.id)))
    .orderBy(asc(seriesNames.name))
  return rows.map(({ normalizedName, ...s }) => ({
    ...s,
    names: names
      .filter((n) => n.seriesId === s.id)
      .map((n) => ({ id: n.id, name: n.name, language: n.language, primary: n.normalizedName === normalizedName }))
      .sort((a, b) => Number(b.primary) - Number(a.primary)),
  }))
}

/** Admin → Series: every series, searchable by any of its names (a growing limit, like the Inbox). */
export async function listSeriesAdmin(db: Db, scope: UserScope, input: ListSeriesAdminInput): Promise<{ series: SeriesRow[]; more: boolean }> {
  requireAdmin(scope)
  const q = normalizeText(input.q)
  const where =
    q === ''
      ? undefined
      : sql`exists (select 1 from ${seriesNames} where ${seriesNames.seriesId} = ${seriesId} and strpos(${seriesNames.normalizedName}, ${q}) > 0)`
  const rows = await seriesRows(db, where, input.limit + 1)
  return { series: rows.slice(0, input.limit), more: rows.length > input.limit }
}

export async function getSeriesAdmin(db: Db, scope: UserScope, id: string): Promise<SeriesDetail> {
  requireAdmin(scope)
  const [row] = await seriesRows(db, eq(series.id, id), 1)
  if (!row) throw notFound('Series')
  const books = await db
    .select({ workId: works.id, title: shownTitleField(works.id, scope.languages, 'title'), position: workSeries.position, positionEnd: workSeries.positionEnd })
    .from(workSeries)
    .innerJoin(works, eq(works.id, workSeries.workId))
    .where(eq(workSeries.seriesId, id))
    // sortIndex orders one work's series, not a series' works (#125)
    .orderBy(sql`${workSeries.position} asc nulls last`, asc(shownTitleField(works.id, scope.languages, 'sort_title')), asc(works.id))
  return { ...row, books }
}

async function worksOfSeries(db: Db, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await db.selectDistinct({ id: workSeries.workId }).from(workSeries).where(inArray(workSeries.seriesId, [...ids]))
  return rows.map((r) => r.id)
}

async function refreshWorks(tx: Db, workIds: readonly string[]) {
  for (const workId of workIds) await refreshSearchDocument(tx, workId)
}

/** Locks these series (by id, so two merges cannot deadlock each other); returns those that exist. */
async function lockSeries(tx: Db, ids: readonly string[]) {
  return tx
    .select({ id: series.id, name: series.name, normalizedName: series.normalizedName })
    .from(series)
    .where(inArray(series.id, [...ids]))
    .orderBy(asc(series.id))
    .for('update')
}

/** a smart set whose filter holds this series' id */
const filtersBy = (id: string) => sql`jsonb_path_exists(${sets.filter}, '$.** ? (@.seriesIds[*] == $id)', jsonb_build_object('id', ${id}::text))`

/**
 * "Same series as…": one series keeps both series' books and names (the owner of the chosen primary name); the other
 * is deleted. A work in both keeps one link: the lower sort_index, and the kept series' position unless only the other
 * has one. Locks both series first (FOR UPDATE), so a concurrent book write resolving a name of either one (FOR KEY
 * SHARE on the insert of a link) waits for the merge.
 */
export async function mergeSeries(db: Db, scope: UserScope, input: MergeSeriesInput): Promise<{ seriesId: string }> {
  requireAdmin(scope)
  if (input.seriesId === input.otherId) throw new DomainError('INVALID', 'A series cannot be merged with itself')
  return db.transaction(async (tx) => {
    const ids = [input.seriesId, input.otherId]
    if ((await lockSeries(tx, ids)).length !== 2) throw notFound('Series')
    const names = await tx
      .select({ id: seriesNames.id, seriesId: seriesNames.seriesId, name: seriesNames.name, normalizedName: seriesNames.normalizedName })
      .from(seriesNames)
      .where(inArray(seriesNames.seriesId, ids))
    const primary = names.find((n) => n.id === input.primaryNameId)
    if (!primary) throw new DomainError('INVALID', 'The primary name must be one of their names')
    const keepId = primary.seriesId
    const goneId = keepId === input.seriesId ? input.otherId : input.seriesId
    const affected = await worksOfSeries(tx, ids)

    // a work in both: the kept link takes the lower sort_index, and the other's position when it has none; table names are literal, like above
    await tx.execute(sql`update work_series as k
      set sort_index = least(k.sort_index, g.sort_index),
          position = case when k.position is not null then k.position else g.position end,
          position_end = case when k.position is not null then k.position_end else g.position_end end
      from work_series as g
      where k.work_id = g.work_id and k.series_id = ${keepId} and g.series_id = ${goneId}`)
    await tx.execute(sql`delete from work_series as g using work_series as k
      where g.work_id = k.work_id and g.series_id = ${goneId} and k.series_id = ${keepId}`)
    await tx.update(workSeries).set({ seriesId: keepId }).where(eq(workSeries.seriesId, goneId))
    await tx.update(seriesNames).set({ seriesId: keepId }).where(eq(seriesNames.seriesId, goneId))
    await tx.execute(sql`insert into user_hidden_continuation (user_id, series_id, created_at)
      select user_id, ${keepId}, created_at from user_hidden_continuation where series_id = ${goneId}
      on conflict do nothing`)
    await tx.execute(sql`delete from user_hidden_continuation where series_id = ${goneId}`)

    const smart = await tx.select({ id: sets.id, filter: sets.filter }).from(sets).where(filtersBy(goneId))
    for (const s of smart) if (s.filter !== null) await tx.update(sets).set({ filter: replaceSeriesInFilter(s.filter, goneId, keepId) }).where(eq(sets.id, s.id))

    // the merged-away series goes first: the kept one may take its primary spelling (series.normalized_name is unique)
    await tx.delete(series).where(eq(series.id, goneId))
    await tx.update(series).set({ name: primary.name, normalizedName: primary.normalizedName }).where(eq(series.id, keepId))
    await refreshWorks(tx, affected)
    return { seriesId: keepId }
  })
}

async function nameRow(tx: Db, nameId: string) {
  const [name] = await tx
    .select({ id: seriesNames.id, seriesId: seriesNames.seriesId, name: seriesNames.name, normalizedName: seriesNames.normalizedName })
    .from(seriesNames)
    .where(eq(seriesNames.id, nameId))
  if (!name) throw notFound('Name')
  return name
}

/** Locks the name's series and returns it with all its names (primary first, then by name). */
async function seriesOfName(tx: Db, nameId: string) {
  const name = await nameRow(tx, nameId)
  const [owner] = await lockSeries(tx, [name.seriesId])
  if (!owner) throw notFound('Series')
  // a split or merge may have moved the name before we held the lock
  if ((await nameRow(tx, nameId)).seriesId !== name.seriesId) throw new DomainError('CONFLICT', 'That name just changed — try again')
  const names = (
    await tx
      .select({ id: seriesNames.id, name: seriesNames.name, normalizedName: seriesNames.normalizedName })
      .from(seriesNames)
      .where(eq(seriesNames.seriesId, owner.id))
      .orderBy(asc(seriesNames.name))
  ).sort((a, b) => Number(b.normalizedName === owner.normalizedName) - Number(a.normalizedName === owner.normalizedName))
  return { name, owner, names }
}

const asPrimary = (n: { name: string; normalizedName: string }) => ({ name: n.name, normalizedName: n.normalizedName })

/** the CONFLICT for a spelling another series (or this one) owns */
async function spellingTaken(tx: Db, normalized: string, ownSeriesId: string): Promise<DomainError> {
  const [owner] = await tx
    .select({ id: series.id, name: series.name })
    .from(seriesNames)
    .innerJoin(series, eq(series.id, seriesNames.seriesId))
    .where(eq(seriesNames.normalizedName, normalized))
  if (owner?.id === ownSeriesId) return new DomainError('CONFLICT', 'That series already has that name')
  return new DomainError('CONFLICT', `That name is ${owner?.name ?? 'another series'}’s — use Same series as… instead`)
}

/** "Split off this name": the name becomes its own series, with the ticked books (position, range and sort_index kept). */
export async function splitSeriesName(db: Db, scope: UserScope, input: SplitSeriesNameInput): Promise<{ seriesId: string }> {
  requireAdmin(scope)
  return db.transaction(async (tx) => {
    const { name, owner, names } = await seriesOfName(tx, input.nameId)
    if (names.length < 2) throw new DomainError('INVALID', 'Its only name cannot be split off')
    const links = await tx.select({ workId: workSeries.workId }).from(workSeries).where(eq(workSeries.seriesId, owner.id))
    const ticked = new Set(input.workIds)
    const moving = links.filter((l) => ticked.has(l.workId)).map((l) => l.workId)
    if (moving.length === 0) throw new DomainError('INVALID', 'Tick at least one book to move')
    if (moving.length === links.length) throw new DomainError('INVALID', 'At least one book must stay')
    if (name.normalizedName === owner.normalizedName) {
      const others = names.filter((n) => n.id !== name.id)
      const next = input.primaryNameId === null ? others[0] : others.find((n) => n.id === input.primaryNameId)
      if (!next) throw new DomainError('INVALID', 'The new primary name must be another of its names')
      // first: the new series takes this spelling as its normalized name, which is unique
      await tx.update(series).set(asPrimary(next)).where(eq(series.id, owner.id))
    }
    const [created] = await tx.insert(series).values(asPrimary(name)).returning({ id: series.id })
    if (!created) throw new Error('Split failed')
    await tx.update(seriesNames).set({ seriesId: created.id }).where(eq(seriesNames.id, name.id))
    await tx.update(workSeries).set({ seriesId: created.id }).where(sql`${workSeries.seriesId} = ${owner.id} and ${inArray(workSeries.workId, moving)}`)
    await refreshWorks(tx, links.map((l) => l.workId))
    return { seriesId: created.id }
  })
}

export async function addSeriesName(db: Db, scope: UserScope, input: AddSeriesNameInput): Promise<{ nameId: string }> {
  requireAdmin(scope)
  const normalized = normalizeText(input.name)
  if (normalized === '') throw new DomainError('INVALID', 'A name is required')
  return db.transaction(async (tx) => {
    const [owner] = await lockSeries(tx, [input.seriesId])
    if (!owner) throw notFound('Series')
    const [row] = await tx
      .insert(seriesNames)
      .values({ seriesId: owner.id, name: input.name, normalizedName: normalized, language: input.language })
      .onConflictDoNothing({ target: seriesNames.normalizedName })
      .returning({ id: seriesNames.id })
    if (!row) throw await spellingTaken(tx, normalized, owner.id)
    await refreshWorks(tx, await worksOfSeries(tx, [owner.id]))
    return { nameId: row.id }
  })
}

export async function renameSeriesName(db: Db, scope: UserScope, input: RenameSeriesNameInput): Promise<void> {
  requireAdmin(scope)
  const normalized = normalizeText(input.name)
  if (normalized === '') throw new DomainError('INVALID', 'A name is required')
  await db.transaction(async (tx) => {
    const { name, owner } = await seriesOfName(tx, input.nameId)
    if (normalized !== name.normalizedName) {
      const [taken] = await tx.select({ id: seriesNames.id }).from(seriesNames).where(eq(seriesNames.normalizedName, normalized))
      if (taken) throw await spellingTaken(tx, normalized, owner.id)
    }
    await tx.update(seriesNames).set({ name: input.name, normalizedName: normalized }).where(eq(seriesNames.id, name.id))
    if (name.normalizedName === owner.normalizedName) await tx.update(series).set({ name: input.name, normalizedName: normalized }).where(eq(series.id, owner.id))
    await refreshWorks(tx, await worksOfSeries(tx, [owner.id]))
  })
}

export async function setSeriesNameLanguage(db: Db, scope: UserScope, input: SetSeriesNameLanguageInput): Promise<void> {
  requireAdmin(scope)
  await db.transaction(async (tx) => {
    const { name } = await seriesOfName(tx, input.nameId)
    await tx.update(seriesNames).set({ language: input.language }).where(eq(seriesNames.id, name.id))
  })
}

export async function makeSeriesNamePrimary(db: Db, scope: UserScope, nameId: string): Promise<void> {
  requireAdmin(scope)
  await db.transaction(async (tx) => {
    const { name, owner } = await seriesOfName(tx, nameId)
    await tx.update(series).set(asPrimary(name)).where(eq(series.id, owner.id))
  })
}

/** The spelling becomes free; the books keep the series. */
export async function removeSeriesName(db: Db, scope: UserScope, nameId: string): Promise<void> {
  requireAdmin(scope)
  await db.transaction(async (tx) => {
    const { name, owner } = await seriesOfName(tx, nameId)
    if (name.normalizedName === owner.normalizedName) throw new DomainError('INVALID', 'Make another name primary first')
    await tx.delete(seriesNames).where(eq(seriesNames.id, name.id))
    await refreshWorks(tx, await worksOfSeries(tx, [owner.id]))
  })
}
