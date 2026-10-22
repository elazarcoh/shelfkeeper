import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isTextEntry,
  keyboardInset,
  keyboardOpen,
  keyboardPan,
  shouldHideBottomNav,
  viewportBaseline,
  watchKeyboard,
  watchKeyboardInset,
  watchTextEntryFocus,
  type FocusSource,
  type FocusTarget,
  type KeyboardSource,
  type ViewportSource,
} from './text-entry'

describe('isTextEntry', () => {
  it.each(['text', 'search', 'email', 'password', 'number', 'tel', 'url', undefined])('an <input type=%s> opens a keyboard', (type) => {
    expect(isTextEntry({ tagName: 'INPUT', type })).toBe(true)
  })

  it.each(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image', 'hidden', 'date', 'month', 'time', 'week', 'datetime-local'])(
    'an <input type=%s> does not',
    (type) => {
      expect(isTextEntry({ tagName: 'INPUT', type })).toBe(false)
    },
  )

  it('counts textareas and contenteditable, but not read-only fields', () => {
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTextEntry({ tagName: 'textarea' })).toBe(true)
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTextEntry({ tagName: 'INPUT', type: 'text', readOnly: true })).toBe(false)
    expect(isTextEntry({ tagName: 'TEXTAREA', readOnly: true })).toBe(false)
  })

  it('ignores selects, buttons, switches and nothing focused', () => {
    expect(isTextEntry({ tagName: 'SELECT' })).toBe(false)
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false)
    expect(isTextEntry({ tagName: 'BODY' })).toBe(false)
    expect(isTextEntry(null)).toBe(false)
    expect(isTextEntry(undefined)).toBe(false)
  })
})

describe('shouldHideBottomNav', () => {
  it('hides only while typing on a touch screen', () => {
    expect(shouldHideBottomNav({ textEntryFocused: true, coarsePointer: true, keyboardOpen: true })).toBe(true)
    expect(shouldHideBottomNav({ textEntryFocused: true, coarsePointer: false, keyboardOpen: true })).toBe(false)
    expect(shouldHideBottomNav({ textEntryFocused: false, coarsePointer: true, keyboardOpen: true })).toBe(false)
  })

  it('keeps the bar when no on-screen keyboard is up (iPad hardware keyboard, keyboard dismissed by the back gesture)', () => {
    expect(shouldHideBottomNav({ textEntryFocused: true, coarsePointer: true, keyboardOpen: false })).toBe(false)
  })
})

describe('keyboardOpen', () => {
  it('without visualViewport, assumes a keyboard (the focus check alone decides)', () => {
    expect(keyboardOpen({ visualHeight: undefined, layoutHeight: 844, baselineHeight: 844 })).toBe(true)
  })

  it('is open when the visual viewport is more than 150px shorter than the layout viewport (iOS)', () => {
    expect(keyboardOpen({ visualHeight: 500, layoutHeight: 844, baselineHeight: 844 })).toBe(true)
    expect(keyboardOpen({ visualHeight: 844, layoutHeight: 844, baselineHeight: 844 })).toBe(false)
    // the URL bar collapsing or expanding is not a keyboard
    expect(keyboardOpen({ visualHeight: 788, layoutHeight: 844, baselineHeight: 844 })).toBe(false)
    expect(keyboardOpen({ visualHeight: 694, layoutHeight: 844, baselineHeight: 844 })).toBe(false)
    expect(keyboardOpen({ visualHeight: 693, layoutHeight: 844, baselineHeight: 844 })).toBe(true)
  })

  it('is open when both viewports shrank against the keyboard-free height (Android, interactive-widget=resizes-content)', () => {
    expect(keyboardOpen({ visualHeight: 480, layoutHeight: 480, baselineHeight: 844 })).toBe(true)
    expect(keyboardOpen({ visualHeight: 844, layoutHeight: 844, baselineHeight: 844 })).toBe(false)
  })
})

