import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { ExternalItem, HardcoverAccountStatus, HardcoverBookData, HardcoverMatchKind, HardcoverPushStatus, HardcoverTags, WorkCard } from '@mylib/domain'
import type { Db } from '../client'
import { contributors, editions, hardcoverAccounts, hardcoverBooks, hardcoverPushes, hardcoverRecommendations, hardcoverRuns, series, sourceItems, userWorks, workContributors, workSeries, works } from '../schema'
import { SecretUnreadableError, type SecretBox } from '../secrets'
import { getWorkCards } from './library'
import { assertVisibleWork, type UserScope } from './scope'
import { shownSeriesName } from './series-names'
import { shownTitleField } from './titles'

export type HardcoverScope = { kind: 'household' } | { kind: 'user'; userId: string }

export interface HardcoverAccountView {
  id: string
  scope: 'household' | 'user'
  userId: string | null
  hardcoverUserId: number
  username: string
  status: HardcoverAccountStatus
  statusDetail: string | null
  sendFinished: boolean
  checkedAt: Date
}
export interface HardcoverAccountWithToken extends HardcoverAccountView {
  token: string
}

const viewColumns = {
  id: hardcoverAccounts.id,
  scope: hardcoverAccounts.scope,
  userId: hardcoverAccounts.userId,
  hardcoverUserId: hardcoverAccounts.hardcoverUserId,
  username: hardcoverAccounts.username,
  status: hardcoverAccounts.status,
  statusDetail: hardcoverAccounts.statusDetail,
  sendFinished: hardcoverAccounts.sendFinished,
  checkedAt: hardcoverAccounts.checkedAt,
}

const whereScope = (scope: HardcoverScope) =>
  scope.kind === 'household' ? eq(hardcoverAccounts.scope, 'household') : and(eq(hardcoverAccounts.scope, 'user'), eq(hardcoverAccounts.userId, scope.userId))

function opened(box: SecretBox, row: HardcoverAccountView & { token: string }): HardcoverAccountWithToken | null {
  try {
    return { ...row, token: box.open(row.token) }
  } catch (error) {
    // APP_SECRET_KEY changed: the token is unusable until it is entered again
    if (error instanceof SecretUnreadableError) return null
    throw error
  }
}

export async function getHardcoverAccount(db: Db, scope: HardcoverScope): Promise<HardcoverAccountView | null> {
  const [row] = await db.select(viewColumns).from(hardcoverAccounts).where(whereScope(scope))
  return row ?? null
}

export async function getHardcoverAccountWithToken(db: Db, box: SecretBox, scope: HardcoverScope): Promise<HardcoverAccountWithToken | null> {
  const [row] = await db.select({ ...viewColumns, token: hardcoverAccounts.token }).from(hardcoverAccounts).where(whereScope(scope))
  return row ? opened(box, row) : null
}

export async function listUserAccountsWithToken(db: Db, box: SecretBox): Promise<HardcoverAccountWithToken[]> {
  const rows = await db.select({ ...viewColumns, token: hardcoverAccounts.token }).from(hardcoverAccounts).where(eq(hardcoverAccounts.scope, 'user'))
  return rows.flatMap((r) => {
    const o = opened(box, r)
    return o ? [o] : []
  })
}

export async function saveHardcoverAccount(
  db: Db,
  box: SecretBox,
  scope: HardcoverScope,
  input: { token: string; hardcoverUserId: number; username: string; now: Date },
): Promise<HardcoverAccountView> {
  const values = { token: box.seal(input.token), hardcoverUserId: input.hardcoverUserId, username: input.username, status: 'ok' as const, statusDetail: null, checkedAt: input.now }
  const existing = await getHardcoverAccount(db, scope)
  if (existing) {
    await db.update(hardcoverAccounts).set(values).where(eq(hardcoverAccounts.id, existing.id))
  } else {
    await db.insert(hardcoverAccounts).values({ ...values, scope: scope.kind, userId: scope.kind === 'user' ? scope.userId : null })
  }
  const saved = await getHardcoverAccount(db, scope)
  if (!saved) throw new Error('hardcover account save failed')
  return saved
}

export async function setHardcoverAccountStatus(db: Db, accountId: string, status: HardcoverAccountStatus, detail: string | null, now: Date): Promise<void> {
  await db.update(hardcoverAccounts).set({ status, statusDetail: detail, checkedAt: now }).where(eq(hardcoverAccounts.id, accountId))
}

export async function removeHardcoverAccount(db: Db, scope: HardcoverScope): Promise<void> {
  await db.delete(hardcoverAccounts).where(whereScope(scope))
}

