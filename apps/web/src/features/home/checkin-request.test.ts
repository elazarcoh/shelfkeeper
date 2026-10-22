import { describe, expect, it } from 'vitest'
import { checkinRequest, parseHomeSearch } from './checkin-request'

describe('checkinRequest', () => {
  it('opens the manual flow (everything) like the button does', () => {
    expect(checkinRequest('closed')).toBe('manual')
    expect(checkinRequest('finished')).toBe('manual')
  })
  it('leaves an open flow alone', () => {
    expect(checkinRequest('auto')).toBe('auto')
    expect(checkinRequest('manual')).toBe('manual')
  })
})

describe('parseHomeSearch', () => {
  it('keeps checkin=true only', () => {
    expect(parseHomeSearch({ checkin: true })).toEqual({ checkin: true })
    expect(parseHomeSearch({ checkin: 'true' })).toEqual({ checkin: true })
    expect(parseHomeSearch({ checkin: 1 })).toEqual({})
    expect(parseHomeSearch({})).toEqual({})
  })
})
