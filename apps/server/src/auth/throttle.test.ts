import { describe, expect, it } from 'vitest'
import { LoginThrottle } from './throttle'

describe('LoginThrottle', () => {
  it('allows 5 attempts inside the window and forgets them afterwards', () => {
    let now = 0
    const throttle = new LoginThrottle(5, 15 * 60_000, () => now)
    for (let i = 0; i < 5; i++) expect(throttle.attempt('kid')).toBe(true)
    expect(throttle.attempt('kid')).toBe(false)
    expect(throttle.attempt('parent')).toBe(true)
    now = 15 * 60_000 + 1
    expect(throttle.attempt('kid')).toBe(true)
  })
  it('does not extend the block with rejected attempts', () => {
    let now = 0
    const throttle = new LoginThrottle(5, 15 * 60_000, () => now)
    for (let i = 0; i < 5; i++) throttle.attempt('kid')
    now = 10 * 60_000
    expect(throttle.attempt('kid')).toBe(false)
    now = 15 * 60_000 + 1
    expect(throttle.attempt('kid')).toBe(true)
  })
  it('resets on success', () => {
    const throttle = new LoginThrottle()
    for (let i = 0; i < 5; i++) throttle.attempt('kid')
    throttle.reset('kid')
    expect(throttle.attempt('kid')).toBe(true)
  })
  it('evicts keys whose attempts have all expired', () => {
    let now = 0
    const throttle = new LoginThrottle(5, 15 * 60_000, () => now)
    throttle.attempt('a')
    throttle.attempt('b')
    expect(throttle.trackedKeys).toBe(2)
    now = 15 * 60_000 + 1
    throttle.attempt('c')
    expect(throttle.trackedKeys).toBe(1)
  })
})
