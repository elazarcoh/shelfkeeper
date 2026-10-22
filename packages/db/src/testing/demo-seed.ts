/**
 * Seeds the fake household from demo-data.ts into a database that already has its first admin
 * (`pnpm dev:seed-demo`; reusable by tests). Everything goes through the repositories, the same way
 * the app writes it, so invariants and derived data (search rows, statuses, daily stats) hold. The only
 * direct writes are timestamps the app always stamps with "now" (when a book was added, when a session
 * was logged, when a rating was given): they are backdated so the history looks lived-in.
 *
 * The whole seed is one transaction: it either lands completely or not at all.
 */
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import {
  AddProgressInput,
  CompleteSessionInput,
  CreateSetInput,
  CreateSourceInput,
  CsvImportInput,
  ExternalItem,
  GoalInput,
  HoldingChange,
  LoanInput,
  StartSessionInput,
  editionFormatsForMode,
  ok,
  type CreateWorkInput,
  type FilterNode,
  type ItemError,
  type Result,
} from '@mylib/domain'
import type { Db } from '../client'
import { addWorkToSet, assignSetToUser, createSet, getDefaultPersonalSetId, hideSetFromUser, hideWorkFromUser, updateSet } from '../repos/sets'
import { createWork, changeHolding, getWorkDetail, type EditionDetail } from '../repos/catalog'
import { importCsv } from '../repos/csv-import'
import { createGoal } from '../repos/goals'
import { listInbox, resolveSourceMatch } from '../repos/inbox'
import { claimSyncRun, createSyncRun, finishSyncRun } from '../repos/job-runs'
import { createLoan, returnLoan } from '../repos/loans'
import { upsertTags } from '../repos/lookups'
import { addProgressPoint } from '../repos/progress'
import { completeSession, startSession } from '../repos/reading-sessions'
import { loadUserScope, type UserScope } from '../repos/scope'
import { createSource } from '../repos/sources'
import { rebuildDailyStats } from '../repos/stats'
import { syncSource } from '../repos/sync'
import { addToQueue, setRating, setReview, setStatus } from '../repos/tracking'
import { createUser, findUserForLogin, listUsers, setPinHash, type UserRecord } from '../repos/users'
import { editions, readingSessions, userWorks, works } from '../schema'
import type { SecretBox } from '../secrets'
import {
  DEMO_ABS_ITEMS,
  DEMO_ACCEPTED_WANTED,
  DEMO_CSV,
  DEMO_FAMILY_SHELF,
  DEMO_GROWN_UP_SHELF,
  DEMO_HIDDEN_FROM_TEEN,
  DEMO_HISTORY,
  DEMO_LOANS,
  DEMO_MANUAL_SETS,
  DEMO_MEMBERS,
  DEMO_READARR_ITEMS,
  DEMO_SMART_SETS,
  DEMO_WORKS,
  type DemoSession,
  type DemoSourceItem,
  type DemoWho,
  type DemoWork,
} from './demo-data'