/** On: books finished from now go to Hardcover (send_since keeps its first value while it stays on). Off: none. */
export async function setSendFinished(db: Db, userId: string, on: boolean, now: Date): Promise<void> {
  await db
    .update(hardcoverAccounts)
    .set(on ? { sendFinished: true, sendSince: sql`coalesce(${hardcoverAccounts.sendSince}, ${now.toISOString()}::timestamptz)` } : { sendFinished: false, sendSince: null })
    .where(and(eq(hardcoverAccounts.scope, 'user'), eq(hardcoverAccounts.userId, userId)))
}

export const HARDCOVER_RECHECK_DAYS = 7
const DAY_MS = 86_400_000
const SIMILAR_SHOWN = 6

export interface MatchCandidate {
  workId: string
  title: string
  authors: string[]
  isbns: string[]
  /** an Open Library id a linked source item carries (shelf photo, paste-link): the bridge for translated books */
  openLibraryId: string | null
  /** the work's series names, any order; [] when none */
  series: string[]
}

export async function openLibraryIdsFor(db: Db, workIds: readonly string[]): Promise<Map<string, string>> {
  if (workIds.length === 0) return new Map()
  const rows = await db
    .select({ workId: sourceItems.workId, id: sql<string>`${sourceItems.normalized}->'identifiers'->'others'->>'openlibrary'` })
    .from(sourceItems)
    .where(and(inArray(sourceItems.workId, [...workIds]), eq(sourceItems.state, 'linked'), sql`${sourceItems.normalized}->'identifiers'->'others' ? 'openlibrary'`))
  const out = new Map<string, string>()
  for (const r of rows) if (r.workId !== null && !out.has(r.workId)) out.set(r.workId, r.id)
  return out
}

export async function listMatchCandidates(db: Db, now: Date, limit: number): Promise<MatchCandidate[]> {
  const rows = await db
    // Hardcover is English: the search uses the book's English title when it has one (#145), else the primary
    .select({ workId: works.id, title: shownTitleField(works.id, ['en'], 'title') })
    .from(works)
    .leftJoin(hardcoverBooks, eq(hardcoverBooks.workId, works.id))
    .where(or(isNull(hardcoverBooks.workId), and(eq(hardcoverBooks.match, 'none'), lte(hardcoverBooks.nextCheckAt, now))))
    .orderBy(asc(works.sortTitle), asc(works.id))
    .limit(limit)
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.workId)
  const [isbnRows, authorRows, seriesRows, olIds] = await Promise.all([
    db.select({ workId: editions.workId, isbn13: editions.isbn13, isbn10: editions.isbn10 }).from(editions).where(inArray(editions.workId, ids)),
    db
      .select({ workId: workContributors.workId, name: contributors.name })
      .from(workContributors)
      .innerJoin(contributors, eq(contributors.id, workContributors.contributorId))
      .where(inArray(workContributors.workId, ids))
      .orderBy(asc(workContributors.position)),
    db
      .select({ workId: workSeries.workId, name: shownSeriesName(series.id, ['en']) })
      .from(workSeries)
      .innerJoin(series, eq(series.id, workSeries.seriesId))
      .where(inArray(workSeries.workId, ids)),
    openLibraryIdsFor(db, ids),
  ])
  return rows.map((r) => ({
    workId: r.workId,
    series: seriesRows.filter((s) => s.workId === r.workId).map((s) => s.name),
    openLibraryId: olIds.get(r.workId) ?? null,
    title: r.title,
    authors: authorRows.filter((a) => a.workId === r.workId).map((a) => a.name),
    isbns: [...new Set(isbnRows.filter((e) => e.workId === r.workId).flatMap((e) => [e.isbn13, e.isbn10].filter((v): v is string => v !== null)))],
  }))
}

const bookColumns = (book: HardcoverBookData, now: Date) => ({
  hardcoverId: book.id,
  slug: book.slug,
  rating: book.rating,
  ratingsCount: book.ratingsCount,
  tags: book.tags,
  similarIds: book.similarIds,
  fetchedAt: now,
  nextCheckAt: null,
})

export async function saveMatch(db: Db, workId: string, match: { kind: 'isbn' | 'title' | 'openlibrary' | 'manual'; book: HardcoverBookData } | { kind: 'none' }, now: Date): Promise<void> {
  const values =
    match.kind === 'none'
      ? { match: 'none' as const, hardcoverId: null, slug: null, rating: null, ratingsCount: 0, tags: { genre: [], mood: [] }, similarIds: [], fetchedAt: now, nextCheckAt: new Date(now.getTime() + HARDCOVER_RECHECK_DAYS * DAY_MS) }
      : { match: match.kind, ...bookColumns(match.book, now) }
  await db.insert(hardcoverBooks).values({ workId, ...values }).onConflictDoUpdate({ target: hardcoverBooks.workId, set: values })
}

