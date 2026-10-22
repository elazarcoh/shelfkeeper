import { describe, expect, it } from 'vitest'
import { FilterNode, SmartFilter, filterFromFacets, mentionsAvailability } from './filter'

const AUTHOR = '0b6f5a57-6f0e-4d8c-9b9b-1c1f7b2f2a11'

describe('FilterNode', () => {
  it('parses nested filters', () => {
    const f = FilterNode.parse({
      op: 'and',
      nodes: [{ op: 'format', formats: ['audiobook'] }, { op: 'not', node: { op: 'status', statuses: ['read'] } }],
    })
    expect(f.op).toBe('and')
  })
  it('rejects unknown ops, empty lists and bad ids', () => {
    expect(FilterNode.safeParse({ op: 'nope' }).success).toBe(false)
    expect(FilterNode.safeParse({ op: 'format', formats: [] }).success).toBe(false)
    expect(FilterNode.safeParse({ op: 'author', contributorIds: ['x'] }).success).toBe(false)
  })
  it('rejects an inverted rating range', () => {
    expect(FilterNode.safeParse({ op: 'rating', min: 4, max: 2 }).success).toBe(false)
  })
  it('limits nesting depth to 8', () => {
    let node: FilterNode = { op: 'format', formats: ['ebook'] }
    for (let i = 0; i < 7; i++) node = { op: 'not', node }
    expect(SmartFilter.safeParse(node).success).toBe(true)
    node = { op: 'not', node }
    expect(SmartFilter.safeParse(node).success).toBe(false)
  })
})

describe('filterFromFacets', () => {
  it('returns null when nothing is selected', () => {
    expect(filterFromFacets({})).toBeNull()
    expect(filterFromFacets({ formats: [] })).toBeNull()
  })
  it('returns a single predicate unwrapped', () => {
    expect(filterFromFacets({ formats: ['audiobook'] })).toEqual({ op: 'format', formats: ['audiobook'] })
    expect(filterFromFacets({ availability: ['owned', 'borrowed'] })).toEqual({ op: 'availability', values: ['owned', 'borrowed'] })
  })
  it('filters by kind', () => {
    expect(filterFromFacets({ kinds: ['fanfiction'] })).toEqual({ op: 'kind', kinds: ['fanfiction'] })
    expect(filterFromFacets({ kinds: [] })).toBeNull()
    expect(FilterNode.safeParse({ op: 'kind', kinds: [] }).success).toBe(false)
    expect(FilterNode.safeParse({ op: 'kind', kinds: ['comic'] }).success).toBe(false)
  })
  it('ANDs several predicates', () => {
    expect(filterFromFacets({ authorIds: [AUTHOR], minRating: 4 })).toEqual({
      op: 'and',
      nodes: [
        { op: 'author', contributorIds: [AUTHOR] },
        { op: 'rating', min: 4, max: 5 },
      ],
    })
  })
})

describe('mentionsAvailability', () => {
  it('finds an availability node anywhere in the tree', () => {
    expect(mentionsAvailability(null)).toBe(false)
    expect(mentionsAvailability({ op: 'format', formats: ['ebook'] })).toBe(false)
    expect(mentionsAvailability({ op: 'and', nodes: [{ op: 'format', formats: ['ebook'] }, { op: 'not', node: { op: 'availability', values: ['wanted'] } }] })).toBe(true)
  })
})
