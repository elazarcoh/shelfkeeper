import { describe, expect, it } from 'vitest'
import { maintenanceUrl } from './backup-view'
import { decideHandoff, FAST_DEADLINE_MS, FAST_POLL_MS, shouldContinue, SLOW_POLL_MS } from './restore-handoff'

describe('decideHandoff (ruling R9)', () => {
  it('navigates to the maintenance page once the server reports maintenance', () => {
    expect(decideHandoff({ elapsedMs: 1000, status: 'maintenance', restoreFailure: null, cancelled: false }, '/admin/backups')).toEqual({
      phase: 'navigate',
      url: maintenanceUrl('/admin/backups'),
    })
  })

  it('tolerates a poll error: treated the same as "not yet", keeps polling', () => {
    expect(decideHandoff({ elapsedMs: 1000, status: 'poll-error', restoreFailure: null, cancelled: false }, '/x')).toEqual({ phase: 'starting', pollIntervalMs: FAST_POLL_MS })
  })

  it('keeps polling fast right up to the deadline, then backs off to "still starting"', () => {
    expect(decideHandoff({ elapsedMs: FAST_DEADLINE_MS - 1, status: 'not-yet', restoreFailure: null, cancelled: false }, '/x')).toEqual({ phase: 'starting', pollIntervalMs: FAST_POLL_MS })
    expect(decideHandoff({ elapsedMs: FAST_DEADLINE_MS, status: 'not-yet', restoreFailure: null, cancelled: false }, '/x')).toEqual({ phase: 'still-starting', pollIntervalMs: SLOW_POLL_MS })
  })

  it('stops once cancelled, even if the server would otherwise report maintenance', () => {
    expect(decideHandoff({ elapsedMs: 1000, status: 'maintenance', restoreFailure: null, cancelled: true }, '/x')).toEqual({ phase: 'stopped' })
  })

  it('surfaces a restore failure recorded while waiting, instead of polling forever', () => {
    expect(decideHandoff({ elapsedMs: 25_000, status: 'not-yet', restoreFailure: 'A backup is running. Try again when it finishes.', cancelled: false }, '/x')).toEqual({
      phase: 'failed',
      reason: 'A backup is running. Try again when it finishes.',
    })
  })

  it('prefers navigating over reporting a failure recorded from an earlier attempt', () => {
    expect(decideHandoff({ elapsedMs: 25_000, status: 'maintenance', restoreFailure: 'stale failure', cancelled: false }, '/x')).toEqual({ phase: 'navigate', url: maintenanceUrl('/x') })
  })
})

describe('shouldContinue (fix round 2: mounted vs. per-attempt token)', () => {
  it('continues while mounted and the attempt token still matches the current one', () => {
    expect(shouldContinue(true, 1, 1)).toBe(true)
  })

  it('stops once unmounted, even if it is still the current attempt -- a mutation resolving after the page was left must not poll or navigate', () => {
    expect(shouldContinue(false, 1, 1)).toBe(false)
  })

  it('stops once superseded by a later attempt (a fresh restore, or the dialog being closed/cancelled), even while still mounted', () => {
    expect(shouldContinue(true, 1, 2)).toBe(false)
  })

  it('the new attempt itself continues normally after superseding an old one', () => {
    expect(shouldContinue(true, 2, 2)).toBe(true)
  })
})
