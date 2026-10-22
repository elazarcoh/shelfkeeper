import { describe, expect, it } from 'vitest'
import { HealthIgnoreInput, HealthListInput, healthChecks, pairKey } from './health'

describe('health inputs', () => {
  it('orders a duplicate pair key the same way whichever book comes first', () => {
    const a = '00000000-0000-4000-8000-000000000001'
    const b = '00000000-0000-4000-8000-000000000002'
    expect(pairKey(b, a)).toBe(`${a}:${b}`)
    expect(pairKey(a, b)).toBe(`${a}:${b}`)
  })

  it('defaults the list to 50 non-ignored rows and refuses an unknown check or a bad date', () => {
    expect(HealthListInput.parse({ check: 'no_isbn', today: '2026-10-18' })).toEqual({ check: 'no_isbn', today: '2026-10-18', limit: 50, showIgnored: false })
    expect(HealthListInput.safeParse({ check: 'nope', today: '2026-10-18' }).success).toBe(false)
    expect(HealthListInput.safeParse({ check: 'no_isbn', today: '18/10/2026' }).success).toBe(false)
    expect(HealthIgnoreInput.safeParse({ check: 'no_cover', subjectKey: '' }).success).toBe(false)
  })

  it('lists the ten checks in page order', () => {
    expect(healthChecks).toEqual(['no_cover', 'no_isbn', 'no_author', 'no_length', 'duplicates', 'empty_series', 'series_gaps', 'long_loans', 'kind_suggestions', 'abs_out_of_sync'])
  })
})
