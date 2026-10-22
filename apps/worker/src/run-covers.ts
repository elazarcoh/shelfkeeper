import type { Connector, HttpClient } from '@mylib/connectors'
import { listCoverWork, loadSourceForSync, loadSourceKind, markCoverChecked, saveCover, type AssetStore, type CoverWork, type Db, type SecretBox } from '@mylib/db'
import { err, isAllowedCoverRedirect, isAllowedCoverUrl, ok, sniffImage, type ConnectorError, type ConnectorErrorKind, type Result, type SyncedSourceKind } from '@mylib/domain'
import type { CoversJobData } from '@mylib/jobs'

export interface CoversDeps {
  db: Db
  box: SecretBox
  http: HttpClient
  getConnector: (kind: SyncedSourceKind) => Connector
  store: AssetStore
  /** the clock for the job's time budget (ms since the epoch); tests inject one */
  now?: () => number
}

const BATCH = 50
/** bounds one job; whatever is left is picked up by the next one */
const MAX_ROUNDS = 20
/** one job never runs longer than this; whatever is left (unmarked) is picked up by the next one */
const TIME_BUDGET_MS = 50 * 60_000
/** the source itself is down or refusing us: nothing is the item's fault, so nothing waits a week */
const SOURCE_LEVEL: ReadonlySet<ConnectorErrorKind> = new Set(['unreachable', 'unauthorized', 'rate_limited'])

type Outcome = 'saved' | 'skipped' | { stop: string }

/** Downloads missing covers for one source (plan deviation 13). A failed cover is retried after a week. */
export async function runCoversJob(deps: CoversDeps, data: CoversJobData): Promise<{ saved: number; failed: number }> {
  const counts = { saved: 0, failed: 0 }
  let sourceId: string
  let fetchCover: (url: string) => Promise<Result<Uint8Array, ConnectorError>>
  const kind = await loadSourceKind(deps.db, data.sourceId)
  if (kind === 'shelf' || kind === 'csv') {
    sourceId = data.sourceId
    // shelf (and linked CSV row) covers come from a book site's image host, never anywhere else (spec §7.3)
    fetchCover = async (url) => {
      if (!isAllowedCoverUrl(url)) return err({ kind: 'provider_error', message: 'Cover host not allowed' })
      // a redirect is followed only while every hop stays on that site's own image storage
      const fetched = await deps.http.getBytes(url, {}, undefined, isAllowedCoverRedirect)
      return fetched.ok ? ok(fetched.value.bytes) : err({ kind: fetched.error.kind, message: fetched.error.message })
    }
  } else {
    let source: Awaited<ReturnType<typeof loadSourceForSync>>
    try {
      source = await loadSourceForSync(deps.db, deps.box, data.sourceId)
    } catch (error) {
      console.error('[covers] cannot read the source config', error)
      return counts
    }
    if (source === null) return counts
    sourceId = source.id
    const connector = deps.getConnector(source.config.kind)
    const config = source.config
    fetchCover = (url) => connector.fetchCover(config, deps.http, url)
  }
  const now = deps.now ?? Date.now
  const startedAt = now()
  // one bad cover is counted and skipped, never failing the rest (spec §8)
  const saveOne = async (work: CoverWork): Promise<Outcome> => {
    let bytes: Uint8Array
    let kind: NonNullable<ReturnType<typeof sniffImage>>
    try {
      const fetched = await fetchCover(work.coverUrl)
      if (!fetched.ok) return SOURCE_LEVEL.has(fetched.error.kind) ? { stop: fetched.error.message } : 'skipped'
      const sniffed = sniffImage(fetched.value)
      if (sniffed === null) return 'skipped'
      bytes = fetched.value
      kind = sniffed
    } catch (error) {
      console.error('[covers] could not fetch a cover', error instanceof Error ? error.message : String(error))
      return 'skipped'
    }
    try {
      const stored = await deps.store.put(bytes, kind.ext)
      await saveCover(deps.db, work, { ...stored, mime: kind.mime })
      return 'saved'
    } catch (error) {
      // our own disk or database failed, not the cover: stop, and leave it (and the rest) for the next job
      const message = error instanceof Error ? error.message : String(error)
      console.error('[covers] could not store a cover, stopping', message)
      return { stop: `could not store a cover (${message})` }
    }
  }
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const batch = await listCoverWork(deps.db, sourceId, BATCH)
    if (batch.length === 0) break
    for (const work of batch) {
      if (now() - startedAt > TIME_BUDGET_MS) {
        console.warn('[covers] out of time for this job; the next one carries on')
        return counts
      }
      const outcome = await saveOne(work)
      if (outcome === 'saved') {
        counts.saved++
      } else if (outcome === 'skipped') {
        await markCoverChecked(deps.db, work.sourceItemId)
        counts.failed++
      } else {
        // left unmarked: the next covers job (after the next sync) tries them all again
        console.warn(`[covers] stopped for this source: ${outcome.stop}`)
        return counts
      }
    }
  }
  return counts
}