/**
 * An Inbox item that was looked up on Hardcover carries its id: when the book is added, link it (manual). The epoch
 * `fetchedAt` makes the next refresh fill rating, tags and similar. A book that already has a link or a rejection is
 * left alone; only a "no match" row is filled.
 */
export async function linkHardcoverFromItem(db: Db, workId: string, item: ExternalItem): Promise<void> {
  const id = item.identifiers.others['hardcover']
  if (id === undefined || !/^[1-9]\d*$/.test(id)) return
  const hardcoverId = Number(id)
  if (!Number.isSafeInteger(hardcoverId) || hardcoverId > 2147483647) return
  const values = { match: 'manual' as const, hardcoverId, slug: null, fetchedAt: new Date(0), nextCheckAt: null }
  await db
    .insert(hardcoverBooks)
    .values({ workId, ...values })
    .onConflictDoUpdate({ target: hardcoverBooks.workId, set: values, setWhere: eq(hardcoverBooks.match, 'none') })
}

export async function listStaleHardcoverIds(db: Db, now: Date, limit: number): Promise<number[]> {
  const before = new Date(now.getTime() - HARDCOVER_RECHECK_DAYS * DAY_MS)
  const rows = await db
    .selectDistinct({ id: hardcoverBooks.hardcoverId })
    .from(hardcoverBooks)
    .where(and(inArray(hardcoverBooks.match, ['isbn', 'title', 'openlibrary', 'manual']), lte(hardcoverBooks.fetchedAt, before)))
    .orderBy(asc(hardcoverBooks.hardcoverId))
    .limit(limit)
  return rows.flatMap((r) => (r.id === null ? [] : [r.id]))
}

/** A Hardcover book can back several works (two works sharing an ISBN): all of them get the new data. */
export async function saveBookData(db: Db, book: HardcoverBookData, now: Date): Promise<void> {
  await db.update(hardcoverBooks).set(bookColumns(book, now)).where(eq(hardcoverBooks.hardcoverId, book.id))
}

export async function touchHardcoverBooks(db: Db, hardcoverIds: number[], now: Date): Promise<void> {
  if (hardcoverIds.length === 0) return
  await db.update(hardcoverBooks).set({ fetchedAt: now }).where(inArray(hardcoverBooks.hardcoverId, hardcoverIds))
}

export async function rejectHardcoverMatch(db: Db, scope: UserScope, workId: string): Promise<void> {
  await assertVisibleWork(db, scope, workId)
  const values = { match: 'rejected' as const, hardcoverId: null, slug: null, rating: null, ratingsCount: 0, tags: { genre: [], mood: [] }, similarIds: [], nextCheckAt: null }
  await db.insert(hardcoverBooks).values({ workId, ...values }).onConflictDoUpdate({ target: hardcoverBooks.workId, set: values })
}

export interface HardcoverWorkView {
  match: HardcoverMatchKind
  /** for Hardcover's stable /id/book/<id> link (slugs can change) */
  hardcoverId: number | null
  slug: string | null
  rating: number | null
  ratingsCount: number
  tags: HardcoverTags
  similar: WorkCard[]
}

export async function getHardcoverForWork(db: Db, scope: UserScope, workId: string): Promise<HardcoverWorkView | null> {
  await assertVisibleWork(db, scope, workId)
  const [row] = await db.select().from(hardcoverBooks).where(eq(hardcoverBooks.workId, workId))
  if (!row) return null
  const similarIds = row.similarIds.slice(0, 100)
  const linked =
    similarIds.length === 0
      ? []
      : await db
          .select({ workId: hardcoverBooks.workId, hardcoverId: hardcoverBooks.hardcoverId })
          .from(hardcoverBooks)
          .innerJoin(works, eq(works.id, hardcoverBooks.workId))
          .where(and(inArray(hardcoverBooks.hardcoverId, similarIds), scope.visible, sql`${hardcoverBooks.workId} <> ${workId}`))
  const rank = new Map(similarIds.map((id, i) => [id, i]))
  const ordered = [...linked].sort((a, b) => (rank.get(a.hardcoverId ?? -1) ?? 0) - (rank.get(b.hardcoverId ?? -1) ?? 0))
  const firstWorkIds = [...new Set(ordered.map((l) => l.workId))].slice(0, SIMILAR_SHOWN)
  const cards = await getWorkCards(db, scope, firstWorkIds)
  const byId = new Map(cards.map((c) => [c.id, c]))
  return {
    match: row.match,
    hardcoverId: row.hardcoverId,
    slug: row.slug,
    rating: row.rating,
    ratingsCount: row.ratingsCount,
    tags: row.tags,
    similar: firstWorkIds.flatMap((id) => {
      const c = byId.get(id)
      return c ? [c] : []
    }),
  }
}

