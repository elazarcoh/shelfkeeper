import { describe, expect, it } from 'vitest'
import { DEFAULT_RETENTION, type MaintenanceState } from '@mylib/domain'
import { backupRuns, jobRuns, sources, systemState } from '../schema'
import { seedUser, useTestDb } from '../testing'
import { loadUserScope } from './scope'
import {
  failRunningBackupRuns,
  finishBackupRun,
  getBackupRetention,
  getBackupSettings,
  getLastRestore,
  getMaintenance,
  isBackupRunning,
  lastFailedBackupRun,
  lastWorkerSuccess,
  listBackupRuns,
  markWorkerPaused,
  pingDatabase,
  setLastRestore,
  setMaintenance,
  startBackupRun,
  updateBackupSettings,
  waitForWorkerPause,
} from './system'

const state: MaintenanceState = {
  reason: 'restore',
  message: 'Restoring my-library-0.4.0-20260928T030000Z-manual.zip…',
  since: '2026-09-28T03:00:00.000Z',
  backupName: 'my-library-0.4.0-20260928T030000Z-manual.zip',
}

describe('system repository', () => {
  const t = useTestDb()

  it('records and clears maintenance, and waits for the worker to acknowledge it', async () => {
    expect(await getMaintenance(t.db)).toBeNull()
    await setMaintenance(t.db, state)
    expect(await getMaintenance(t.db)).toEqual(state)
    const since = new Date()
    expect(await waitForWorkerPause(t.db, since, 50, 10)).toBe(false)
    await markWorkerPaused(t.db, new Date(since.getTime() + 1))
    expect(await waitForWorkerPause(t.db, since, 50, 10)).toBe(true)
    await setMaintenance(t.db, null)
    expect(await getMaintenance(t.db)).toBeNull()
  })

  it('keeps a single state row', async () => {
    await expect(t.db.insert(systemState).values({ id: 2 }).execute()).rejects.toThrow()
  })

  it('stores the last restore for admins only', async () => {
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const member = await loadUserScope(t.db, await seedUser(t.db))
    expect(await getLastRestore(t.db, admin)).toBeNull()
    const outcome = { ok: false as const, backupName: 'x.zip', preRestoreBackup: null, error: 'The backup manifest is damaged', at: '2026-09-28T03:00:00.000Z' }
    await setLastRestore(t.db, outcome)
    expect(await getLastRestore(t.db, admin)).toEqual(outcome)
    await expect(getLastRestore(t.db, member)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('stores backup settings, falling back to the environment schedule', async () => {
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    expect(await getBackupSettings(t.db, '0 3 * * *')).toEqual({ schedule: '0 3 * * *', scheduleIsDefault: true, defaultSchedule: '0 3 * * *', retention: DEFAULT_RETENTION })
    await updateBackupSettings(t.db, admin, { schedule: '30 2 * * *', retention: { scheduled: 7, preUpgrade: 3, preRestore: 2 } })
    expect(await getBackupSettings(t.db, '0 3 * * *')).toEqual({
      schedule: '30 2 * * *',
      scheduleIsDefault: false,
      defaultSchedule: '0 3 * * *',
      retention: { scheduled: 7, preUpgrade: 3, preRestore: 2 },
    })
    expect(await getBackupRetention(t.db)).toEqual({ scheduled: 7, preUpgrade: 3, preRestore: 2 })
    const member = await loadUserScope(t.db, await seedUser(t.db))
    await expect(updateBackupSettings(t.db, member, { schedule: null, retention: DEFAULT_RETENTION })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('records backup runs and reports the last failure', async () => {
    const good = await startBackupRun(t.db, 'manual')
    expect(await isBackupRunning(t.db)).toBe(true)
    await finishBackupRun(t.db, good, { status: 'succeeded', fileName: 'my-library-0.4.0-20260928T030000Z-manual.zip', sizeBytes: 1234 })
    const bad = await startBackupRun(t.db, 'scheduled')
    await finishBackupRun(t.db, bad, { status: 'failed', error: 'ENOSPC: no space left on device' })
    expect(await isBackupRunning(t.db)).toBe(false)
    expect(await lastFailedBackupRun(t.db)).toMatchObject({ kind: 'scheduled', error: 'ENOSPC: no space left on device' })
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    expect((await listBackupRuns(t.db, admin)).map((r) => r.status)).toEqual(['failed', 'succeeded'])
  })

  it('finishes a run only once: a second finish is a no-op (R22)', async () => {
    const id = await startBackupRun(t.db, 'manual')
    await finishBackupRun(t.db, id, { status: 'succeeded', fileName: 'my-library-0.4.0-20260928T030000Z-manual.zip', sizeBytes: 42 })
    await finishBackupRun(t.db, id, { status: 'failed', error: 'too late: this run already finished' })
    const [run] = await t.db.select().from(backupRuns)
    expect(run).toMatchObject({ status: 'succeeded', fileName: 'my-library-0.4.0-20260928T030000Z-manual.zip', sizeBytes: 42, error: null })
  })

  it('fails runs left running by a process that died', async () => {
    await startBackupRun(t.db, 'manual')
    expect(await failRunningBackupRuns(t.db, 'Interrupted')).toBe(1)
    const [run] = await t.db.select().from(backupRuns)
    expect(run).toMatchObject({ status: 'failed', error: 'Interrupted' })
  })

  it("reports the worker's last successful job, sync or backup", async () => {
    expect(await lastWorkerSuccess(t.db)).toBeNull()
    const [source] = await t.db.insert(sources).values({ kind: 'audiobookshelf', name: 'ABS', config: { kind: 'audiobookshelf' } }).returning()
    await t.db.insert(jobRuns).values({ sourceId: source?.id ?? '', trigger: 'manual', status: 'succeeded', finishedAt: new Date('2026-09-27T10:00:00Z') })
    expect(await lastWorkerSuccess(t.db)).toEqual({ job: 'sync', at: new Date('2026-09-27T10:00:00Z') })
    await t.db.insert(backupRuns).values({ kind: 'scheduled', status: 'succeeded', finishedAt: new Date('2026-09-28T03:01:00Z') })
    expect(await lastWorkerSuccess(t.db)).toEqual({ job: 'backup', at: new Date('2026-09-28T03:01:00Z') })
    // app-made backups are not the worker's
    await t.db.insert(backupRuns).values({ kind: 'pre-upgrade', status: 'succeeded', finishedAt: new Date('2026-09-28T09:00:00Z') })
    expect(await lastWorkerSuccess(t.db)).toEqual({ job: 'backup', at: new Date('2026-09-28T03:01:00Z') })
  })

  it('pings the database', async () => {
    expect(await pingDatabase(t.db)).toBe(true)
  })
})
