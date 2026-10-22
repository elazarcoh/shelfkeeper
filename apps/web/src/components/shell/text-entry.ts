export interface FocusTarget {
  tagName: string
  type?: string | undefined
  isContentEditable?: boolean | undefined
  readOnly?: boolean | undefined
}

// inputs that never bring up a keyboard (date/time ones open a picker instead)
const NO_KEYBOARD = new Set(['button', 'checkbox', 'color', 'date', 'datetime-local', 'file', 'hidden', 'image', 'month', 'radio', 'range', 'reset', 'submit', 'time', 'week'])

/** Does focusing this element open the virtual keyboard? */
export function isTextEntry(el: FocusTarget | null | undefined): boolean {
  if (!el) return false
  if (el.isContentEditable === true) return true
  const tag = el.tagName.toUpperCase()
  if (el.readOnly === true) return false
  if (tag === 'TEXTAREA') return true
  if (tag !== 'INPUT') return false
  return !NO_KEYBOARD.has((el.type ?? 'text').toLowerCase())
}

export function shouldHideBottomNav(state: { textEntryFocused: boolean; coarsePointer: boolean; keyboardOpen: boolean }): boolean {
  return state.textEntryFocused && state.coarsePointer && state.keyboardOpen
}

/** The part of `document` the focus watcher needs (a fake one in tests). */
export interface FocusSource {
  readonly activeElement: FocusTarget | null
  addEventListener(type: 'focusin' | 'focusout', listener: () => void): void
  removeEventListener(type: 'focusin' | 'focusout', listener: () => void): void
}

export interface TextEntryWatcher {
  /** Re-read the focused element now: a route change can unmount the focused field without any focus event. */
  recheck: () => void
  stop: () => void
}

/** Calls onChange with whether a keyboard-opening field has focus, each time focus moves. */
export function watchTextEntryFocus(doc: FocusSource, onChange: (textEntryFocused: boolean) => void): TextEntryWatcher {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const recheck = () => {
    if (!stopped) onChange(isTextEntry(doc.activeElement))
  }
  // Moving from field A to field B passes through <body> (focusout, then focusin): read activeElement only
  // once focus has settled, or the bar would flash above the open keyboard. A field that unmounts without
  // any focus event is caught by recheck() on route change.
  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(recheck, 0)
  }
  doc.addEventListener('focusin', later)
  doc.addEventListener('focusout', later)
  return {
    recheck,
    stop: () => {
      stopped = true
      clearTimeout(timer)
      doc.removeEventListener('focusin', later)
      doc.removeEventListener('focusout', later)
    },
  }
}

/** An on-screen keyboard takes at least this much height; the URL bar collapsing takes less. */
const KEYBOARD_MIN_PX = 150

/**
 * Is an on-screen keyboard up? Without visualViewport we cannot tell, so we assume yes (focus alone decides).
 * iOS shrinks only the visual viewport; Android with interactive-widget=resizes-content shrinks the layout
 * viewport too, so we also compare against the keyboard-free height seen at this width (baselineHeight).
 */
export function keyboardOpen(s: { visualHeight: number | undefined; layoutHeight: number; baselineHeight: number }): boolean {
  if (s.visualHeight === undefined) return true
  return Math.max(s.layoutHeight, s.baselineHeight) - s.visualHeight > KEYBOARD_MIN_PX
}

/**
 * Tracks the keyboard-free viewport height: the tallest height at the current width. It starts over when the
 * width changes, on reset() (rotation), and whenever nothing is being typed (then no keyboard can be up, so the
 * current height is the keyboard-free one: an iPad split-view window that got shorter, say).
 */
export function viewportBaseline() {
  let width = -1
  let tallest = 0
  return {
    update(w: number, h: number, nothingTyped: boolean): number {
      if (w !== width || nothingTyped) {
        width = w
        tallest = h
      } else tallest = Math.max(tallest, h)
      return tallest
    },
    reset() {
      width = -1
    },
  }
}

