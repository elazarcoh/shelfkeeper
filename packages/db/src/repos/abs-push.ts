import { createHash } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import {
  absPushFields,
  currentAbsRecord,
  diffAbs,
  outgoingAbsRecord,
  type AbsEditionSource,
  type AbsFieldDiff,
  type AbsPushField,
  type AbsPushSendInput,
  type AbsRecord,
} from '@mylib/domain'
import type { Db } from '../client'
import { absPushRuns, editionContributors, editions, healthIgnores, sourceItems, sources, users, workContributors, workSeries, series } from '../schema'
import { shownWorkName } from './person-names'
import { shownSeriesName } from './series-names'
import { shownEditionSubtitle, shownEditionTitle } from './titles'

export type AbsPushOutcome = 'sent' | 'failed' | 'skipped' | 'not_sent'
export interface AbsPushResult {
  sourceItemId: string
  title: string
  outcome: AbsPushOutcome
  message: string | null
}
/** A linked ABS item with what ABS holds (`current`) and what My Library would send (`outgoing`). */
export interface AbsPushTarget {
  sourceItemId: string
  sourceId: string
  absItemId: string
  workId: string
  title: string
  current: AbsRecord
  outgoing: AbsRecord
}
export interface AbsOutOfSyncRow {
  sourceItemId: string
  workId: string
  title: string
  diffs: AbsFieldDiff[]
}

/** The hash a diff carries, so a send can tell that either side changed since the page loaded. */
export function absFieldHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

type BaseRow = {
  sourceItemId: string
  sourceId: string
  externalId: string
  workId: string
  raw: unknown
  editionId: string
  title: string | null
  subtitle: string | null
  volume: number | null
  publishedOn: string | null
  publisher: string | null
  language: string | null
  isbn13: string | null
  isbn10: string | null
  asin: string | null
}
type PeopleRow = {
  id: string
  authors: string[]
  narrators: string[]
  series: { name: string; position: number | null; positionEnd: number | null }[]
}

/**
 * Linked, live ABS items with an edition. An `:ebook` row is left out while the same source still has the audiobook row
 * (R10: one ABS item, one send); alone, it stands for the base item.
 */
export async function loadAbsPushTargets(db: Db, sourceItemIds?: readonly string[]): Promise<AbsPushTarget[]> {
  if (sourceItemIds?.length === 0) return []
  const only = sourceItemIds ? sql`and ${sourceItems.id} in (${sql.join(sourceItemIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``
  const base = [
    ...(await db.execute<BaseRow>(sql`select ${sourceItems.id} as "sourceItemId", ${sourceItems.sourceId} as "sourceId", ${sourceItems.externalId} as "externalId",
        ${sourceItems.workId} as "workId", ${sourceItems.raw} as "raw", ${editions.id} as "editionId",
        ${shownEditionTitle(editions.id)} as "title", ${shownEditionSubtitle(editions.id)} as "subtitle",
        ${editions.volume} as "volume", ${editions.publishedOn} as "publishedOn", ${editions.publisher} as "publisher", ${editions.language} as "language",
        ${editions.isbn13} as "isbn13", ${editions.isbn10} as "isbn10", ${editions.asin} as "asin"
      from ${sourceItems}
      join ${sources} on ${sources.id} = ${sourceItems.sourceId}
      join ${editions} on ${editions.id} = ${sourceItems.editionId}
      where ${sources.kind} = 'audiobookshelf' and ${sourceItems.removedAt} is null and ${sourceItems.state} = 'linked'
        and ${sourceItems.workId} is not null
        and not (${sourceItems.externalId} like '%:ebook' and exists (
          select 1 from ${sourceItems} "sib" where "sib"."source_id" = ${sourceItems.sourceId} and "sib"."removed_at" is null
            and "sib"."external_id" = regexp_replace(${sourceItems.externalId}, ':ebook$', '')))
        ${only}`)),
  ]
  if (base.length === 0) return []

  // Names depend on the edition's language (an empty list when it has none: credited, then primary; R9).
  const byLanguage = new Map<string | null, string[]>()
  for (const r of base) byLanguage.set(r.language, [...(byLanguage.get(r.language) ?? []), r.editionId])
  const people = new Map<string, PeopleRow>()
  for (const [language, ids] of byLanguage) {
    const langs = language === null ? [] : [language]
    const rows = await db.execute<PeopleRow>(sql`select ${editions.id} as "id",
        coalesce((select jsonb_agg(${shownWorkName(workContributors.nameId, workContributors.contributorId, langs)} order by ${workContributors.position})
          from ${workContributors} where ${workContributors.workId} = ${editions.workId}), '[]'::jsonb) as "authors",
        coalesce((select jsonb_agg(${shownWorkName(editionContributors.nameId, editionContributors.contributorId, langs)} order by ${editionContributors.position})
          from ${editionContributors} where ${editionContributors.editionId} = ${editions.id} and ${editionContributors.role} = 'narrator'), '[]'::jsonb) as "narrators",
        coalesce((select jsonb_agg(jsonb_build_object('name', ${shownSeriesName(series.id, langs)}, 'position', ${workSeries.position}, 'positionEnd', ${workSeries.positionEnd})
            order by ${workSeries.sortIndex})
          from ${workSeries} join ${series} on ${series.id} = ${workSeries.seriesId} where ${workSeries.workId} = ${editions.workId}), '[]'::jsonb) as "series"
      from ${editions} where ${editions.id} in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)
    for (const row of rows) people.set(row.id, row)
  }

  const targets: AbsPushTarget[] = []
  for (const r of base) {
    const current = currentAbsRecord(r.raw)
    const p = people.get(r.editionId)
    if (current === null || p === undefined) continue
    const title = r.title ?? ''
    const source: AbsEditionSource = {
      title,
      subtitle: r.subtitle,
      volume: r.volume,
      authors: p.authors,
      narrators: p.narrators,
      series: p.series,
      publishedOn: r.publishedOn,
      publisher: r.publisher,
      language: r.language,
      isbn13: r.isbn13,
      isbn10: r.isbn10,
      asin: r.asin,
    }
    targets.push({
      sourceItemId: r.sourceItemId,
      sourceId: r.sourceId,
      absItemId: r.externalId.replace(/:ebook$/, ''),
      workId: r.workId,
      title,
      current,
      outgoing: outgoingAbsRecord(source),
    })
  }
  return targets
}

