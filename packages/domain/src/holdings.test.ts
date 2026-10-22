import { describe, expect, it } from 'vitest'
import { applyHoldingAction, availableHoldingActions, deriveAvailability, HoldingChange } from './holdings'

const owned = { ownership: 'owned' as const, inPossession: true }
const gone = { ownership: 'owned' as const, inPossession: false }
const borrowed = { ownership: 'borrowed' as const, inPossession: true }
const returned = { ownership: 'borrowed' as const, inPossession: false }

describe('holdings', () => {
  it('allows only valid transitions', () => {
    expect(applyHoldingAction(owned, 'no_longer_have')).toEqual({ next: gone, event: 'removed' })
    expect(applyHoldingAction(gone, 'got_back')).toEqual({ next: owned, event: 'restored' })
    expect(applyHoldingAction(borrowed, 'returned')).toEqual({ next: returned, event: 'returned' })
    expect(applyHoldingAction(returned, 'borrowed_again')).toEqual({ next: borrowed, event: 'borrowed' })
    expect(applyHoldingAction(returned, 'bought')).toEqual({ next: owned, event: 'acquired' })
    expect(applyHoldingAction(owned, 'returned')).toBeNull()
    expect(applyHoldingAction(gone, 'no_longer_have')).toBeNull()
  })
  it('lists the actions available from each state', () => {
    expect(availableHoldingActions(owned)).toEqual(['no_longer_have'])
    expect(availableHoldingActions(gone)).toEqual(['got_back'])
    expect(availableHoldingActions(borrowed)).toEqual(['returned', 'bought'])
    expect(availableHoldingActions(returned)).toEqual(['borrowed_again', 'bought'])
  })
  it('derives work availability by precedence', () => {
    expect(deriveAvailability([])).toBe('wanted')
    expect(deriveAvailability([gone, owned])).toBe('owned')
    expect(deriveAvailability([gone, borrowed])).toBe('borrowed')
    expect(deriveAvailability([gone, returned])).toBe('formerly_owned')
    expect(deriveAvailability([returned])).toBe('not_owned')
  })
  it('requires the date and defaults the note of a change', () => {
    expect(HoldingChange.parse({ action: 'returned', on: '2026-01-01' })).toEqual({ action: 'returned', on: '2026-01-01', note: null })
  })
})
