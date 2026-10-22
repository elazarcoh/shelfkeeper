import { describe, expect, it } from 'vitest'
import { quickActionModel, type QuickActionInput } from '@/features/library/quick-actions/quick-action-model'
import { bookItems, matchesQuery } from './book-items'

const base: QuickActionInput = {
  isAdmin: true,
  status: 'none',
  inQueue: false,
  rating: 4,
  formats: ['physical'],
  inProgress: [],
  sessionsFailed: false,
  editableSets: [{ id: 's1', name: 'Favourites' }, { id: 's2', name: 'Summer' }],
  memberSetIds: new Set(['s2']),
}

const labels = (input: QuickActionInput) => bookItems(quickActionModel(input)).map((i) => i.label)

describe('bookItems', () => {
  it('starts with Open book, then the card’s actions in order, without Merge or rating steps', () => {
    expect(labels(base)).toEqual([
      'Open book',
      'Start reading',
      'Mark as read',
      'Want to read',
      'Add to Up next',
      'Clear rating',
      'Add to set Favourites',
      'Remove from set Summer',
    ])
  })
  it('shows a disabled loading row while sessions or sets load', () => {
    const items = bookItems(quickActionModel({ ...base, inProgress: undefined, memberSetIds: undefined }))
    expect(items.filter((i) => 'disabled' in i && i.disabled).map((i) => i.label)).toEqual(['Loading…', 'Loading sets…'])
  })
  it('leaves out Clear rating without a rating and the sets with no editable sets', () => {
    expect(labels({ ...base, rating: null, editableSets: [] })).toEqual(['Open book', 'Start reading', 'Mark as read', 'Want to read', 'Add to Up next'])
  })
})

describe('matchesQuery', () => {
  it('matches everything for an empty query, and labels by word prefix', () => {
    expect(matchesQuery('', 'x')).toBe(true)
    expect(matchesQuery('up', 'Add to Up next')).toBe(true)
    expect(matchesQuery('zz', 'Add to Up next')).toBe(false)
  })
})
