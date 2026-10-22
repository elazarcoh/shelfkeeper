import { describe, expect, it } from 'vitest'
import { emptySyncStats, type SyncStats } from '@mylib/domain'
import { formatRunDuration, isActive, statsLine } from './job-summary'

describe('job summary', () => {
  it('summarizes only the counts that happened', () => {
    expect(statsLine({ ...emptySyncStats(), seen: 12, created: 3, removed: 1 })).toBe('12 seen · 3 new · 1 gone')
    expect(statsLine(emptySyncStats())).toBe('Nothing found')
    expect(statsLine(null)).toBe('')
    expect(statsLine({ ...emptySyncStats(), seen: 5, linked: 4 })).toBe('5 seen · 4 linked to copies already here')
    // a run recorded before #104 has no linked count
    const before: SyncStats = { ...emptySyncStats(), seen: 1 }
    delete before.linked
    expect(statsLine(before)).toBe('1 seen')
  })
  it('knows which runs are still going', () => {
    expect(isActive('queued')).toBe(true)
    expect(isActive('running')).toBe(true)
    expect(isActive('failed')).toBe(false)
  })
  it('formats how long a finished run took', () => {
    expect(formatRunDuration(new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:02:05Z'))).toBe('2m 5s')
    expect(formatRunDuration(new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:09Z'))).toBe('9s')
  })
  it('has no duration for a run that has not both started and finished', () => {
    expect(formatRunDuration(null, null)).toBeNull()
    expect(formatRunDuration(new Date(), null)).toBeNull()
  })
})