describe('viewportBaseline (the keyboard-free height)', () => {
  it('remembers the tallest height at this width and starts over when the width changes (rotation)', () => {
    const b = viewportBaseline()
    expect(b.update(390, 844, false)).toBe(844)
    expect(b.update(390, 480, false)).toBe(844) // keyboard up
    expect(b.update(390, 844, false)).toBe(844)
    expect(b.update(844, 390, false)).toBe(390) // landscape
    expect(b.update(844, 200, false)).toBe(390)
    expect(b.update(390, 844, false)).toBe(844) // back to portrait
  })

  it('takes the current height as the new baseline when told nothing is being typed, or after reset()', () => {
    const b = viewportBaseline()
    expect(b.update(390, 844, false)).toBe(844)
    expect(b.update(390, 600, true)).toBe(600)
    expect(b.update(390, 500, false)).toBe(600)
    b.reset()
    expect(b.update(390, 500, false)).toBe(500)
  })
})

/** A stand-in for window + visualViewport: the keyboard opens by shrinking the visual viewport and firing resize. */
class FakeViewport extends EventTarget implements ViewportSource {
  width = 390
  height = 844
  offsetTop = 0
  scale = 1
}
class FakeWindow extends EventTarget implements KeyboardSource {
  innerHeight = 844
  visualViewport: FakeViewport | null
  constructor(withViewport: boolean) {
    super()
    this.visualViewport = withViewport ? new FakeViewport() : null
  }
}

describe('watchKeyboard', () => {
  it('reports the keyboard opening and closing from visualViewport resizes (Android back gesture closes it)', () => {
    const win = new FakeWindow(true)
    const seen: boolean[] = []
    const stop = watchKeyboard(win, (open) => seen.push(open))
    const vv = win.visualViewport
    if (!vv) throw new Error('no viewport')
    vv.height = 480
    win.innerHeight = 480
    vv.dispatchEvent(new Event('resize'))
    vv.height = 844
    win.innerHeight = 844
    vv.dispatchEvent(new Event('resize'))
    expect(seen).toEqual([false, true, false])
    stop()
    vv.height = 400
    vv.dispatchEvent(new Event('resize'))
    expect(seen).toEqual([false, true, false])
  })

  function setupKeyboard(opts: { textFocused: boolean }) {
    const win = new FakeWindow(true)
    const vv = win.visualViewport
    if (!vv) throw new Error('no viewport')
    const state = { textFocused: opts.textFocused }
    const seen: boolean[] = []
    watchKeyboard(win, (open) => seen.push(open), () => state.textFocused)
    const resize = (w: number, h: number, layout = h) => {
      vv.width = w
      vv.height = h
      win.innerHeight = layout
      vv.dispatchEvent(new Event('resize'))
    }
    return { win, vv, state, seen, resize }
  }

  it('takes a new keyboard-free height when the window shrinks with no text field focused (iPad split view)', () => {
    const { state, seen, resize } = setupKeyboard({ textFocused: false })
    resize(390, 600) // the window got shorter, same width, nothing focused: that is the new normal
    state.textFocused = true // hardware keyboard: focusing a field changes nothing
    resize(390, 600)
    expect(seen.at(-1)).toBe(false)
    resize(390, 300) // an on-screen keyboard does come up
    expect(seen.at(-1)).toBe(true)
  })

  it('keeps the keyboard-free height while a text field is focused, so the keyboard reads as open', () => {
    const { seen, resize } = setupKeyboard({ textFocused: true })
    resize(390, 480)
    expect(seen.at(-1)).toBe(true)
  })

  it('starts over on orientationchange (a resize mid-rotation cannot pin a too-tall height)', () => {
    const { win, seen, resize } = setupKeyboard({ textFocused: true })
    resize(844, 844) // mid-rotation: new width, old height
    win.dispatchEvent(new Event('orientationchange'))
    resize(844, 390)
    expect(seen.at(-1)).toBe(false)
  })

  it('ignores the viewport while pinch-zoomed (zoom shrinks visualViewport too)', () => {
    const { vv, seen, resize } = setupKeyboard({ textFocused: true })
    const before = seen.length
    vv.scale = 2
    resize(195, 422, 844)
    expect(seen.length).toBe(before)
    vv.scale = 1
    resize(390, 844)
    expect(seen.at(-1)).toBe(false)
  })

  it('without visualViewport, reports a keyboard once and listens to nothing', () => {
    const seen: boolean[] = []
    watchKeyboard(new FakeWindow(false), (open) => seen.push(open))
    expect(seen).toEqual([true])
  })
})

