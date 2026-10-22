import { describe, expect, it } from 'vitest'
import { activityPreview, ACTIVITY_PREVIEW } from './activity-preview'

const items = Array.from({ length: 12 }, (_, i) => i)

describe('activityPreview', () => {
  it('shows the first five and counts the rest', () => {
    expect(ACTIVITY_PREVIEW).toBe(5)
    expect(activityPreview(items, false)).toEqual({ shown: [0, 1, 2, 3, 4], hidden: 7 })
  })
  it('shows everything once expanded', () => {
    expect(activityPreview(items, true)).toEqual({ shown: items, hidden: 0 })
  })
  it('hides nothing when there are five or fewer', () => {
    expect(activityPreview([1, 2, 3], false)).toEqual({ shown: [1, 2, 3], hidden: 0 })
    expect(activityPreview([], false)).toEqual({ shown: [], hidden: 0 })
  })
})
