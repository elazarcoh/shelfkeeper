import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PageCapture } from '@mylib/domain'
import { takeTarget } from '@/features/shelf/capture-target'
import { useCapture } from '@/features/shelf/use-capture'

type Handler = (capture: PageCapture) => void
type CaptureKey = 'work' | `edition:${string}`

/** per key, newest last: a dialog opened later (e.g. the Hardcover one) takes the page ahead of the menu's own */
const HandlersContext = createContext<Map<CaptureKey, Handler[]> | null>(null)

/**
 * The book page's one listener for pages the bookmarklet sends back: a copy's own Fetch metadata gets the page it
 * looked up, anything else (the book's lookup, or no remembered target) goes to the book's.
 */
export function BookCaptureRouter({ children }: { children: ReactNode }) {
  const [handlers] = useState(() => new Map<CaptureKey, Handler[]>())
  useCapture((capture) => {
    const target = takeTarget(undefined, undefined, ['work', 'edition'])
    const own: CaptureKey | null = target?.kind === 'edition' ? `edition:${target.id}` : null
    const key = own !== null && handlers.get(own)?.length ? own : 'work'
    handlers.get(key)?.at(-1)?.(capture)
  })
  return <HandlersContext.Provider value={handlers}>{children}</HandlersContext.Provider>
}

/** Receives the pages sent back for `key` (the book, or one copy) while mounted under a BookCaptureRouter. */
export function useBookCapture(key: CaptureKey, onCapture: Handler, enabled = true): void {
  const handlers = useContext(HandlersContext)
  const latest = useRef(onCapture)
  useEffect(() => {
    latest.current = onCapture
  })
  useEffect(() => {
    if (handlers === null || !enabled) return
    const handler: Handler = (capture) => latest.current(capture)
    handlers.set(key, [...(handlers.get(key) ?? []), handler])
    return () => {
      handlers.set(key, (handlers.get(key) ?? []).filter((h) => h !== handler))
    }
  }, [handlers, key, enabled])
}