describe('keyboardInset (how far a bottom sheet must lift above the keyboard)', () => {
  it('is the height the keyboard covers on iOS, which shrinks only the visual viewport', () => {
    expect(keyboardInset({ innerHeight: 667, vvHeight: 367, vvOffsetTop: 0, scale: 1 })).toBe(300)
  })

  it('takes away how far iOS has panned the page up', () => {
    expect(keyboardInset({ innerHeight: 667, vvHeight: 367, vvOffsetTop: 100, scale: 1 })).toBe(200)
  })

  it('is 0 on Android with resizes-content (the layout viewport shrinks too)', () => {
    expect(keyboardInset({ innerHeight: 367, vvHeight: 367, vvOffsetTop: 0, scale: 1 })).toBe(0)
  })

  it('is 0 for a URL bar coming and going', () => {
    expect(keyboardInset({ innerHeight: 667, vvHeight: 600, vvOffsetTop: 0, scale: 1 })).toBe(0)
  })

  it('is 0 while pinch-zoomed', () => {
    expect(keyboardInset({ innerHeight: 667, vvHeight: 333, vvOffsetTop: 0, scale: 2 })).toBe(0)
  })

  it('still lifts when panned so far that less than 150px is covered (the keyboard is what is tested, not the cover)', () => {
    expect(keyboardInset({ innerHeight: 667, vvHeight: 367, vvOffsetTop: 200, scale: 1 })).toBe(100)
  })

  it('never goes negative when panned past the keyboard height', () => {
    expect(keyboardInset({ innerHeight: 667, vvHeight: 367, vvOffsetTop: 400, scale: 1 })).toBe(0)
  })
})

describe('keyboardPan (how far iOS has scrolled the visible area down the page)', () => {
  const room = (s: { innerHeight: number; vvHeight: number; vvOffsetTop: number; scale: number }) => s.innerHeight - keyboardInset(s) - keyboardPan(s)

  it('is the visual viewport offset while a keyboard is up', () => {
    expect(keyboardPan({ innerHeight: 667, vvHeight: 367, vvOffsetTop: 100, scale: 1 })).toBe(100)
  })

  it('is 0 with no keyboard, or pinch-zoomed', () => {
    expect(keyboardPan({ innerHeight: 667, vvHeight: 600, vvOffsetTop: 40, scale: 1 })).toBe(0)
    expect(keyboardPan({ innerHeight: 667, vvHeight: 333, vvOffsetTop: 100, scale: 2 })).toBe(0)
  })

  it('with the inset leaves a sheet exactly the visible height (its title and ✕ stay on screen while panned)', () => {
    for (const vvOffsetTop of [0, 100, 200, 300]) expect(room({ innerHeight: 667, vvHeight: 367, vvOffsetTop, scale: 1 })).toBe(367)
    // panned past the keyboard: the layout bottom is on screen, the visible area above it is what is left
    expect(room({ innerHeight: 667, vvHeight: 367, vvOffsetTop: 400, scale: 1 })).toBe(267)
  })
})

describe('watchKeyboardInset', () => {
  it('reports inset and pan now and on every visualViewport resize and scroll, until stopped', () => {
    const win = new FakeWindow(true)
    win.innerHeight = 667
    const vv = win.visualViewport
    if (!vv) throw new Error('no viewport')
    vv.height = 667
    const seen: { inset: number; pan: number }[] = []
    const stop = watchKeyboardInset(win, (g) => seen.push(g))
    vv.height = 367
    vv.dispatchEvent(new Event('resize'))
    vv.offsetTop = 100
    vv.dispatchEvent(new Event('scroll'))
    vv.height = 667
    vv.offsetTop = 0
    vv.dispatchEvent(new Event('resize'))
    const expected = [
      { inset: 0, pan: 0 },
      { inset: 300, pan: 0 },
      { inset: 200, pan: 100 },
      { inset: 0, pan: 0 },
    ]
    expect(seen).toEqual(expected)
    stop()
    vv.height = 367
    vv.dispatchEvent(new Event('resize'))
    vv.dispatchEvent(new Event('scroll'))
    expect(seen).toEqual(expected)
  })

  it('without visualViewport, reports nothing lifted once', () => {
    const seen: { inset: number; pan: number }[] = []
    watchKeyboardInset(new FakeWindow(false), (g) => seen.push(g))
    expect(seen).toEqual([{ inset: 0, pan: 0 }])
  })
})

