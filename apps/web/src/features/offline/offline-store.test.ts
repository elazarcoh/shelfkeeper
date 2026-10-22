import { describe, expect, it } from 'vitest'
import { needsRefresh, REFRESH_MS } from './offline-store'

const saved = (userId: string, at: string) => ({ userId, snapshot: { at, works: [] } })
const NOW = Date.parse('2026-10-22T12:00:00Z')

describe('needsRefresh', () => {
  it('fetches a copy when there is none, or it is another person’s', () => {
    expect(needsRefresh(null, 'me', NOW)).toBe(true)
    expect(needsRefresh(saved('you', '2026-10-22T11:59:00Z'), 'me', NOW)).toBe(true)
  })
  it('keeps a fresh copy and replaces an old one', () => {
    expect(needsRefresh(saved('me', '2026-10-22T11:00:00Z'), 'me', NOW)).toBe(false)
    expect(needsRefresh(saved('me', new Date(NOW - REFRESH_MS).toISOString()), 'me', NOW)).toBe(true)
  })
  it('replaces a copy with an unreadable or future date', () => {
    expect(needsRefresh(saved('me', 'yesterday'), 'me', NOW)).toBe(true)
    expect(needsRefresh(saved('me', '2026-10-23T12:00:00Z'), 'me', NOW)).toBe(true)
  })
})