async function ignoredKeys(db: Db): Promise<Set<string>> {
  const rows = await db.select({ key: healthIgnores.subjectKey }).from(healthIgnores).where(eq(healthIgnores.checkName, 'abs_out_of_sync'))
  return new Set(rows.map((r) => r.key))
}

/** Books where at least one field differs; `showIgnored` flips the list to the ignored ones, like the other checks. */
export async function listAbsOutOfSync(db: Db, input: { showIgnored: boolean }): Promise<{ rows: AbsOutOfSyncRow[]; lastSyncAt: Date | null }> {
  const [targets, ignored] = await Promise.all([loadAbsPushTargets(db), ignoredKeys(db)])
  const rows: AbsOutOfSyncRow[] = []
  for (const t of targets) {
    if (ignored.has(t.sourceItemId) !== input.showIgnored) continue
    const diffs = diffAbs(t.current, t.outgoing, absFieldHash)
    if (diffs.length > 0) rows.push({ sourceItemId: t.sourceItemId, workId: t.workId, title: t.title, diffs })
  }
  rows.sort((a, b) => a.title.localeCompare(b.title) || a.sourceItemId.localeCompare(b.sourceItemId))
  const syncs = await db.select({ at: sources.lastSyncAt }).from(sources).where(eq(sources.kind, 'audiobookshelf'))
  const times = syncs.flatMap((s) => (s.at === null ? [] : [s.at.getTime()]))
  return { rows, lastSyncAt: times.length === 0 ? null : new Date(Math.max(...times)) }
}

/** The Health tab count: not ignored, whatever fields are ticked (R4). */
export async function countAbsOutOfSync(db: Db): Promise<number> {
  return (await listAbsOutOfSync(db, { showIgnored: false })).rows.length
}

export async function getAbsPushFields(db: Db, userId: string): Promise<AbsPushField[]> {
  const [row] = await db.select({ fields: users.absPushFields }).from(users).where(eq(users.id, userId))
  return (row?.fields ?? []).filter((f): f is AbsPushField => (absPushFields as readonly string[]).includes(f))
}

export async function setAbsPushFields(db: Db, userId: string, fields: readonly AbsPushField[]): Promise<void> {
  await db.update(users).set({ absPushFields: [...fields] }).where(eq(users.id, userId))
}

// ---- the send run ----------------------------------------------------------------

/** Starts a run, or returns null when one is already running (the partial unique index). */
export async function startAbsPushRun(db: Db, requestedBy: string, books: AbsPushSendInput['books']): Promise<string | null> {
  const [row] = await db.insert(absPushRuns).values({ requestedBy, request: books }).onConflictDoNothing().returning({ id: absPushRuns.id })
  return row?.id ?? null
}

const runColumns = {
  id: absPushRuns.id,
  status: absPushRuns.status,
  request: absPushRuns.request,
  results: absPushRuns.results,
  error: absPushRuns.error,
  startedAt: absPushRuns.startedAt,
  finishedAt: absPushRuns.finishedAt,
}
export type AbsPushRunRecord = {
  id: string
  status: 'running' | 'succeeded' | 'failed' | 'stopped'
  request: AbsPushSendInput['books']
  results: AbsPushResult[]
  error: string | null
  startedAt: Date
  finishedAt: Date | null
}

export async function getAbsPushRun(db: Db, runId: string): Promise<AbsPushRunRecord | null> {
  const [row] = await db.select(runColumns).from(absPushRuns).where(eq(absPushRuns.id, runId))
  return row ?? null
}

export async function lastAbsPushRun(db: Db): Promise<AbsPushRunRecord | null> {
  const [row] = await db.select(runColumns).from(absPushRuns).orderBy(desc(absPushRuns.startedAt)).limit(1)
  return row ?? null
}

/** Appends in SQL, so batches writing at the same time never lose each other's entries. */
export async function recordAbsPushResult(db: Db, runId: string, result: AbsPushResult): Promise<void> {
  await db
    .update(absPushRuns)
    .set({ results: sql`${absPushRuns.results} || jsonb_build_array(${JSON.stringify(result)}::jsonb)` })
    .where(eq(absPushRuns.id, runId))
}

export async function finishAbsPushRun(db: Db, runId: string, status: 'succeeded' | 'failed' | 'stopped', error: string | null): Promise<void> {
  await db.update(absPushRuns).set({ status, error, finishedAt: new Date() }).where(eq(absPushRuns.id, runId))
}

/** Start-up: a run the worker never finished (it was restarted) cannot be resumed. */
export async function failRunningAbsPushRuns(db: Db, message: string): Promise<number> {
  const rows = await db
    .update(absPushRuns)
    .set({ status: 'failed', error: message, finishedAt: new Date() })
    .where(eq(absPushRuns.status, 'running'))
    .returning({ id: absPushRuns.id })
  return rows.length
}