/** A stand-in for `document`: focus moves by setting activeElement and firing focusout/focusin, as a browser does. */
class FakeDocument extends EventTarget implements FocusSource {
  activeElement: FocusTarget | null = { tagName: 'BODY' }
  focus(el: FocusTarget | null) {
    this.dispatchEvent(new Event('focusout'))
    this.activeElement = el ?? { tagName: 'BODY' }
    this.dispatchEvent(new Event('focusin'))
  }
}

describe('watchTextEntryFocus (what useHideBottomNav listens to)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup() {
    const doc = new FakeDocument()
    let focused = false
    const { stop, recheck } = watchTextEntryFocus(doc, (f) => {
      focused = f
    })
    const hidden = () => shouldHideBottomNav({ textEntryFocused: focused, coarsePointer: true, keyboardOpen: true })
    return { doc, stop, recheck, hidden }
  }

  it('shows the bar again when the focused field is removed with no focus event (a route change re-checks)', () => {
    const { doc, recheck, hidden } = setup()
    doc.focus({ tagName: 'INPUT', type: 'text' })
    vi.runAllTimers()
    expect(hidden()).toBe(true)
    // submitting Add book with the keyboard's Go navigates away: the input unmounts, focus falls to <body>, no event fires
    doc.activeElement = { tagName: 'BODY' }
    recheck()
    expect(hidden()).toBe(false)
  })

  it('never shows the bar while focus moves from one text field to the next (it passes through <body>)', async () => {
    const doc = new FakeDocument()
    const reported: boolean[] = []
    watchTextEntryFocus(doc, (f) => reported.push(f))
    doc.focus({ tagName: 'INPUT', type: 'text' })
    vi.runAllTimers()
    expect(reported).toEqual([true])
    // the keyboard's Next, or a tap on field B: as the browser dispatches it, A blurs, focus sits on <body>
    // and the microtask checkpoint runs, then B gets focus
    doc.dispatchEvent(new Event('focusout'))
    doc.activeElement = { tagName: 'BODY' }
    await Promise.resolve()
    await Promise.resolve()
    doc.activeElement = { tagName: 'TEXTAREA' }
    doc.dispatchEvent(new Event('focusin'))
    await Promise.resolve()
    vi.runAllTimers()
    expect(reported.every((f) => f)).toBe(true)
  })

  it('a removed field that does fire focusout brings the bar back once focus settles', () => {
    const { doc, hidden } = setup()
    doc.focus({ tagName: 'INPUT', type: 'text' })
    vi.runAllTimers()
    expect(hidden()).toBe(true)
    doc.activeElement = { tagName: 'BODY' }
    doc.dispatchEvent(new Event('focusout'))
    vi.runAllTimers()
    expect(hidden()).toBe(false)
  })

  it('hides the bottom bar when a text field gets focus on a touch screen', () => {
    const { doc, hidden } = setup()
    doc.focus({ tagName: 'INPUT', type: 'text' })
    vi.runAllTimers()
    expect(hidden()).toBe(true)
  })

  it('keeps the bottom bar when a checkbox gets focus', () => {
    const { doc, hidden } = setup()
    doc.focus({ tagName: 'INPUT', type: 'checkbox' })
    vi.runAllTimers()
    expect(hidden()).toBe(false)
  })

  it('brings the bar back when focus moves from a text field to a checkbox or away', () => {
    const { doc, hidden } = setup()
    doc.focus({ tagName: 'TEXTAREA' })
    vi.runAllTimers()
    expect(hidden()).toBe(true)
    doc.focus({ tagName: 'INPUT', type: 'checkbox' })
    vi.runAllTimers()
    expect(hidden()).toBe(false)
    doc.focus({ tagName: 'INPUT', type: 'search' })
    vi.runAllTimers()
    expect(hidden()).toBe(true)
    doc.focus(null)
    vi.runAllTimers()
    expect(hidden()).toBe(false)
  })

  it('stops listening once unsubscribed', () => {
    const { doc, stop, hidden } = setup()
    stop()
    doc.focus({ tagName: 'INPUT', type: 'text' })
    vi.runAllTimers()
    expect(hidden()).toBe(false)
  })
})
