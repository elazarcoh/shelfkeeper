import { describe, expect, it } from 'vitest'
import { bookSearchPending } from './book-search-state'

describe('bookSearchPending', () => {
  it('is false for an empty or blank query (no search runs)', () => {
    expect(bookSearchPending('', '', false)).toBe(false)
    expect(bookSearchPending('  ', '', false)).toBe(false)
  })
  it('is true while the debounce has not caught up', () => {
    expect(bookSearchPending('dune', 'dun', false)).toBe(true)
    expect(bookSearchPending('dune', '', false)).toBe(true)
  })
  it('is true while the settled query is being fetched', () => {
    expect(bookSearchPending('dune', 'dune', true)).toBe(true)
  })
  it('is false once the settled query has been answered', () => {
    expect(bookSearchPending('dune', 'dune', false)).toBe(false)
  })
})
