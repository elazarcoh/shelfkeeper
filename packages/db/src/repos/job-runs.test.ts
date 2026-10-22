import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { emptySyncStats } from '@mylib/domain'
import { jobRuns, sources } from '../schema'
import { seedUser, useTestDb } from '../testing'
import { claimSyncRun, createSyncRun, failRunningRuns, finishSyncRun, listJobRuns, requestSync, rerunJob } from './job-runs'
import { loadUserScope } from './scope'

describe('job runs repository', () => {
  const t = useTestDb()

  async function setup() {
    const user = await seedUser(t.db, { role: 'admin' })
    const scope = await loadUserScope(t.db, user)
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    if (!source) throw new Error('no source')
    return { user, scope, sourceId: source.id }
  }

  it('queues, claims and finishes a sync, stamping the source', async () => {
    const { user, scope, sourceId } = await setup()
    const { runId } = await requestSync(t.db, scope, sourceId)
    expect(await claimSyncRun(t.db, runId)).toBe('claimed')
    expect(await claimSyncRun(t.db, runId)).toBe('gone')
    await finishSyncRun(t.db, runId, { status: 'succeeded', stats: { ...emptySyncStats(), seen: 3 }, error: null })

    const [run] = await listJobRuns(t.db, scope)
    expect(run).toMatchObject({ id: runId, sourceName: 'ABS', trigger: 'manual', status: 'succeeded', requestedByName: user.displayName, stats: { seen: 3 } })
    const [source] = await t.db.select().from(sources).where(eq(sources.id, sourceId))
    expect(source?.lastSyncStatus).toBe('succeeded')
    expect(source?.lastSyncAt).not.toBeNull()
  })

  it('skips a run while another sync of the same source is running', async () => {
    const { sourceId } = await setup()
    const first = await createSyncRun(t.db, { sourceId, trigger: 'schedule', requestedBy: null })
    const second = await createSyncRun(t.db, { sourceId, trigger: 'manual', requestedBy: null })
    expect(await claimSyncRun(t.db, first)).toBe('claimed')
    expect(await claimSyncRun(t.db, second)).toBe('busy')
    const [row] = await t.db.select().from(jobRuns).where(eq(jobRuns.id, second))
    expect(row?.status).toBe('skipped')
  })

  it('frees a source whose previous run was left running by a crashed worker', async () => {
    const { sourceId } = await setup()
    await t.db.insert(jobRuns).values({ sourceId, trigger: 'schedule', status: 'running', startedAt: new Date(Date.now() - 3 * 3600_000) })
    const next = await createSyncRun(t.db, { sourceId, trigger: 'manual', requestedBy: null })
    expect(await claimSyncRun(t.db, next)).toBe('claimed')
    const stale = await t.db.select().from(jobRuns).where(eq(jobRuns.status, 'failed'))
    expect(stale).toHaveLength(1)
  })

  it('fails every running run at once (worker restart), leaving queued and finished runs alone', async () => {
    const { sourceId } = await setup()
    const running = await createSyncRun(t.db, { sourceId, trigger: 'schedule', requestedBy: null })
    await claimSyncRun(t.db, running)
    const queued = await createSyncRun(t.db, { sourceId, trigger: 'manual', requestedBy: null })

    expect(await failRunningRuns(t.db, 'The worker restarted during this sync')).toBe(1)
    const rows = await t.db.select().from(jobRuns)
    expect(rows.find((r) => r.id === running)).toMatchObject({ status: 'failed', error: 'The worker restarted during this sync' })
    expect(rows.find((r) => r.id === running)?.finishedAt).not.toBeNull()
    expect(rows.find((r) => r.id === queued)?.status).toBe('queued')
    const [source] = await t.db.select().from(sources).where(eq(sources.id, sourceId))
    expect(source?.lastSyncStatus).toBe('failed')
    expect(await claimSyncRun(t.db, queued)).toBe('claimed')
    expect(await failRunningRuns(t.db, 'again')).toBe(1)
    expect(await failRunningRuns(t.db, 'again')).toBe(0)
  })

  it('re-runs a finished job as a new queued run', async () => {
    const { scope, sourceId } = await setup()
    const { runId } = await requestSync(t.db, scope, sourceId)
    await claimSyncRun(t.db, runId)
    await finishSyncRun(t.db, runId, { status: 'failed', stats: null, error: 'Audiobookshelf is unreachable' })
    const again = await rerunJob(t.db, scope, runId)
    expect(again.sourceId).toBe(sourceId)
    expect((await listJobRuns(t.db, scope)).map((r) => [r.trigger, r.status])).toEqual([
      ['rerun', 'queued'],
      ['manual', 'failed'],
    ])
  })

  it('is admin-only and answers NOT_FOUND for unknown ids', async () => {
    const { sourceId } = await setup()
    const member = await loadUserScope(t.db, await seedUser(t.db))
    await expect(requestSync(t.db, member, sourceId)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(listJobRuns(t.db, member)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    await expect(requestSync(t.db, admin, '11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(rerunJob(t.db, admin, '11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
