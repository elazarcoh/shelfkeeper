import { describe, expect, it } from 'vitest'
import { clickHalf, clickRating, halfAt, nextRating, shownRating, starFill, starForValue, stepRating } from './star-rating-logic'

describe('nextRating, tap mode (touch and keyboard)', () => {
  it('sets the tapped star', () => {
    expect(nextRating(null, 4)).toBe(4)
    expect(nextRating(2, 4)).toBe(4)
    expect(nextRating(4.5, 4)).toBe(4)
  })
  it('tapping the same star again gives the half, and once more the whole star', () => {
    expect(nextRating(4, 4)).toBe(3.5)
    expect(nextRating(3.5, 4)).toBe(4)
    expect(nextRating(5, 5)).toBe(4.5)
  })
  it('never goes below half a star', () => {
    expect(nextRating(1, 1)).toBe(0.5)
    expect(nextRating(0.5, 1)).toBe(1)
  })
})

describe('nextRating, pointed mode (mouse: the half of the star under the pointer)', () => {
  it('the left half gives the half star, the right half the whole star', () => {
    expect(nextRating(null, 4, 'left')).toBe(3.5)
    expect(nextRating(null, 4, 'right')).toBe(4)
    expect(nextRating(null, 1, 'left')).toBe(0.5)
  })
  it('does not toggle: clicking the same half again keeps the rating', () => {
    expect(nextRating(5, 5, 'right')).toBe(5)
    expect(nextRating(4.5, 5, 'left')).toBe(4.5)
    expect(nextRating(5, 5, 'left')).toBe(4.5)
    expect(nextRating(4.5, 5, 'right')).toBe(5)
  })
})

describe('halfAt', () => {
  it('splits a star at its middle; the middle itself counts as the whole star', () => {
    expect(halfAt(0, 44)).toBe('left')
    expect(halfAt(21.9, 44)).toBe('left')
    expect(halfAt(22, 44)).toBe('right')
    expect(halfAt(44, 44)).toBe('right')
  })
})

describe('clickHalf', () => {
  it('uses the half a mouse recorded for a pointer click', () => {
    expect(clickHalf(1, 'left')).toBe('left')
    expect(clickHalf(1, 'right')).toBe('right')
  })
  it('ignores a recorded half for a keyboard click (detail 0), so Enter and Space always toggle', () => {
    expect(clickHalf(0, 'left')).toBeUndefined()
    expect(clickHalf(0, 'right')).toBeUndefined()
  })
  it('no recorded half (touch, pen): tap mode', () => {
    expect(clickHalf(1, null)).toBeUndefined()
  })
})

describe('stepRating (arrow keys)', () => {
  it('steps by half a star', () => {
    expect(stepRating(3, 'ArrowRight')).toBe(3.5)
    expect(stepRating(3, 'ArrowLeft')).toBe(2.5)
  })
  it('stays within half a star and five stars', () => {
    expect(stepRating(5, 'ArrowRight')).toBe(5)
    expect(stepRating(0.5, 'ArrowLeft')).toBe(0.5)
  })
  it('starts from half a star when not rated', () => {
    expect(stepRating(null, 'ArrowRight')).toBe(0.5)
    expect(stepRating(null, 'ArrowLeft')).toBe(0.5)
  })
  it('Home and End go to the ends', () => {
    expect(stepRating(3, 'Home')).toBe(0.5)
    expect(stepRating(null, 'End')).toBe(5)
  })
  it('ignores other keys', () => {
    expect(stepRating(3, 'ArrowUp')).toBeNull()
    expect(stepRating(3, 'Enter')).toBeNull()
  })
})

describe('clickRating (what a click on a star saves)', () => {
  it('a keyboard click (Enter or Space) saves the arrow-key preview', () => {
    expect(clickRating({ detail: 0, preview: 3.5, current: null, star: 4 })).toBe(3.5)
  })
  it('with no preview, a keyboard click toggles like a tap', () => {
    expect(clickRating({ detail: 0, preview: null, current: 4, star: 4 })).toBe(3.5)
  })
  it('a pointer click ignores the preview and rates the star it hit', () => {
    expect(clickRating({ detail: 1, preview: 2, current: null, star: 4 })).toBe(4)
    expect(clickRating({ detail: 1, preview: 2, current: null, star: 4, half: 'left' })).toBe(3.5)
  })
})

describe('shownRating', () => {
  it('an arrow-key preview shows without saving; on an unrated book nothing is saved yet', () => {
    expect(shownRating({ hover: null, preview: stepRating(null, 'End'), saved: null })).toBe(5)
  })
  it('hover wins over the preview, the preview over the saved value', () => {
    expect(shownRating({ hover: 2, preview: 3, saved: 4 })).toBe(2)
    expect(shownRating({ hover: null, preview: 3, saved: 4 })).toBe(3)
  })
  it('after a save that failed, the stars show the last saved value (nothing optimistic is kept)', () => {
    // a click clears the preview and saves; the server value never changed, so that is what shows
    expect(shownRating({ hover: null, preview: null, saved: 4 })).toBe(4)
    expect(shownRating({ hover: null, preview: null, saved: null })).toBe(0)
  })
})

describe('starForValue', () => {
  it('is the star a value falls on (the one to focus and mark current)', () => {
    expect(starForValue(4.5)).toBe(5)
    expect(starForValue(4)).toBe(4)
    expect(starForValue(0.5)).toBe(1)
    expect(starForValue(null)).toBeNull()
  })
})

describe('starFill', () => {
  it('fills, half-fills or leaves each star', () => {
    expect([1, 2, 3, 4, 5].map((s) => starFill(3.5, s))).toEqual(['full', 'full', 'full', 'half', 'empty'])
    expect([1, 2, 3, 4, 5].map((s) => starFill(0, s))).toEqual(['empty', 'empty', 'empty', 'empty', 'empty'])
    expect(starFill(5, 5)).toBe('full')
  })
  it('shows a mouse hover preview of a half star (pointed mode)', () => {
    expect([1, 2, 3, 4, 5].map((s) => starFill(nextRating(null, 2, 'left'), s))).toEqual(['full', 'half', 'empty', 'empty', 'empty'])
    expect([1, 2, 3, 4, 5].map((s) => starFill(nextRating(null, 1, 'left'), s))).toEqual(['half', 'empty', 'empty', 'empty', 'empty'])
  })
  it('shows a tap-again half star (tap mode)', () => {
    expect([1, 2, 3, 4, 5].map((s) => starFill(nextRating(5, 5), s))).toEqual(['full', 'full', 'full', 'full', 'half'])
  })
})
