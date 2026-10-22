import type { Connector, HttpClient } from '@mylib/connectors'
import { claimSyncRun, createSyncRun, finishSyncRun, loadSourceForSync, syncSource, type Db, type SecretBox } from '@mylib/db'
import type { SyncedSourceKind } from '@mylib/domain'
import type { CoversJobData, SyncJobData } from '@mylib/jobs'

export interface SyncDeps {
  db: Db
  box: SecretBox
  http: HttpClient
  getConnector: (kind: SyncedSourceKind) => Connector
  enqueueCovers: (data: CoversJobData) => Promise<void>
}

/** One sync job: claim the run (one per source at a time), fetch, apply, record. Never throws. */
export async function runSyncJob(deps: SyncDeps, data: SyncJobData): Promise<void> {
  const runId = data.runId ?? (await createSyncRun(deps.db, { sourceId: data.sourceId, trigger: 'schedule', requestedBy: null }))
  if ((await claimSyncRun(deps.db, runId)) !== 'claimed') return
  try {
    const source = await loadSourceForSync(deps.db, deps.box, data.sourceId)
    if (source === null) {
      await finishSyncRun(deps.db, runId, { status: 'failed', stats: null, error: 'The source no longer exists' })
      return
    }
    const connector = deps.getConnector(source.config.kind)
    const outcome = await syncSource(deps.db, source.id, connector.fetchItems(source.config, deps.http))
    await finishSyncRun(deps.db, runId, { status: outcome.complete ? 'succeeded' : 'failed', stats: outcome.stats, error: outcome.error })
    if (outcome.complete) {
      // covers are best effort: a queue hiccup must not turn a finished sync into a failure
      await deps.enqueueCovers({ sourceId: source.id }).catch((error: unknown) => {
        console.error('[worker] could not queue covers', error)
      })
    }
  } catch (error) {
    await finishSyncRun(deps.db, runId, { status: 'failed', stats: null, error: error instanceof Error ? error.message : String(error) })
  }
}
