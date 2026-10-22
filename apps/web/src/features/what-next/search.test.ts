import { describe, expect, it } from 'vitest'
import { parseNextSearch } from './search'

describe('parseNextSearch', () => {
  it('keeps a known mood and format', () => {
    expect(parseNextSearch({ mood: 'light', format: 'audio' })).toEqual({ mood: 'light', format: 'audio' })
    expect(parseNextSearch({ mood: 'keep_going', format: 'any' })).toEqual({ mood: 'keep_going', format: 'any' })
  })

  it('drops unknown values', () => {
    expect(parseNextSearch({ mood: 'grim', format: 'paper' })).toEqual({})
    expect(parseNextSearch({ mood: 3, format: null })).toEqual({})
  })

  it('keeps one valid value beside an invalid one', () => {
    expect(parseNextSearch({ mood: 'surprise', format: 'x' })).toEqual({ mood: 'surprise' })
  })
})
