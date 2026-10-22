import { describe, expect, it, vi } from 'vitest'
import { createHttpClient, getConnector, type Connector } from '@mylib/connectors'
import { ABS_FIXTURE_TOKEN, absFixtureFetch } from '@mylib/connectors/testing'
import { createSecretBox, createSource, DEV_SECRET_KEY, getWorkDetail, jobRuns, listInbox, loadUserScope, resolveSourceMatch } from '@mylib/db'
import { seedUser, useTestDb } from '@mylib/db/testing'
import { CreateSourceInput, err, ok } from '@mylib/domain'
import { runSyncJob, type SyncDeps } from './run-sync'

const BASE = 'http://abs.local:13378'
const box = createSecretBox(DEV_SECRET_KEY)

describe('runSyncJob', () => {
  const t = useTestDb()

  async function setup(getConnectorFn: SyncDeps['getConnector'] = getConnector) {
    const admin = await seedUser(t.db, { role: 'admin' })
    const scope = await loadUserScope(t.db, admin)
    const sourceId = await createSource(
      t.db,
      scope,
      box,
      CreateSourceInput.parse({ name: 'Home ABS', config: { kind: 'audiobookshelf', baseUrl: BASE, apiToken: ABS_FIXTURE_TOKEN } }),
    )
    const coversQueued: string[] = []
    const deps: SyncDeps = {
      db: t.db,
      box,
      http: createHttpClient({ fetch: absFixtureFetch(BASE) }),
      getConnector: getConnectorFn,
      enqueueCovers: (data) => {
        coversQueued.push(data.sourceId)
        return Promise.resolve()
      },
    }
    return { scope, sourceId, deps, coversQueued }
  }

  it('syncs Audiobookshelf into the Inbox, and accepting an item creates an edition from the source', async () => {
    const { scope, sourceId, deps, coversQueued } = await setup()
    await runSyncJob(deps, { sourceId, runId: null })

    const [run] = await t.db.select().from(jobRuns)
    expect(run).toMatchObject({ trigger: 'schedule', status: 'succeeded', stats: { seen: 3, created: 3, proposals: 3 } })
    expect(coversQueued).toEqual([sourceId])

    const inbox = (await listInbox(t.db, scope)).items
    expect(inbox.map((i) => i.item.externalId).sort()).toEqual(['li_hp1', 'li_hp1:ebook', 'li_mistborn'])
    const mistborn = inbox.find((i) => i.item.externalId === 'li_mistborn')
    const { workId } = await resolveSourceMatch(t.db, scope, mistborn?.id ?? '', { action: 'create_work' })
    const detail = await getWorkDetail(t.db, scope, workId ?? '')
    expect(detail).toMatchObject({ title: 'The Final Empire', editions: [{ format: 'audiobook', durationSec: 88_035, asin: 'B002UZMLXM' }] })
    expect(detail.editions[0]?.provenance.durationSec).toMatchObject({ origin: 'source', sourceId })
  })

  it('records a failed run when the source is unreachable, without marking anything removed', async () => {
    const failing: Connector = {
      kind: 'audiobookshelf',
      test: () => Promise.resolve(ok({ libraries: [] })),
      fetchItems: async function* () {
        await Promise.resolve()
        yield* []
        throw new Error('Could not reach abs.local:13378 (ECONNREFUSED)')
      },
      fetchCover: () => Promise.resolve(err({ kind: 'provider_error' as const, message: 'no covers' })),
    }
    const { sourceId, deps, coversQueued } = await setup(() => failing)
    await runSyncJob(deps, { sourceId, runId: null })
    const [run] = await t.db.select().from(jobRuns)
    expect(run).toMatchObject({ status: 'failed', error: 'Could not reach abs.local:13378 (ECONNREFUSED)', stats: { removed: 0 } })
    expect(coversQueued).toEqual([])
  })

  it('keeps a finished sync succeeded when queueing its covers fails', async () => {
    const { sourceId, deps } = await setup()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await runSyncJob({ ...deps, enqueueCovers: () => Promise.reject(new Error('queue down')) }, { sourceId, runId: null })
      expect(logged).toHaveBeenCalledWith('[worker] could not queue covers', expect.any(Error))
    } finally {
      logged.mockRestore()
    }
    const [run] = await t.db.select().from(jobRuns)
    expect(run).toMatchObject({ status: 'succeeded' })
  })

  it('fails the run with a readable message when the stored token was sealed with another key', async () => {
    const { sourceId, deps } = await setup()
    await runSyncJob({ ...deps, box: createSecretBox(Buffer.alloc(32, 7).toString('base64')) }, { sourceId, runId: null })
    const [run] = await t.db.select().from(jobRuns)
    expect(run).toMatchObject({ status: 'failed', error: "The stored API token can't be read (APP_SECRET_KEY changed?) — re-enter it." })
  })
})
