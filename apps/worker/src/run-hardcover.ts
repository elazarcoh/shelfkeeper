import type { HardcoverClient, HardcoverError } from '@mylib/connectors'
import {
  finishHardcoverRun,
  getHardcoverAccountWithToken,
  listAuthorIdsToFetch,
  listExploreTargets,
  listMatchCandidates,
  listSeriesIdsToFetch,
  listStaleHardcoverIds,
  listUserAccountsWithToken,
  listWaitingPushes,
  markPush,
  notePushError,
  queueFinishedPushes,
  saveBookData,
  saveExternalBooks,
  saveHardcoverAuthors,
  saveHardcoverRead,
  saveHardcoverSeries,
  saveMatch,
  saveMissingBooks,
  saveRecommendations,
  setHardcoverAccountStatus,
  startHardcoverRun,
  touchHardcoverBooks,
  type Db,
  type HardcoverAccountWithToken,
  type SecretBox,
} from '@mylib/db'
import { sameTitleAndAuthor, type HardcoverBookData } from '@mylib/domain'
import type { HardcoverJobData } from '@mylib/jobs'

export interface HardcoverDeps {
  db: Db
  box: SecretBox
  client: (token: string) => HardcoverClient
  /** an Open Library work's title and authors (the bridge for translated books); null when it can't be read */
  openLibraryWork: (id: string) => Promise<{ title: string; authors: string[] } | null>
  now: () => Date
  log: (line: string) => void
  /** requests a run may make; spec: stop before 2,000 */
  budget?: number
}

const BUDGET = 1999
const BATCH = 50
const SENDS_PER_RUN = 50
/** authorBooks shares one 200-row limit across its ids, so it takes fewer per request */
const AUTHOR_BATCH = 5
/** ids each explore step takes per run; the request budget is the real limit, the rest waits for the next run */
const EXPLORE_LIMIT = 500

/** A stop that ends the run: the account is broken, or Hardcover can't be reached now. */
class Stop extends Error {
  constructor(
    readonly reason: 'budget' | 'error',
    message: string,
    /** what Hardcover answered, for an 'error' stop */
    readonly kind?: HardcoverError['kind'],
  ) {
    super(message)
  }
}

type Result<T> = { ok: true; value: T } | { ok: false; error: HardcoverError }
type Api = <T>(account: HardcoverAccountWithToken, call: (c: HardcoverClient) => Promise<Result<T>>) => Promise<T>