export class DemoAlreadySeededError extends Error {
  constructor(username: string) {
    super(
      `The demo data is already in this database (user "${username}" exists). Nothing was changed. ` +
        'To seed again, start from an empty database (e.g. pnpm db:down, remove the volume, pnpm db:up, set up the first admin).',
    )
    this.name = 'DemoAlreadySeededError'
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** The demo seed only ever runs against a local, non-production database. Returns the reason it refuses, or null. */
export function demoTargetRefusal(databaseUrl: string, nodeEnv: string | undefined): string | null {
  if (nodeEnv === 'production') return 'NODE_ENV is "production": the demo seed only runs in development.'
  let host: string
  try {
    host = new URL(databaseUrl).hostname.toLowerCase()
  } catch {
    return 'DATABASE_URL is not a valid URL.'
  }
  if (!LOCAL_HOSTS.has(host)) return `DATABASE_URL points at "${host}": the demo seed only writes to localhost / 127.0.0.1.`
  return null
}

export interface SeedDemoOptions {
  /** the app's password/PIN hash (apps/server auth); tests may pass something cheap */
  hashSecret: (secret: string) => Promise<string>
  /** seals the demo sources' fake API tokens — use the app's APP_SECRET_KEY box so Admin → Sources can read them */
  secretBox: SecretBox
  /** YYYY-MM-DD; the history ends on this day (default: today, UTC) */
  today?: string
  log?: (line: string) => void
}

export interface DemoSeedSummary {
  admin: { id: string; username: string }
  members: { username: string; displayName: string; password: string; pin: string }[]
  works: number
  editions: number
  sessions: number
  progressPoints: number
  ratings: number
  loans: number
  sets: number
  goals: number
  pendingInbox: number
  csvProposals: number
}

// ---- dates --------------------------------------------------------------------------------------

const DAY_MS = 86_400_000

function dayBefore(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10)
}

function withPrecision(date: string, precision: 'day' | 'month' | 'year'): string {
  if (precision === 'month') return `${date.slice(0, 7)}-01`
  if (precision === 'year') return `${date.slice(0, 4)}-01-01`
  return date
}

const at = (date: string, minutes: number): Date => new Date(Date.parse(`${date}T17:00:00Z`) + (minutes % 300) * 60_000)

// ---- helpers ------------------------------------------------------------------------------------

/** A made-up but valid ISBN-13 (978 prefix), unique per n. */
function fakeIsbn13(n: number): string {
  const body = `978${String((n * 7_919_423 + 104_729) % 1_000_000_000).padStart(9, '0')}`
  let sum = 0
  for (let i = 0; i < body.length; i++) sum += Number(body.charAt(i)) * (i % 2 === 0 ? 1 : 3)
  return `${body}${(10 - (sum % 10)) % 10}`
}

function allHistoryBooks(): Set<string> {
  const keys = new Set<string>()
  for (const h of Object.values(DEMO_HISTORY)) {
    for (const s of h.sessions) keys.add(s.book)
    for (const list of [Object.keys(h.ratings), Object.keys(h.reviews ?? {}), h.wantToRead ?? [], h.readLongAgo ?? [], h.queue, h.myBooks]) {
      for (const k of list) keys.add(k)
    }
  }
  for (const s of [DEMO_FAMILY_SHELF, DEMO_GROWN_UP_SHELF, ...DEMO_MANUAL_SETS]) for (const k of s.books) keys.add(k)
  for (const l of DEMO_LOANS) keys.add(l.book)
  keys.add(DEMO_HIDDEN_FROM_TEEN)
  return keys
}

/** When a book entered the catalog: as given, else a week before anyone first used it, else spread over the last ~20 months. */
function addedDaysAgo(work: DemoWork, index: number): number {
  if (work.addedDaysAgo !== undefined) return work.addedDaysAgo
  const starts = Object.values(DEMO_HISTORY).flatMap((h) => h.sessions.filter((s) => s.book === work.key).map((s) => s.start))
  const loans = DEMO_LOANS.filter((l) => l.book === work.key).map((l) => l.lentDaysAgo)
  const firstUse = Math.max(-1, ...starts, ...loans)
  return firstUse >= 0 ? firstUse + 7 : 600 - ((index * 37) % 560)
}

function workInput(work: DemoWork, added: string, isbnSeed: number): CreateWorkInput {
  return {
    title: work.title,
    subtitle: work.subtitle ?? null,
    description: work.description ?? null,
    originalYear: work.year ?? null,
    authors: work.authors,
    series: work.series ? [{ ...work.series, positionEnd: work.series.positionEnd ?? null }] : [],
    tags: work.tags ?? [],
    editions: work.editions.map((e, i) => ({
      format: e.format,
      title: e.title ?? null,
      subtitle: null,
      isbn13: e.format === 'physical' && e.isbn !== false ? fakeIsbn13(isbnSeed * 10 + i) : null,
      isbn10: null,
      asin: null,
      publisher: e.publisher ?? null,
      publishedOn: e.publishedOn ?? null,
      pageCount: e.pageCount ?? null,
      wordCount: e.wordCount ?? null,
      durationSec: e.hours === undefined ? null : Math.round(e.hours * 3600),
      language: e.language ?? work.language ?? null,
      shelfLocation: e.shelfLocation ?? null,
      volume: null,
      volumeCount: null,
      narrators: e.narrators ?? [],
      translators: e.translators ?? [],
      ownership: e.ownership ?? 'owned',
      holdingOn: added,
      holdingNote: e.holdingNote ?? null,
    })),
  }
}

async function* feed(items: readonly DemoSourceItem[]): AsyncIterable<Result<ExternalItem, ItemError>> {
  await Promise.resolve()
  for (const i of items) {
    yield ok(
      ExternalItem.parse({
        externalId: i.externalId,
        format: i.format,
        title: i.title,
        authors: i.authors,
        narrators: i.narrators ?? [],
        series: i.series ?? [],
        durationSec: i.durationSec ?? null,
        wantedOnly: i.wantedOnly ?? false,
      }),
    )
  }
}

interface SeededWork {
  id: string
  editions: EditionDetail[]
}

function pickEdition(work: SeededWork, s: DemoSession): string | null {
  const formats = s.format ? [s.format] : editionFormatsForMode(s.mode)
  const match = work.editions.find(
    (e) => formats.includes(e.format) && (s.language === undefined || e.language === s.language),
  )
  return match?.id ?? null
}

// ---- the seed -----------------------------------------------------------------------------------

export async function seedDemo(db: Db, options: SeedDemoOptions): Promise<DemoSeedSummary> {
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const day = (daysAgo: number) => dayBefore(today, daysAgo)
  const log = options.log ?? (() => undefined)

  const known = new Set(DEMO_WORKS.map((w) => w.key))
  const unknown = [...allHistoryBooks()].filter((k) => !known.has(k))
  if (unknown.length > 0) throw new Error(`demo-data refers to unknown books: ${unknown.join(', ')}`)

  return db.transaction(async (tx) => {
    // two seeds racing each other: the second waits, then sees the first one's users and refuses
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mylib:demo-seed'))`)
    for (const m of DEMO_MEMBERS) {
      if (await findUserForLogin(tx, m.username)) throw new DemoAlreadySeededError(m.username)
    }
    const adminUser = (await listUsers(tx)).find((u) => u.role === 'admin')
    if (!adminUser) throw new Error('No admin yet: open the app and create the first admin, then run the demo seed.')
    let admin = await loadUserScope(tx, adminUser)

    // global sets first: "Family shelf" is a default for new users, so the members get it on creation
    log('sets and people')
    const family = await createSet(tx, admin, CreateSetInput.parse({ kind: 'manual', scope: 'global', name: DEMO_FAMILY_SHELF.name }))
    await updateSet(tx, admin, family.id, { defaultForNewUsers: true })
    const grownUp = await createSet(tx, admin, CreateSetInput.parse({ kind: 'manual', scope: 'global', name: DEMO_GROWN_UP_SHELF.name }))
    await assignSetToUser(tx, admin, adminUser.id, family.id, true)
    await assignSetToUser(tx, admin, adminUser.id, grownUp.id, true)

    const users: Record<DemoWho, UserRecord> = { admin: adminUser, partner: adminUser, teen: adminUser }
    for (const m of DEMO_MEMBERS) {
      const user = await createUser(tx, { username: m.username, displayName: m.displayName, passwordHash: await options.hashSecret(m.password), role: m.role })
      await setPinHash(tx, user.id, await options.hashSecret(m.pin))
      users[m.who] = user
    }

    // the catalog
    log(`${DEMO_WORKS.length} books`)
    const seeded = new Map<string, SeededWork>()
    const addedOn = new Map<string, number>()
    for (const [index, work] of DEMO_WORKS.entries()) {
      const added = addedDaysAgo(work, index)
      addedOn.set(work.key, added)
      const id = await createWork(tx, workInput(work, day(added), index + 1), adminUser.id)
      const detail = await getWorkDetail(tx, admin, id)
      seeded.set(work.key, { id, editions: detail.editions })
    }
    const book = (key: string): SeededWork => {
      const w = seeded.get(key)
      if (!w) throw new Error(`unknown demo book ${key}`)
      return w
    }
    const editionOf = (key: string, format: 'physical' | 'ebook' | 'audiobook', title?: string): string => {
      const e = book(key).editions.find((x) => x.format === format && (title === undefined || x.title === title))
      if (!e) throw new Error(`demo book ${key} has no ${format} edition`)
      return e.id
    }

    // holding history: borrowed copies returned or bought, copies given away and found again
    for (const work of DEMO_WORKS) {
      for (const e of work.editions) {
        for (const change of e.changes ?? []) {
          const editionId = editionOf(work.key, e.format, e.title)
          await changeHolding(tx, admin, editionId, HoldingChange.parse({ action: change.action, on: day(change.daysAgo), note: change.note ?? null }))
        }
      }
    }

    // global set contents and what the teen does not see
    for (const key of DEMO_FAMILY_SHELF.books) await addWorkToSet(tx, admin, family.id, book(key).id)
    for (const key of DEMO_GROWN_UP_SHELF.books) await addWorkToSet(tx, admin, grownUp.id, book(key).id)
    await hideSetFromUser(tx, admin, users.teen.id, grownUp.id)
    await hideWorkFromUser(tx, admin, users.teen.id, book(DEMO_HIDDEN_FROM_TEEN).id)

    // smart sets (tags are looked up by name; upsert returns the existing ids)
    let setCount = 2
    for (const s of DEMO_SMART_SETS) {
      let filter: FilterNode
      if ('filter' in s) {
        filter = s.filter
      } else {
        const tagIds = await upsertTags(tx, s.tagFilter.tags)
        filter = { op: 'and', nodes: [{ op: 'tag', tagIds }, { op: 'not', node: { op: 'status', statuses: [s.tagFilter.notStatus] } }] }
      }
      const owner = s.who === 'global' ? admin : await loadUserScope(tx, users[s.who])
      await createSet(tx, owner, CreateSetInput.parse({ kind: 'smart', scope: s.who === 'global' ? 'global' : 'personal', name: s.name, filter }))
      setCount++
    }

    // each person's history
    const sessionTimes = new Map<string, Date>()
    const ratedAt: { userId: string; workId: string; at: Date }[] = []
    let sessionCount = 0
    let progressCount = 0
    // the progress repo checks the client's "today" against the clock: anchor that clock on the seed's today
    const progressClock = { now: new Date(`${today}T12:00:00Z`) }
    let ratingCount = 0
    let goalCount = 0
    for (const who of ['admin', 'partner', 'teen'] as const) {
      log(`history: ${users[who].displayName}`)
      const h = DEMO_HISTORY[who]
      const scope: UserScope = await loadUserScope(tx, users[who])
      if (who === 'admin') admin = scope

      const myBooks = await getDefaultPersonalSetId(tx, users[who].id)
      for (const key of h.myBooks) await addWorkToSet(tx, scope, myBooks, book(key).id)
      for (const set of DEMO_MANUAL_SETS.filter((s) => s.who === who)) {
        const created = await createSet(tx, scope, CreateSetInput.parse({ kind: 'manual', scope: 'personal', name: set.name }))
        for (const key of set.books) await addWorkToSet(tx, scope, created.id, book(key).id)
        setCount++
      }

      // oldest first, so a later session of the same book is a reread
      for (const [i, s] of [...h.sessions].sort((a, b) => b.start - a.start).entries()) {
        const precision = s.precision ?? 'day'
        const work = book(s.book)
        const id = await startSession(
          tx,
          scope,
          StartSessionInput.parse({ workId: work.id, editionId: pickEdition(work, s), mode: s.mode, startedOn: withPrecision(day(s.start), precision), startedPrecision: precision }),
        )
        sessionCount++
        // points can only be added while the session is in progress, and a finish may not precede the latest one
        for (const p of s.progress ?? []) {
          await addProgressPoint(tx, scope, AddProgressInput.parse({ sessionId: id, today, on: day(p.daysAgo), kind: p.kind, value: p.value }), progressClock)
          progressCount++
        }
        if (s.end !== undefined) {
          await completeSession(
            tx,
            scope,
            id,
            CompleteSessionInput.parse({
              outcome: s.abandonedAt === undefined ? 'finished' : 'abandoned',
              finishedOn: withPrecision(day(s.end), precision),
              finishedPrecision: precision,
              fractionCompleted: s.abandonedAt ?? null,
            }),
          )
        }
        sessionTimes.set(id, at(day(s.end ?? s.start), i * 23))
      }

      for (const key of h.readLongAgo ?? []) await setStatus(tx, scope, book(key).id, 'read')
      for (const key of h.wantToRead ?? []) await setStatus(tx, scope, book(key).id, 'want_to_read')
      for (const [i, [key, rating]] of Object.entries(h.ratings).entries()) {
        await setRating(tx, scope, book(key).id, rating)
        const ends = h.sessions.filter((s) => s.book === key && s.end !== undefined).map((s) => s.end ?? 0)
        ratedAt.push({ userId: users[who].id, workId: book(key).id, at: at(day(ends.length > 0 ? Math.min(...ends) : 420 + i), 60 + i * 17) })
        ratingCount++
      }
      for (const [key, review] of Object.entries(h.reviews ?? {})) await setReview(tx, scope, book(key).id, review)
      for (const key of h.queue) await addToQueue(tx, scope, book(key).id, 'bottom')

      const year = Number(today.slice(0, 4))
      const lastDay = new Date(Date.UTC(year, Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10)
      const periods = {
        'this-year': { periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` },
        'last-year': { periodStart: `${year - 1}-01-01`, periodEnd: `${year - 1}-12-31` },
        'this-month': { periodStart: `${today.slice(0, 7)}-01`, periodEnd: lastDay },
      }
      for (const g of h.goals) {
        await createGoal(tx, scope, GoalInput.parse({ ...periods[g.period], metric: g.metric, target: g.target }))
        goalCount++
      }
    }

    // loans of the admin's physical copies
    log('loans')
    for (const l of DEMO_LOANS) {
      const editionId = editionOf(l.book, 'physical')
      const borrower = 'who' in l.to ? { borrowerUserId: users[l.to.who].id, borrowerName: null } : { borrowerUserId: null, borrowerName: l.to.name }
      const loanId = await createLoan(
        tx,
        admin,
        LoanInput.parse({ editionId, ...borrower, lentOn: day(l.lentDaysAgo), dueOn: l.dueDaysAgo === undefined ? null : day(l.dueDaysAgo) }),
      )
      if (l.returnedDaysAgo !== undefined) await returnLoan(tx, admin, loanId, day(l.returnedDaysAgo))
    }

    // sources: an Audiobookshelf that once failed to connect, and a Readarr with wanted books — their
    // syncs leave pending Inbox proposals. The URLs use the reserved .invalid domain: nothing is ever reached.
    log('sources and inbox')
    const abs = await createSource(
      tx,
      admin,
      options.secretBox,
      CreateSourceInput.parse({ name: 'Audiobookshelf (demo)', config: { kind: 'audiobookshelf', baseUrl: 'http://audiobookshelf.invalid:13378', apiToken: 'demo-token' } }),
    )
    const readarr = await createSource(
      tx,
      admin,
      options.secretBox,
      CreateSourceInput.parse({ name: 'Readarr (demo)', config: { kind: 'readarr', baseUrl: 'http://readarr.invalid:8787', apiKey: 'demo-key' } }),
    )
    const failed = await createSyncRun(tx, { sourceId: abs, trigger: 'schedule', requestedBy: null })
    await claimSyncRun(tx, failed)
    await finishSyncRun(tx, failed, { status: 'failed', stats: null, error: 'connect ECONNREFUSED 192.168.1.20:13378' })
    for (const [sourceId, items] of [
      [abs, DEMO_ABS_ITEMS],
      [readarr, DEMO_READARR_ITEMS],
    ] as const) {
      const run = await createSyncRun(tx, { sourceId, trigger: 'manual', requestedBy: adminUser.id })
      await claimSyncRun(tx, run)
      const outcome = await syncSource(tx, sourceId, feed(items))
      await finishSyncRun(tx, run, { status: outcome.complete ? 'succeeded' : 'failed', stats: outcome.stats, error: outcome.error })
    }
    const wanted = (await listInbox(tx, admin)).items.find((i) => i.item.externalId === DEMO_ACCEPTED_WANTED)
    if (!wanted) throw new Error('the demo wanted item did not reach the Inbox')
    await resolveSourceMatch(tx, admin, wanted.id, { action: 'create_wanted' })
    const inbox = await listInbox(tx, admin)

    // the partner's Goodreads import, left for her to review
    const partner = await loadUserScope(tx, users.partner)
    const csv = await importCsv(
      tx,
      partner,
      CsvImportInput.parse({
        fileName: DEMO_CSV.fileName,
        header: DEMO_CSV.header,
        rows: DEMO_CSV.rows,
        importId: DEMO_CSV.importId,
        ownership: 'read_not_owned',
        mapping: { columns: { title: 0, authors: 1, isbn: 2, rating: 3, shelf: 4, finishedOn: 5, pageCount: 6, tags: 7 }, dateOrder: 'ymd', ratingScale: 5 },
      }),
    )

    // backdate the "now" timestamps so the feed and "recently added" read like real use
    log('timestamps and stats')
    for (const [key, w] of seeded) {
      await tx.update(works).set({ createdAt: at(day(addedOn.get(key) ?? 0), 0) }).where(eq(works.id, w.id))
    }
    for (const [id, when] of sessionTimes) {
      await tx.update(readingSessions).set({ createdAt: when, updatedAt: when }).where(eq(readingSessions.id, id))
    }
    for (const r of ratedAt) {
      await tx
        .update(userWorks)
        .set({ ratedAt: r.at, updatedAt: r.at })
        .where(and(eq(userWorks.userId, r.userId), eq(userWorks.workId, r.workId)))
    }
    for (const u of Object.values(users)) await rebuildDailyStats(tx, await loadUserScope(tx, u))

    const [editionCount] = await tx
      .select({ n: count() })
      .from(editions)
      .where(inArray(editions.workId, [...seeded.values()].map((w) => w.id)))

    return {
      admin: { id: adminUser.id, username: adminUser.username },
      members: DEMO_MEMBERS.map((m) => ({ username: m.username, displayName: m.displayName, password: m.password, pin: m.pin })),
      works: seeded.size + 1,
      editions: editionCount?.n ?? 0,
      sessions: sessionCount,
      progressPoints: progressCount,
      ratings: ratingCount,
      loans: DEMO_LOANS.length,
      sets: setCount,
      goals: goalCount,
      pendingInbox: inbox.total,
      csvProposals: csv.proposals,
    }
  })
}
