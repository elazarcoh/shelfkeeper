import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isPaletteShortcut, shouldTogglePalette } from './palette-shortcut'

interface PaletteState {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  /** bumps on every opening: the palette starts fresh each time */
  openCount: number
  /** the field that was focused when the palette opened, if still in the page; null once a navigation took over */
  returnFocus: { readonly current: HTMLElement | null }
  /** the close is a navigation: the new page owns focus, so don't restore it */
  dropReturnFocus: () => void
}

const PaletteContext = createContext<PaletteState | null>(null)

/** Another modal (check-in, merge, a confirm) is open: the palette's own dialog carries data-palette. */
function otherDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]:not([data-palette]), [role="alertdialog"][data-state="open"]') !== null
}

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false)
  const [openCount, setOpenCount] = useState(0)
  // a ref, not an updater with a side effect: StrictMode may run updaters twice and double-count
  const openRef = useRef(false)
  const opener = useRef<HTMLElement | null>(null)
  const returnFocus = useMemo(
    () => ({
      get current() {
        return opener.current?.isConnected === true ? opener.current : null
      },
    }),
    [],
  )
  const dropReturnFocus = useCallback(() => {
    opener.current = null
  }, [])
  const setOpen = useCallback((next: boolean) => {
    if (next && !openRef.current) {
      setOpenCount((n) => n + 1)
      // Radix has no Trigger to give focus back to, so remember the opener ourselves
      const active = document.activeElement
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null
    }
    openRef.current = next
    setOpenState(next)
  }, [])
  const toggle = useCallback(() => setOpen(!open), [open, setOpen])

  useEffect(() => {
    // capture: runs before inputs and Radix handlers, so Ctrl-K works inside a text field too
    function onKey(e: KeyboardEvent) {
      if (!isPaletteShortcut(e) || !shouldTogglePalette(open, otherDialogOpen())) return
      e.preventDefault()
      setOpen(!open)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen])

  const value = useMemo(() => ({ open, setOpen, toggle, openCount, returnFocus, dropReturnFocus }), [open, setOpen, toggle, openCount, returnFocus, dropReturnFocus])
  return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>
}

export function usePalette(): PaletteState {
  const ctx = useContext(PaletteContext)
  if (ctx === null) throw new Error('usePalette outside PaletteProvider')
  return ctx
}
