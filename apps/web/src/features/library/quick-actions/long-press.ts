export const LONG_PRESS_MS = 500
/** further than this from where the finger went down is a scroll, not a press */
export const LONG_PRESS_SLOP_PX = 10

export interface PointerLike {
  pointerType: string
  clientX: number
  clientY: number
}

export interface LongPressTracker {
  down(e: PointerLike): void
  move(e: PointerLike): void
  /** pointerup or pointercancel */
  end(): void
  /** true, once, for the click that follows a long-press that fired: the caller swallows it */
  takeClick(): boolean
  dispose(): void
}

/** A touch or pen held still for LONG_PRESS_MS. Mouse presses are ignored: a mouse has the right-click menu. */
export function createLongPress(onLongPress: () => void): LongPressTracker {
  let timer: ReturnType<typeof setTimeout> | undefined
  let origin: { x: number; y: number } | null = null
  let fired = false
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    origin = null
  }
  return {
    down(e) {
      clear()
      fired = false
      if (e.pointerType === 'mouse') return
      origin = { x: e.clientX, y: e.clientY }
      timer = setTimeout(() => {
        timer = undefined
        origin = null
        fired = true
        onLongPress()
      }, LONG_PRESS_MS)
    },
    move(e) {
      if (origin !== null && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) >= LONG_PRESS_SLOP_PX) clear()
    },
    end: clear,
    takeClick() {
      const was = fired
      fired = false
      return was
    },
    dispose: clear,
  }
}
