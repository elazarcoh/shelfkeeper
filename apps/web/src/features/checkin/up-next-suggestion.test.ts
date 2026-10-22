import { describe, expect, it } from 'vitest'
import { upNextSuggestion } from './up-next-suggestion'

describe('upNextSuggestion (#84)', () => {
  it('suggests the first book in Up next', () => {
    expect(upNextSuggestion([{ id: 'a', status: 'none' as const }, { id: 'b', status: 'none' as const }])?.id).toBe('a')
  })
  it('skips a book already being read (left in Up next from before #85)', () => {
    expect(upNextSuggestion([{ id: 'a', status: 'reading' as const }, { id: 'b', status: 'read' as const }])?.id).toBe('b')
  })
  it('suggests nothing when Up next is empty or all of it is being read', () => {
    expect(upNextSuggestion([])).toBeNull()
    expect(upNextSuggestion([{ id: 'a', status: 'reading' as const }])).toBeNull()
  })
})
