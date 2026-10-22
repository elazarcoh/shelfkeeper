import { useRouterState } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useMediaQuery } from '@/lib/use-media-query'
import { isTextEntry, shouldHideBottomNav, watchKeyboard, watchKeyboardInset, watchTextEntryFocus, type TextEntryWatcher } from './text-entry'

/** Also keeps the --keyboard-inset CSS variable on <html> current. True while a keyboard-opening field has focus on a touch screen and the on-screen keyboard is up: the bottom bar steps aside. */
export function useHideBottomNav(): boolean {
  const coarsePointer = useMediaQuery('(pointer: coarse)')
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [textEntryFocused, setTextEntryFocused] = useState(false)
  const [keyboardUp, setKeyboardUp] = useState(true)
  const watcher = useRef<TextEntryWatcher | null>(null)

  useEffect(() => {
    const w = watchTextEntryFocus(document, setTextEntryFocused)
    watcher.current = w
    return () => {
      w.stop()
      watcher.current = null
    }
  }, [])
  // a navigation can unmount the focused field (Add book submitted with the keyboard's Go) without a focus event
  useEffect(() => {
    watcher.current?.recheck()
  }, [pathname])
  useEffect(() => watchKeyboard(window, setKeyboardUp, () => isTextEntry(document.activeElement)), [])
  // iOS lays its keyboard over the page and pans it: bottom sheets lift by the inset and shorten by inset + pan
  // (see dialogSurfaceClass)
  useEffect(() => {
    const root = document.documentElement
    const stop = watchKeyboardInset(window, ({ inset, pan }) => {
      root.style.setProperty('--keyboard-inset', `${String(inset)}px`)
      root.style.setProperty('--keyboard-pan', `${String(pan)}px`)
    })
    return () => {
      stop()
      root.style.removeProperty('--keyboard-inset')
      root.style.removeProperty('--keyboard-pan')
    }
  }, [])

  return shouldHideBottomNav({ textEntryFocused, coarsePointer, keyboardOpen: keyboardUp })
}
