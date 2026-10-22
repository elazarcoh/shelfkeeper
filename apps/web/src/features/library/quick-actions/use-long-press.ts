import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { createLongPress } from './long-press'

/**
 * Handlers for an element that opens something on a touch long-press. Only mounted under a coarse pointer: its
 * contextmenu is always prevented (no Android menu, no iOS link preview); the element also needs
 * `[-webkit-touch-callout:none]` and `select-none`.
 */
export function useLongPress(onLongPress: () => void) {
  const latest = useRef(onLongPress)
  useEffect(() => {
    latest.current = onLongPress
  })
  const [tracker] = useState(() => createLongPress(() => latest.current()))
  useEffect(() => () => tracker.dispose(), [tracker])
  return {
    onPointerDown: (e: PointerEvent) => tracker.down(e),
    onPointerMove: (e: PointerEvent) => tracker.move(e),
    onPointerUp: () => tracker.end(),
    onPointerCancel: () => tracker.end(),
    // the click a long-press leaves behind would open the book under the sheet
    onClickCapture: (e: MouseEvent) => {
      if (tracker.takeClick()) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    onContextMenu: (e: MouseEvent) => e.preventDefault(),
  }
}
