import { describe, expect, it } from 'vitest'
import { createSecretBox, createSource, DEV_SECRET_KEY, loadUserScope, updateBackupSettings } from '@mylib/db'
import { seedUser, useTestDb } from '@mylib/db/testing'
import { CreateSourceInput, DEFAULT_RETENTION } from '@mylib/domain'
import { SYNC_QUEUE } from '@mylib/jobs'
import { reconcileBackupSchedule, reconcileHardcoverSchedules, reconcileSchedules, type Scheduler } from './schedules'

function fakeScheduler(initial: string[] = []) {
  const schedules = new Map<string, { cron: string; tz: string }>(initial.map((k) => [k, { cron: '* * * * *', tz: 'UTC' }]))
  const scheduler: Scheduler = {
    schedule: (name, cron, _data, options) => {
      expect(name).toBe(SYNC_QUEUE)
      schedules.set(options.key, { cron, tz: options.tz })
      return Promise.resolve()
    },
    unschedule: (_name, key) => {
      schedules.delete(key)
      return Promise.resolve()
    },
    getSchedules: () => Promise.resolve([...schedules.keys()].map((key) => ({ key }))),
  }
  return { scheduler, schedules }
}

describe('reconcileSchedules', () => {
  const t = useTestDb()

  it('schedules scheduled sources and drops schedules of the rest', async () => {
    const scope = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    const box = createSecretBox(DEV_SECRET_KEY)
    const config = { kind: 'audiobookshelf', baseUrl: 'http://abs.local', apiToken: 't' }
    const daily = await createSource(t.db, scope, box, CreateSourceInput.parse({ name: 'A', config, schedule: 'daily' }))
    await createSource(t.db, scope, box, CreateSourceInput.parse({ name: 'B', config }))
    const { scheduler, schedules } = fakeScheduler(['stale-source-id'])

    await reconcileSchedules(t.db, scheduler)
    expect(Object.fromEntries(schedules)).toEqual({ [daily]: { cron: '0 3 * * *', tz: 'UTC' } })
  })
})

describe('reconcileBackupSchedule', () => {
  const t = useTestDb()

  it("schedules the nightly backup in the configured time zone, and follows an admin's change", async () => {
    const calls: { name: string; cron: string; data: object; options: object }[] = []
    const scheduler: Scheduler = {
      schedule: (name, cron, data, options) => {
        calls.push({ name, cron, data, options })
        return Promise.resolve()
      },
      unschedule: () => Promise.resolve(),
      getSchedules: () => Promise.resolve([]),
    }
    await reconcileBackupSchedule(t.db, scheduler, { defaultSchedule: '0 3 * * *', tz: 'Asia/Jerusalem' })
    expect(calls).toEqual([
      { name: 'backup', cron: '0 3 * * *', data: { kind: 'scheduled' }, options: { key: 'nightly', tz: 'Asia/Jerusalem', singletonKey: 'scheduled', missed: 'once' } },
    ])
    const admin = await loadUserScope(t.db, await seedUser(t.db, { role: 'admin' }))
    await updateBackupSettings(t.db, admin, { schedule: '30 1 * * *', retention: DEFAULT_RETENTION })
    calls.length = 0
    await reconcileBackupSchedule(t.db, scheduler, { defaultSchedule: '0 3 * * *', tz: 'Asia/Jerusalem' })
    expect(calls[0]).toMatchObject({ cron: '30 1 * * *' })
  })
})

describe('reconcileHardcoverSchedules', () => {
  it('schedules the nightly refresh and the hourly send in UTC', async () => {
    const calls: { name: string; cron: string; data: object; options: object }[] = []
    const scheduler: Scheduler = {
      schedule: (name, cron, data, options) => {
        calls.push({ name, cron, data, options })
        return Promise.resolve()
      },
      unschedule: () => Promise.resolve(),
      getSchedules: () => Promise.resolve([]),
    }
    await reconcileHardcoverSchedules(scheduler)
    expect(calls).toEqual([
      { name: 'hardcover', cron: '30 2 * * *', data: { kind: 'refresh', trigger: 'schedule', requestedBy: null }, options: { key: 'refresh', tz: 'UTC', singletonKey: 'refresh' } },
      { name: 'hardcover', cron: '15 * * * *', data: { kind: 'send', trigger: 'schedule', requestedBy: null }, options: { key: 'send', tz: 'UTC', singletonKey: 'send' } },
    ])
  })
})
