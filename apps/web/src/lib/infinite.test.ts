import { describe, expect, it } from 'vitest'
import { nextLimit, nextOffset, uniqueItems } from './infinite'

const page = (n: number, total: number) => ({ items: Array.from({ length: n }, (_, i) => i), total })

describe('nextOffset', () => {
  it('asks for the page after the loaded ones while the total says there are more', () => {
    expect(nextOffset([page(2, 5)], 2)).toBe(2)
    expect(nextOffset([page(2, 5), page(2, 5)], 2)).toBe(4)
  })

  it('stops at the total, on a short page, and before the first page', () => {
    expect(nextOffset([page(2, 4), page(2, 4)], 2)).toBeUndefined()
    expect(nextOffset([page(2, 9), page(1, 9)], 2)).toBeUndefined()
    expect(nextOffset([page(0, 0)], 2)).toBeUndefined()
    expect(nextOffset([], 2)).toBeUndefined()
  })
})

describe('uniqueItems', () => {
  it('joins the pages in order, keeping an entry shifted into the next page once', () => {
    expect(uniqueItems([{ items: ['a', 'b'] }, { items: ['b', 'c'] }], (s) => s)).toEqual(['a', 'b', 'c'])
  })
})

describe('nextLimit', () => {
  it('grows the limit only when the list came back full', () => {
    expect(nextLimit(50, 50, 50)).toBe(100)
    expect(nextLimit(49, 50, 50)).toBeNull()
  })
})
