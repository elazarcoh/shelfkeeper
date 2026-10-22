import { fetchAbsItem, patchAbsMedia, toExternalItems, type HttpClient } from '@mylib/connectors'
import {
  absFieldHash,
  finishAbsPushRun,
  getAbsPushRun,
  loadAbsPushTargets,
  loadSourceForSync,
  recordAbsPushResult,
  storeSourceItem,
  type AbsPushResult,
  type AbsPushTarget,
  type Db,
  type SecretBox,
} from '@mylib/db'
import { absMetadataPatch, absPushFieldLabel, currentAbsRecord, diffAbs, type AbsPushSendInput, type AudiobookshelfConfig } from '@mylib/domain'
import type { AbsPushJobData } from '@mylib/jobs'

export interface AbsPushDeps {
  db: Db
  box: SecretBox
  http: HttpClient
}

/** Same as DETAIL_CONCURRENCY in the sync. */
const CONCURRENCY = 4
export const KEY_CANT_EDIT = "The Audiobookshelf key can't edit books"
export const CHANGED_SINCE_PREVIEW = 'changed since you looked — review it again'

type Book = AbsPushSendInput['books'][number]
interface Outcome {
  result: AbsPushResult
  unauthorized: boolean
}

/**
 * One send run: for each requested book, check nothing changed since the page loaded, PATCH, re-read and store what
 * ABS now holds. The first book goes alone, the rest in batches of 4, so a key without edit rights costs one request.
 * An unauthorized answer stops the run after its batch. Never throws.
 */
export async function runAbsPushJob(deps: AbsPushDeps, data: AbsPushJobData): Promise<void> {
  try {
    const run = await getAbsPushRun(deps.db, data.runId)
    if (run?.status !== 'running') return
    const books = run.request
    const targets = new Map((await loadAbsPushTargets(deps.db, books.map((b) => b.sourceItemId))).map((t) => [t.sourceItemId, t]))
    const configs = new Map<string, AudiobookshelfConfig | null>()
    const configOf = async (sourceId: string): Promise<AudiobookshelfConfig | null> => {
      if (!configs.has(sourceId)) {
        const source = await loadSourceForSync(deps.db, deps.box, sourceId)
        configs.set(sourceId, source?.config.kind === 'audiobookshelf' ? source.config : null)
      }
      return configs.get(sourceId) ?? null
    }

    const batches: Book[][] = books.length === 0 ? [] : [[books[0] as Book]]
    for (let i = 1; i < books.length; i += CONCURRENCY) batches.push(books.slice(i, i + CONCURRENCY))

    let stopped = false
    for (const batch of batches) {
      if (stopped) {
        for (const book of batch) await recordAbsPushResult(deps.db, data.runId, notSent(book, targets))
        continue
      }
      // sources are loaded before the batch runs, so two books never load the same one at once
      for (const book of batch) {
        const target = targets.get(book.sourceItemId)
        if (target) await configOf(target.sourceId)
      }
      const outcomes = await Promise.all(batch.map((book) => sendBook(deps, book, targets.get(book.sourceItemId), configs)))
      for (const o of outcomes) await recordAbsPushResult(deps.db, data.runId, o.result)
      if (outcomes.some((o) => o.unauthorized)) stopped = true
    }
    if (stopped) await finishAbsPushRun(deps.db, data.runId, 'stopped', KEY_CANT_EDIT)
    else await finishAbsPushRun(deps.db, data.runId, 'succeeded', null)
  } catch (error) {
    await finishAbsPushRun(deps.db, data.runId, 'failed', error instanceof Error ? error.message : String(error)).catch(() => undefined)
  }
}

const notSent = (book: Book, targets: Map<string, AbsPushTarget>): AbsPushResult => ({
  sourceItemId: book.sourceItemId,
  title: targets.get(book.sourceItemId)?.title ?? book.sourceItemId,
  outcome: 'not_sent',
  message: 'not sent',
})

async function sendBook(
  deps: AbsPushDeps,
  book: Book,
  target: AbsPushTarget | undefined,
  configs: Map<string, AudiobookshelfConfig | null>,
): Promise<Outcome> {
  const done = (outcome: AbsPushResult['outcome'], message: string | null, unauthorized = false): Outcome => ({
    result: { sourceItemId: book.sourceItemId, title: target?.title ?? book.sourceItemId, outcome, message },
    unauthorized,
  })
  try {
    const config = target ? configs.get(target.sourceId) : null
    if (!target) return done('failed', 'item gone')
    if (!config) return done('failed', 'source unavailable')

    const fields = book.fields.map((f) => f.field)
    const diffs = diffAbs(target.current, target.outgoing, absFieldHash)
    const changed = book.fields.some((f) => diffs.find((d) => d.field === f.field)?.hash !== f.hash)
    if (changed) return done('skipped', CHANGED_SINCE_PREVIEW)

    const patched = await patchAbsMedia(config, deps.http, target.absItemId, absMetadataPatch(target.outgoing, target.current, fields))
    if (!patched.ok) {
      const e = patched.error
      if (e.kind === 'unauthorized') return done('failed', KEY_CANT_EDIT, true)
      return done('failed', e.status === 404 ? 'item gone' : e.message)
    }

    // what ABS stored is the truth now: keep it as the source item's raw, so the next sync starts from it
    const raw = await fetchAbsItem(config, deps.http, target.absItemId)
    if (!raw.ok) return done('sent', 'sent; re-read failed')
    const items = toExternalItems(config.baseUrl, raw.value)
    if (!items.ok) return done('sent', 'sent; re-read failed')
    for (const item of items.value) await storeSourceItem(deps.db, target.sourceId, item)
    const now = currentAbsRecord(raw.value)
    if (now === null) return done('sent', null)
    const still = diffAbs(now, target.outgoing, absFieldHash)
      .map((d) => d.field)
      .filter((f) => fields.includes(f))
    return done('sent', still.length === 0 ? null : `sent, but Audiobookshelf stored ${still.map((f) => absPushFieldLabel[f]).join(', ')} differently`)
  } catch (error) {
    return done('failed', error instanceof Error ? error.message : String(error))
  }
}