export async function startHardcoverRun(db: Db, input: { kind: 'refresh' | 'send'; trigger: 'schedule' | 'manual'; requestedBy: string | null }): Promise<string | null> {
  const [row] = await db.insert(hardcoverRuns).values(input).onConflictDoNothing().returning({ id: hardcoverRuns.id })
  return row?.id ?? null
}

export async function finishHardcoverRun(db: Db, runId: string, result: { status: 'succeeded' | 'failed' | 'stopped'; stats: Record<string, number>; error: string | null }): Promise<void> {
  await db.update(hardcoverRuns).set({ ...result, finishedAt: new Date() }).where(eq(hardcoverRuns.id, runId))
}

/** A worker restart or shutdown left these "running"; without this the one-running index would answer "busy" forever. Only safe with exactly one worker. */
export async function failRunningHardcoverRuns(db: Db, message: string): Promise<number> {
  const rows = await db.update(hardcoverRuns).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(hardcoverRuns.status, 'running')).returning({ id: hardcoverRuns.id })
  return rows.length
}

export async function lastHardcoverRun(db: Db, kind: 'refresh' | 'send') {
  const [row] = await db
    .select({ status: hardcoverRuns.status, stats: hardcoverRuns.stats, error: hardcoverRuns.error, startedAt: hardcoverRuns.startedAt, finishedAt: hardcoverRuns.finishedAt })
    .from(hardcoverRuns)
    .where(eq(hardcoverRuns.kind, kind))
    .orderBy(desc(hardcoverRuns.startedAt))
    .limit(1)
  return row ?? null
}

export async function saveRecommendations(db: Db, accountId: string, hardcoverIds: number[], now: Date): Promise<void> {
  await db.insert(hardcoverRecommendations).values({ accountId, hardcoverIds, fetchedAt: now }).onConflictDoUpdate({ target: hardcoverRecommendations.accountId, set: { hardcoverIds, fetchedAt: now } })
}

