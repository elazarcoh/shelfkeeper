/** Which half of a star the mouse is over. */
export type StarHalf = 'left' | 'right'

/**
 * The rating a press on `star` gives.
 * - Tap mode (touch, pen, keyboard; no `half`): tap a star to set it; tap the same star again for the half (4 → 3.5); again for the whole star.
 * - Pointed mode (a mouse, which can aim; `half` given): the left half of a star gives the half, the right half the whole star.
 */
export function nextRating(current: number | null, star: number, half?: StarHalf): number {
  if (half !== undefined) return half === 'left' ? star - 0.5 : star
  return current === star ? star - 0.5 : star
}

/** The half of a star at `offset` px from its left edge; the middle counts as the whole star. */
export function halfAt(offset: number, width: number): StarHalf {
  return offset < width / 2 ? 'left' : 'right'
}

/**
 * The half a click uses: the one a mouse recorded on pointerdown, but never for a keyboard click (`detail` 0),
 * so a half left over from a press that did not end in a click cannot leak into Enter or Space.
 */
export function clickHalf(detail: number, recorded: StarHalf | null): StarHalf | undefined {
  return detail === 0 || recorded === null ? undefined : recorded
}

const MIN = 0.5
const MAX = 5

/** Arrow keys step by half a star (left/right), Home/End go to the ends; null for any other key. */
export function stepRating(current: number | null, key: string): number | null {
  switch (key) {
    case 'ArrowRight':
      return current === null ? MIN : Math.min(MAX, current + 0.5)
    case 'ArrowLeft':
      return current === null ? MIN : Math.max(MIN, current - 0.5)
    case 'Home':
      return MIN
    case 'End':
      return MAX
    default:
      return null
  }
}

/**
 * What a click on `star` saves. Arrow keys only preview (nothing is saved, so a stray key on an unrated book
 * writes nothing); a keyboard click (Enter or Space, `detail` 0) saves the preview. Otherwise as `nextRating`.
 */
export function clickRating(c: { detail: number; preview: number | null; current: number | null; star: number; half?: StarHalf | undefined }): number {
  if (c.detail === 0 && c.preview !== null) return c.preview
  return nextRating(c.current, c.star, c.half)
}

/**
 * The value the stars show: a mouse hover, else an arrow-key preview, else the saved (server) value.
 * Nothing optimistic is kept after a save, so a save that fails leaves the last saved value showing.
 */
export function shownRating(s: { hover: number | null; preview: number | null; saved: number | null }): number {
  return s.hover ?? s.preview ?? s.saved ?? 0
}

/** The star a rating falls on (4.5 → 5): the one marked current and focused after an arrow key. */
export function starForValue(value: number | null): number | null {
  return value === null ? null : Math.ceil(value)
}

export function starFill(value: number, star: number): 'full' | 'half' | 'empty' {
  if (value >= star) return 'full'
  if (value >= star - 0.5) return 'half'
  return 'empty'
}
