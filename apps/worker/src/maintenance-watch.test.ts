import { describe, expect, it } from 'vitest'
import { getMaintenance, markWorkerPaused, setMaintenance, waitForWorkerPause } from '@mylib/db'
import { useTestDb } from '@mylib/db/testing'
import type { MaintenanceState } from '@mylib/domain'
import { MaintenanceWatcher } from './maintenance-watch'

const restoring: MaintenanceState = { reason: 'restore', message: 'Restoring.', since: '2026-09-28T03:00:00.000Z', backupName: 'x.zip' }

function fake(initial: MaintenanceState | null) {
  let state = initial
  let reachable = true
  let failNextStart = false
  let failNextStop = false
  let drained = true
  const events: string[] = []
  const logs: string[] = []
  const watcher = new MaintenanceWatcher({
    readState: () => (reachable ? Promise.resolve(state) : Promise.reject(new Error('database is not accepting connections'))),
    acknowledge: (at) => {
      events.push(at === null ? 'ack:resumed' : 'ack:paused')
      return Promise.resolve()
    },
    work: {
      start: () => {
        events.push('start')
        if (failNextStart) {
          failNextStart = false
          return Promise.reject(new Error('pg-boss could not reconnect'))
        }
        return Promise.resolve()
      },
      stop: () => {
        events.push('stop')
        if (failNextStop) {
          failNextStop = false
          return Promise.reject(new Error('pg-boss stop failed'))
        }
        return Promise.resolve(drained)
      },
    },
    now: () => new Date('2026-09-28T03:00:05Z'),
    log: (message) => logs.push(message),
  })
  return {
    watcher,
    events,
    logs,
    set: (next: MaintenanceState | null) => {
      state = next
    },
    setReachable: (value: boolean) => {
      reachable = value
    },
    failNextStart: () => {
      failNextStart = true
    },
    failNextStop: () => {
      failNextStop = true
    },
    stopTimesOut: () => {
      drained = false
    },
  }
}

describe('MaintenanceWatcher', () => {
  it('stops work on maintenance, acknowledges it once, and resumes when it ends', async () => {
    const f = fake(null)
    await f.watcher.tick()
    expect(f.events).toEqual([])
    f.set(restoring)
    await f.watcher.tick()
    await f.watcher.tick()
    expect(f.events).toEqual(['stop', 'ack:paused'])
    expect(f.watcher.paused).toBe(true)
    f.set(null)
    await f.watcher.tick()
    expect(f.events).toEqual(['stop', 'ack:paused', 'start', 'ack:resumed'])
    expect(f.watcher.paused).toBe(false)
  })

  it('keeps what it is doing while the database is unreachable (mid-swap)', async () => {
    const f = fake(restoring)
    await f.watcher.tick()
    f.setReachable(false)
    f.set(null)
    await f.watcher.tick()
    expect(f.watcher.paused).toBe(true)
    f.setReachable(true)
    await f.watcher.tick()
    expect(f.watcher.paused).toBe(false)
  })

  it('recovers after work.start() rejects once, without crashing, and resumes on the next tick', async () => {
    const f = fake(restoring)
    await f.watcher.tick() // pauses
    expect(f.watcher.paused).toBe(true)
    f.set(null)
    f.failNextStart()
    await f.watcher.tick() // start() rejects
    expect(f.watcher.paused).toBe(true) // unchanged: start failed, so the next tick retries it
    expect(f.events).toEqual(['stop', 'ack:paused', 'start'])
    expect(f.logs.some((message) => message.includes('could not resume'))).toBe(true)
    await f.watcher.tick() // start() succeeds this time
    expect(f.watcher.paused).toBe(false)
    expect(f.events).toEqual(['stop', 'ack:paused', 'start', 'start', 'ack:resumed'])
  })

  it('recovers after work.stop() rejects once, without crashing, and pauses on the next tick', async () => {
    const f = fake(null)
    f.set(restoring)
    f.failNextStop()
    await f.watcher.tick() // stop() rejects
    expect(f.watcher.paused).toBe(false) // never acknowledges while pg-boss could still take jobs
    expect(f.events).toEqual(['stop'])
    expect(f.logs.some((message) => message.includes('could not stop'))).toBe(true)
    await f.watcher.tick() // stop() succeeds this time
    expect(f.watcher.paused).toBe(true)
    expect(f.events).toEqual(['stop', 'stop', 'ack:paused'])
  })

  it('acknowledges each pause and resume across a full second cycle', async () => {
    const f = fake(null)
    f.set(restoring)
    await f.watcher.tick()
    f.set(null)
    await f.watcher.tick()
    const secondRestore: MaintenanceState = { ...restoring, since: '2026-09-28T04:00:00.000Z' }
    f.set(secondRestore)
    await f.watcher.tick()
    f.set(null)
    await f.watcher.tick()
    expect(f.events).toEqual(['stop', 'ack:paused', 'start', 'ack:resumed', 'stop', 'ack:paused', 'start', 'ack:resumed'])
  })

  it('does not confirm a pause whose graceful stop timed out with a job still running (final fix 6)', async () => {
    const f = fake(null)
    f.set(restoring)
    f.stopTimesOut()
    await f.watcher.tick()
    await f.watcher.tick()
    expect(f.watcher.paused).toBe(true)
    expect(f.events).toEqual(['stop'])
    expect(f.logs.some((message) => message.includes('not confirming the pause'))).toBe(true)
    f.set(null)
    await f.watcher.tick()
    expect(f.events).toEqual(['stop', 'start', 'ack:resumed'])
  })

  it("re-acknowledges when maintenance's since changes while still paused (a second restore before the first resumed)", async () => {
    const f = fake(null)
    f.set(restoring)
    await f.watcher.tick()
    expect(f.events).toEqual(['stop', 'ack:paused'])
    const secondRestore: MaintenanceState = { ...restoring, since: '2026-09-28T04:00:00.000Z' }
    f.set(secondRestore)
    await f.watcher.tick()
    expect(f.events).toEqual(['stop', 'ack:paused', 'ack:paused'])
    expect(f.watcher.paused).toBe(true)
  })
})

describe('MaintenanceWatcher with the database', () => {
  const t = useTestDb()

  it('acknowledges a restore so the app stops waiting for it', async () => {
    const since = new Date()
    await setMaintenance(t.db, { ...restoring, since: since.toISOString() })
    const watcher = new MaintenanceWatcher({
      readState: () => getMaintenance(t.db),
      acknowledge: (at) => markWorkerPaused(t.db, at),
      work: { start: () => Promise.resolve(), stop: () => Promise.resolve(true) },
      now: () => new Date(),
      log: () => undefined,
    })
    await watcher.tick()
    expect(await waitForWorkerPause(t.db, since, 100, 10)).toBe(true)
  })

  it('leaves the restore unconfirmed when the stop did not drain (the summary then says workerPauseUnconfirmed)', async () => {
    const since = new Date()
    await markWorkerPaused(t.db, null)
    await setMaintenance(t.db, { ...restoring, since: since.toISOString() })
    const watcher = new MaintenanceWatcher({
      readState: () => getMaintenance(t.db),
      acknowledge: (at) => markWorkerPaused(t.db, at),
      work: { start: () => Promise.resolve(), stop: () => Promise.resolve(false) },
      now: () => new Date(),
      log: () => undefined,
    })
    await watcher.tick()
    expect(await waitForWorkerPause(t.db, since, 100, 10)).toBe(false)
  })
})
