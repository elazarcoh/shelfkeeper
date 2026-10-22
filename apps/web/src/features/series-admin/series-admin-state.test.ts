import { describe, expect, it } from 'vitest'
import { mergePrimaryDefault, seriesSummary, splitDisabled } from './series-admin-state'

describe('splitDisabled', () => {
  it('needs at least one book ticked and at least one left behind', () => {
    expect(splitDisabled(0, 3)).toBe(true)
    expect(splitDisabled(1, 3)).toBe(false)
    expect(splitDisabled(2, 3)).toBe(false)
    expect(splitDisabled(3, 3)).toBe(true)
  })
})

describe('mergePrimaryDefault', () => {
  it('defaults to the primary name of the series with more books, the opened one on a tie', () => {
    const opened = { names: [{ id: 'a', primary: true }], bookCount: 1 }
    const other = { names: [{ id: 'b', primary: true }], bookCount: 2 }
    expect(mergePrimaryDefault(opened, other)).toBe('b')
    expect(mergePrimaryDefault(opened, { ...other, bookCount: 1 })).toBe('a')
  })
})

describe('seriesSummary', () => {
  it('counts the books', () => {
    expect(seriesSummary(0)).toBe('No books')
    expect(seriesSummary(1)).toBe('1 book')
    expect(seriesSummary(4)).toBe('4 books')
  })
})