/** Spec: books a person finished since turning sending on, each once (a re-read is not sent again). */
export async function queueFinishedPushes(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    with inserted as (
      insert into hardcover_push (account_id, work_id, session_id, finished_on)
      select distinct on (a.id, s.work_id) a.id, s.work_id, s.id, s.finished_on
      from hardcover_account a
      join reading_session s on s.user_id = a.user_id and s.outcome = 'finished' and s.updated_at >= a.send_since
        -- no backfill: a past read added or edited after the switch went on is not "finished since" (a day of slack for time zones)
        and s.finished_on is not null and s.finished_on >= (a.send_since at time zone 'UTC')::date - 1
        -- an unknown finish date ("long ago") is stored as the day it was entered: not a read since the switch
        and s.finished_precision <> 'unknown'
      where a.scope = 'user' and a.send_finished and a.status = 'ok'
      order by a.id, s.work_id, s.updated_at desc
      on conflict do nothing
      returning 1
    ) select count(*)::int as n from inserted`)
  return rows[0]?.n ?? 0
}

export interface WaitingPush {
  accountId: string
  userId: string
  workId: string
  hardcoverId: number | null
  finishedOn: string | null
  rating: number | null
}

export async function listWaitingPushes(db: Db, limit: number): Promise<WaitingPush[]> {
  const rows = await db
    .select({
      accountId: hardcoverPushes.accountId,
      userId: hardcoverAccounts.userId,
      workId: hardcoverPushes.workId,
      hardcoverId: hardcoverBooks.hardcoverId,
      finishedOn: hardcoverPushes.finishedOn,
      rating: userWorks.rating,
    })
    .from(hardcoverPushes)
    .innerJoin(hardcoverAccounts, eq(hardcoverAccounts.id, hardcoverPushes.accountId))
    .innerJoin(hardcoverBooks, and(eq(hardcoverBooks.workId, hardcoverPushes.workId), sql`${hardcoverBooks.hardcoverId} is not null`))
    .leftJoin(userWorks, and(eq(userWorks.userId, hardcoverAccounts.userId), eq(userWorks.workId, hardcoverPushes.workId)))
    // a broken account's rows stay waiting, but must not fill the page; send_finished stays unfiltered so turned-off rows still reach the worker
    .where(and(eq(hardcoverPushes.status, 'waiting'), eq(hardcoverAccounts.status, 'ok'), sql`${hardcoverPushes.finishedOn} is not null`))
    .orderBy(asc(hardcoverPushes.createdAt))
    .limit(limit)
  return rows.map((r) => ({ ...r, userId: r.userId ?? '' }))
}

export async function markPush(db: Db, accountId: string, workId: string, status: 'sent' | 'skipped', reason: string | null, now: Date): Promise<void> {
  await db
    .update(hardcoverPushes)
    .set({ status, reason, sentAt: status === 'sent' ? now : null })
    .where(and(eq(hardcoverPushes.accountId, accountId), eq(hardcoverPushes.workId, workId)))
}

/** A send that failed: the row stays waiting (it is tried again next run), with the reason for My account's list. */
export async function notePushError(db: Db, accountId: string, workId: string, reason: string): Promise<void> {
  await db
    .update(hardcoverPushes)
    .set({ reason })
    .where(and(eq(hardcoverPushes.accountId, accountId), eq(hardcoverPushes.workId, workId), eq(hardcoverPushes.status, 'waiting')))
}

export async function listMyPushes(db: Db, scope: Pick<UserScope, 'userId' | 'languages'>, limit: number) {
  return db
    .select({ workId: hardcoverPushes.workId, title: shownTitleField(works.id, scope.languages, 'title'), status: hardcoverPushes.status, reason: hardcoverPushes.reason, createdAt: hardcoverPushes.createdAt, sentAt: hardcoverPushes.sentAt })
    .from(hardcoverPushes)
    .innerJoin(hardcoverAccounts, eq(hardcoverAccounts.id, hardcoverPushes.accountId))
    .innerJoin(works, eq(works.id, hardcoverPushes.workId))
    .where(eq(hardcoverAccounts.userId, scope.userId))
    .orderBy(desc(hardcoverPushes.createdAt))
    .limit(limit)
}

/** The person's push rows by status, for the card's summary line (its list shows only the latest few). */
export async function countMyPushes(db: Db, userId: string): Promise<Record<HardcoverPushStatus, number>> {
  const rows = await db
    .select({ status: hardcoverPushes.status, n: sql<number>`count(*)::int` })
    .from(hardcoverPushes)
    .innerJoin(hardcoverAccounts, eq(hardcoverAccounts.id, hardcoverPushes.accountId))
    .where(eq(hardcoverAccounts.userId, userId))
    .groupBy(hardcoverPushes.status)
  const counts: Record<HardcoverPushStatus, number> = { waiting: 0, sent: 0, skipped: 0 }
  for (const r of rows) counts[r.status] = r.n
  return counts
}

/**
 * Past reads (#140): the person's finished books that have no push row yet, one per book (its latest finish).
 * Only for a linked, ok account with sending on — the same account the hourly send serves.
 */
const pastReads = (userId: string) => sql`
  select distinct on (s.work_id) a.id as account_id, s.work_id, s.id as session_id, s.finished_on
  from hardcover_account a
  join reading_session s on s.user_id = a.user_id and s.outcome = 'finished' and s.finished_on is not null
  where a.scope = 'user' and a.user_id = ${userId} and a.send_finished and a.status = 'ok'
    and not exists (select 1 from hardcover_push p where p.account_id = a.id and p.work_id = s.work_id)
  order by s.work_id, s.finished_on desc, s.updated_at desc`

/** How many past reads "Send my past reads" would queue, and how many of them Hardcover has matched (the rest wait for a match). */
export async function countPastPushes(db: Db, userId: string): Promise<{ total: number; matched: number }> {
  const rows = await db.execute<{ total: number; matched: number }>(sql`
    select count(*)::int as total, count(b.hardcover_id)::int as matched
    from (${pastReads(userId)}) r
    left join hardcover_book b on b.work_id = r.work_id`)
  return { total: rows[0]?.total ?? 0, matched: rows[0]?.matched ?? 0 }
}

/** Queues the past reads as waiting pushes; the hourly send takes them a run's worth at a time. Safe to repeat: existing rows are kept. */
export async function queuePastPushes(db: Db, userId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    with inserted as (
      insert into hardcover_push (account_id, work_id, session_id, finished_on)
      select account_id, work_id, session_id, finished_on from (${pastReads(userId)}) r
      on conflict do nothing
      returning 1
    ) select count(*)::int as n from inserted`)
  return rows[0]?.n ?? 0
}
