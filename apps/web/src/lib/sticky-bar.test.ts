import { describe, expect, it } from 'vitest'
import { stickyBarOffset } from './sticky-bar'

describe('stickyBarOffset', () => {
  it('is 0 with no bars, or when none is sticky (from lg the bars sit in the flow)', () => {
    expect(stickyBarOffset([])).toBe(0)
    expect(stickyBarOffset([{ sticky: false, height: 36 }])).toBe(0)
  })

  it('is the tallest sticky bar, rounded up, so a wrapped bar never covers a focused card', () => {
    expect(
      stickyBarOffset([
        { sticky: true, height: 60 },
        { sticky: true, height: 103.4 },
        { sticky: false, height: 200 },
      ]),
    ).toBe(104)
  })
})
