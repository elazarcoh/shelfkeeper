import { describe, expect, it } from 'vitest'
import { firstFollowing } from './removal-focus'

describe('firstFollowing', () => {
  const rows = ['a', 'b', 'c', 'd']
  const after = (anchor: string) => (row: string) => row > anchor

  it('is the first candidate after the removed one', () => {
    expect(firstFollowing(rows, after('b'))).toBe('c')
  })
  it('is null after the last candidate, so the caller falls back to the heading', () => {
    expect(firstFollowing(rows, after('d'))).toBeNull()
    expect(firstFollowing([], after('a'))).toBeNull()
  })
  it('skips candidates that are not shown (the phone-only or desktop-only copy of a control)', () => {
    const shown = (row: string) => row !== 'c'
    expect(firstFollowing(rows, after('b'), shown)).toBe('d')
    expect(firstFollowing(['a', 'b', 'c'], after('b'), shown)).toBeNull()
  })
})