export async function runHardcoverJob(deps: HardcoverDeps, data: HardcoverJobData): Promise<'done' | 'skipped' | 'busy'> {
  const household = await getHardcoverAccountWithToken(deps.db, deps.box, { kind: 'household' })
  if (data.kind === 'refresh' && (household === null || household.status !== 'ok')) return 'skipped'
  const runId = await startHardcoverRun(deps.db, data)
  if (runId === null) return 'busy'
  const stats: Record<string, number> = {}
  const bump = (key: string, by = 1) => {
    stats[key] = (stats[key] ?? 0) + by
  }
  const budget = deps.budget ?? BUDGET
  let used = 0
  const clients = new Map<string, HardcoverClient>()
  const clientFor = (account: HardcoverAccountWithToken) => {
    let c = clients.get(account.id)
    if (!c) {
      c = deps.client(account.token)
      clients.set(account.id, c)
    }
    return c
  }
  /** One API call against the run's budget; a broken account or an unreachable Hardcover stops the run. */
  const api: Api = async (account, call) => {
    if (used >= budget) throw new Stop('budget', 'Request budget reached; the next run continues')
    used += 1
    const client = clientFor(account)
    const before = client.requestsUsed
    const r = await call(client)
    // a call can take several requests (a paged Read list, a retry): each counts against the budget
    used += Math.max(0, client.requestsUsed - before - 1)
    if (r.ok) return r.value
    if (r.error.kind === 'unauthorized') await setHardcoverAccountStatus(deps.db, account.id, 'needs_token', r.error.message, deps.now())
    if (r.error.kind === 'missing_scope') await setHardcoverAccountStatus(deps.db, account.id, 'missing_scope', r.error.scope ?? r.error.message, deps.now())
    throw new Stop('error', r.error.message, r.error.kind)
  }

  try {
    if (data.kind === 'refresh' && household !== null) {
      await refresh(deps, household, api, bump)
      for (const account of await listUserAccountsWithToken(deps.db, deps.box)) {
        if (account.status !== 'ok') continue
        try {
          try {
            await saveRecommendations(deps.db, account.id, await api(account, (c) => c.recommendations(account.hardcoverUserId)), deps.now())
            bump('recommendations')
          } catch (error) {
            // one odd recommendations reply must not skip the Read list too: it is asked again tomorrow
            if (!(error instanceof Stop && error.reason === 'error' && error.kind === 'bad_response')) throw error
            deps.log(`[hardcover] could not read recommendations: ${error.message}`)
            bump('failed')
          }
          // the person's own Read list, with their own token: the page hides what they have read
          await saveHardcoverRead(deps.db, account.id, await api(account, (c) => c.readBookIds(account.hardcoverUserId)), deps.now())
        } catch (error) {
          // one person's broken token must not stop the household's refresh
          if (error instanceof Stop && error.reason === 'error') continue
          throw error
        }
      }
      await explore(deps, household, api, bump)
    }
    await sendFinished(deps, api, bump)
    await finishHardcoverRun(deps.db, runId, { status: 'succeeded', stats, error: null })
  } catch (error) {
    const stopped = error instanceof Stop && error.reason === 'budget'
    await finishHardcoverRun(deps.db, runId, { status: stopped ? 'stopped' : 'failed', stats, error: error instanceof Error ? error.message : String(error) })
    deps.log(`[hardcover] ${data.kind} ${stopped ? 'stopped' : 'failed'}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return 'done'
}

async function refresh(deps: HardcoverDeps, household: HardcoverAccountWithToken, api: Api, bump: (key: string, by?: number) => void): Promise<void> {
  for (;;) {
    const candidates = await listMatchCandidates(deps.db, deps.now(), BATCH)
    if (candidates.length === 0) break
    const isbns = [...new Set(candidates.flatMap((c) => c.isbns))]
    const editions = isbns.length === 0 ? [] : await api(household, (c) => c.editionsByIsbn(isbns))
    const found = new Map<string, number>()
    for (const c of candidates) {
      const hit = editions.find((e) => c.isbns.includes(e.isbn13 ?? '') || c.isbns.includes(e.isbn10 ?? ''))
      if (hit) found.set(c.workId, hit.bookId)
    }
    // ISBN matches: one booksById per batch, saved together
    const isbnIds = [...new Set(found.values())]
    const books = new Map<number, HardcoverBookData>()
    for (let i = 0; i < isbnIds.length; i += BATCH) for (const b of await api(household, (c) => c.booksById(isbnIds.slice(i, i + BATCH)))) books.set(b.id, b)
    const save = async (workId: string, kind: 'isbn' | 'title' | 'openlibrary', book: HardcoverBookData | undefined) => {
      if (book) {
        await saveMatch(deps.db, workId, { kind, book }, deps.now())
        bump('matched')
      } else {
        await saveMatch(deps.db, workId, { kind: 'none' }, deps.now())
        bump('unmatched')
      }
    }
    for (const c of candidates) {
      const id = found.get(c.workId)
      if (id !== undefined) await save(c.workId, 'isbn', books.get(id))
    }
    // title matches: one search each, saved one by one, so a budget stop keeps the progress made
    for (const c of candidates) {
      if (found.has(c.workId)) continue
      // a translated book: the Open Library work's original title and author, through the same strict search
      try {
        const original = c.openLibraryId === null ? null : await deps.openLibraryWork(c.openLibraryId)
        if (original !== null) {
          const olHits = await api(household, (cl) => cl.searchBooks(original.title))
          const olHit = olHits.find((h) => sameTitleAndAuthor(original, h))
          if (olHit !== undefined) {
            await save(c.workId, 'openlibrary', (await api(household, (cl) => cl.booksById([olHit.id])))[0])
            continue
          }
        }
        const hits = await api(household, (cl) => cl.searchBooks(c.title))
        const hit = hits.find((h) => sameTitleAndAuthor(c, h))
        const book = hit === undefined ? undefined : (await api(household, (cl) => cl.booksById([hit.id])))[0]
        await save(c.workId, 'title', book)
      } catch (error) {
        // one odd reply about one book must not block every night's matching: it is asked again in a week
        if (error instanceof Stop && error.reason === 'error' && error.kind === 'bad_response') {
          deps.log(`[hardcover] could not match "${c.title}": ${error.message}`)
          bump('failed')
          await save(c.workId, 'title', undefined)
          continue
        }
        throw error
      }
    }
  }
  for (;;) {
    const stale = await listStaleHardcoverIds(deps.db, deps.now(), BATCH)
    if (stale.length === 0) break
    const books = await api(household, (c) => c.booksById(stale))
    for (const b of books) await saveBookData(deps.db, b, deps.now())
    bump('refreshed', books.length)
    // gone from Hardcover: keep the old data, but stop asking until next week
    await touchHardcoverBooks(
      deps.db,
      stale.filter((s) => !books.some((b) => b.id === s)),
      deps.now(),
    )
  }
}

/** Caches what the What next page shows: series, favorite authors' books and the details of every book it may list. */
async function explore(deps: HardcoverDeps, household: HardcoverAccountWithToken, api: Api, bump: (key: string, by?: number) => void): Promise<void> {
  /** Asks for ids in batches and saves each reply; one odd reply is counted and skipped, so the run goes on with the next batch. */
  const fetchAll = async <T>(what: string, ids: number[], size: number, fetch: (c: HardcoverClient, batch: number[]) => Promise<Result<T[]>>, save: (rows: T[], batch: number[]) => Promise<void>) => {
    for (let i = 0; i < ids.length; i += size) {
      const batch = ids.slice(i, i + size)
      try {
        const rows = await api(household, (c) => fetch(c, batch))
        await save(rows, batch)
        bump('explored', rows.length)
      } catch (error) {
        if (error instanceof Stop && error.reason === 'error' && error.kind === 'bad_response') {
          deps.log(`[hardcover] could not read ${what}: ${error.message}`)
          bump('failed')
          continue
        }
        throw error
      }
    }
  }
  const details = (what: string, ids: number[]) =>
    fetchAll(what, ids, BATCH, (c, batch) => c.bookDetails(batch), async (rows, batch) => {
      await saveExternalBooks(deps.db, rows, deps.now())
      // an id Hardcover does not return (deleted or merged) is not asked for every night
      await saveMissingBooks(deps.db, batch.filter((id) => !rows.some((r) => r.id === id)), deps.now())
    })

  // the details of a series' and an author's seed books name the Hardcover series and author to ask for next
  const seeds = await listExploreTargets(deps.db, deps.now(), EXPLORE_LIMIT)
  await details('book details', [...new Set([...seeds.seriesBookIds, ...seeds.authorBookIds])])
  // a series is asked for once per run, returned or not: the second call only spends requests on extras the details step just made reachable
  const asked = new Set<number>()
  const series = async () => {
    const ids = (await listSeriesIdsToFetch(deps.db, deps.now(), EXPLORE_LIMIT)).filter((id) => !asked.has(id))
    for (const id of ids) asked.add(id)
    await fetchAll('series', ids, BATCH, (c, batch) => c.seriesBooks(batch), (rows) => saveHardcoverSeries(deps.db, rows, deps.now()))
  }
  await series()
  const today = deps.now().toISOString().slice(0, 10)
  await fetchAll('author books', await listAuthorIdsToFetch(deps.db, deps.now(), EXPLORE_LIMIT), AUTHOR_BATCH, (c, batch) => c.authorBooks(batch, today), (rows) => saveHardcoverAuthors(deps.db, rows, deps.now()))
  // the series and author books just cached are what the page may show: their details come last
  await details('book details', (await listExploreTargets(deps.db, deps.now(), EXPLORE_LIMIT)).detailIds)
  // the series of the shown books at position 2 or later feed the "first unread" line: one more request or two
  await series()
}

async function sendFinished(deps: HardcoverDeps, api: Api, bump: (key: string, by?: number) => void): Promise<void> {
  bump('queued', await queueFinishedPushes(deps.db))
  const stopped = new Set<string>() // accounts whose token failed this run: no more calls for them
  const accounts = new Map((await listUserAccountsWithToken(deps.db, deps.box)).map((a) => [a.id, a]))
  for (const push of await listWaitingPushes(deps.db, SENDS_PER_RUN)) {
    const account = accounts.get(push.accountId)
    // a missing (unreadable token) or broken account keeps its rows waiting: fixing the token sends them later
    if (!account || account.status !== 'ok' || stopped.has(account.id)) continue
    if (!account.sendFinished) {
      await markPush(deps.db, push.accountId, push.workId, 'skipped', 'Sending turned off', deps.now())
      continue
    }
    // not matched yet: it waits for a refresh to find it
    if (push.hardcoverId === null || push.finishedOn === null) continue
    const bookId = push.hardcoverId
    const finishedOn = push.finishedOn
    try {
      const existing = await api(account, (c) => c.userBook(account.hardcoverUserId, bookId))
      if (existing?.statusId === 3) {
        await markPush(deps.db, push.accountId, push.workId, 'skipped', 'Already Read on Hardcover', deps.now())
        continue
      }
      await api(account, (c) => c.markRead(existing, bookId, { finishedOn, rating: push.rating }))
      await markPush(deps.db, push.accountId, push.workId, 'sent', null, deps.now())
      bump('sent')
    } catch (error) {
      // one person's broken token must not stop the others' sends; their row stays waiting
      if (error instanceof Stop && error.reason === 'error') {
        // this send failed: say so on the row (it stays waiting and is tried again next run)
        bump('failed')
        deps.log(`[hardcover] send failed for work ${push.workId}: ${error.message}`)
        await notePushError(deps.db, push.accountId, push.workId, error.message)
        // a rejected token, a missing scope, an outage or a rate limit hold for the account's other rows too: no repeated 401s or 60 s waits
        if (error.kind !== 'bad_response') stopped.add(account.id)
        continue
      }
      throw error
    }
  }
}
