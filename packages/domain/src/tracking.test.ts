import { describe, expect, it } from 'vitest'
import { RatingValue } from './tracking'

describe('RatingValue', () => {
  it('accepts half-star steps between 0.5 and 5', () => {
    for (const v of [0.5, 1, 3.5, 4.5, 5]) expect(RatingValue.safeParse(v).success).toBe(true)
  })
  it('rejects other values', () => {
    for (const v of [0, 4.3, 5.5, -1]) expect(RatingValue.safeParse(v).success).toBe(false)
  })
})
