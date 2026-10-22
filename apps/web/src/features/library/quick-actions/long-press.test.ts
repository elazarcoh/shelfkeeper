import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLongPress, LONG_PRESS_MS } from './long-press'

const touch = (x = 0, y = 0) => ({ pointerType: 'touch', clientX: x, clientY: y })

describe('createLongPress', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires after holding still, and swallows exactly the click that follows', () => {
    const fired = vi.fn()
    const lp = createLongPress(fired)
    lp.down(touch())
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledOnce()
    lp.end()
    expect(lp.takeClick()).toBe(true)
    expect(lp.takeClick()).toBe(false)
  })

  it('a short tap does not fire and its click goes through', () => {
    const fired = vi.fn()
    const lp = createLongPress(fired)
    lp.down(touch())
    vi.advanceTimersByTime(200)
    lp.end()
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).not.toHaveBeenCalled()
    expect(lp.takeClick()).toBe(false)
  })

  it('moving 10px or more (a scroll) cancels; a small wobble does not', () => {
    const fired = vi.fn()
    const lp = createLongPress(fired)
    lp.down(touch(100, 100))
    lp.move(touch(104, 105))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toHaveBeenCalledOnce()

    lp.down(touch(100, 100))
    lp.move(touch(100, 110))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toHaveBeenCalledOnce()
  })

  it('a mouse never long-presses (right-click covers it)', () => {
    const fired = vi.fn()
    const lp = createLongPress(fired)
    lp.down({ pointerType: 'mouse', clientX: 0, clientY: 0 })
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    expect(fired).not.toHaveBeenCalled()
  })

  it('a new press clears a long-press whose click never came', () => {
    const lp = createLongPress(() => {})
    lp.down(touch())
    vi.advanceTimersByTime(LONG_PRESS_MS)
    lp.down(touch())
    lp.end()
    expect(lp.takeClick()).toBe(false)
  })

  it('dispose stops a pending press', () => {
    const fired = vi.fn()
    const lp = createLongPress(fired)
    lp.down(touch())
    lp.dispose()
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).not.toHaveBeenCalled()
  })
})