export interface ViewportSource {
  readonly width: number
  readonly height: number
  /** How far iOS has panned the visual viewport down the layout viewport (it does so with the keyboard up). */
  readonly offsetTop: number
  /** Pinch-zoom; the visual viewport shrinks with it, which is not a keyboard. */
  readonly scale: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}

/** The part of `window` the keyboard watcher needs (a fake one in tests). */
export interface KeyboardSource {
  readonly innerHeight: number
  readonly visualViewport: ViewportSource | null
  addEventListener(type: 'orientationchange', listener: () => void): void
  removeEventListener(type: 'orientationchange', listener: () => void): void
}

/**
 * Calls onChange with whether an on-screen keyboard is up, now and on every visual viewport resize.
 * textEntryFocused says whether a keyboard-opening field has focus right now (none: the height is keyboard-free).
 */
export function watchKeyboard(win: KeyboardSource, onChange: (open: boolean) => void, textEntryFocused: () => boolean = () => true): () => void {
  const vv = win.visualViewport
  if (!vv) {
    onChange(true)
    return () => undefined
  }
  const baseline = viewportBaseline()
  const update = () => {
    if (vv.scale !== 1) return // pinch-zoomed: keep the last answer
    const baselineHeight = baseline.update(vv.width, vv.height, !textEntryFocused())
    onChange(keyboardOpen({ visualHeight: vv.height, layoutHeight: win.innerHeight, baselineHeight }))
  }
  const onRotate = () => {
    baseline.reset()
  }
  update()
  vv.addEventListener('resize', update)
  win.addEventListener('orientationchange', onRotate)
  return () => {
    vv.removeEventListener('resize', update)
    win.removeEventListener('orientationchange', onRotate)
  }
}

/**
 * How much of the layout viewport's bottom an on-screen keyboard covers, in px: what a `bottom-0` sheet must
 * lift by. iOS ignores interactive-widget=resizes-content and shrinks only the visual viewport (and pans it by
 * offsetTop); Android with resizes-content shrinks innerHeight too, so this is 0 there. Small gaps (the URL bar)
 * and pinch-zoom are not a keyboard. The keyboard's height is what is tested, so a deep pan that leaves less
 * than 150px covered still lifts the sheet.
 */
export function keyboardInset(s: KeyboardGeometryInput): number {
  if (!iosKeyboardUp(s)) return 0
  return Math.max(0, Math.round(s.innerHeight - s.vvHeight - s.vvOffsetTop))
}

/**
 * How far iOS has panned the visible area down the page while its keyboard is up, in px. A sheet's max height
 * takes this off as well as the inset, so a tall sheet's title and ✕ stay inside the visible area.
 */
export function keyboardPan(s: KeyboardGeometryInput): number {
  return iosKeyboardUp(s) ? Math.max(0, Math.round(s.vvOffsetTop)) : 0
}

export interface KeyboardGeometryInput {
  innerHeight: number
  vvHeight: number
  vvOffsetTop: number
  scale: number
}

function iosKeyboardUp(s: KeyboardGeometryInput): boolean {
  return s.scale === 1 && s.innerHeight - s.vvHeight > KEYBOARD_MIN_PX
}

/** Calls onChange with keyboardInset and keyboardPan now and on every visual viewport resize or scroll (iOS pans while the keyboard is up). */
export function watchKeyboardInset(
  win: Pick<KeyboardSource, 'innerHeight' | 'visualViewport'>,
  onChange: (g: { inset: number; pan: number }) => void
): () => void {
  const vv = win.visualViewport
  if (!vv) {
    onChange({ inset: 0, pan: 0 })
    return () => undefined
  }
  const update = () => {
    const s = { innerHeight: win.innerHeight, vvHeight: vv.height, vvOffsetTop: vv.offsetTop, scale: vv.scale }
    onChange({ inset: keyboardInset(s), pan: keyboardPan(s) })
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
  }
}
