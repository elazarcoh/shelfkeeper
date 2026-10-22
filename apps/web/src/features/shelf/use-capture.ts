import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { PageCapture, providerForOrigin } from '@mylib/domain'
import { captureFromHash, rememberReceived, wasJustReceived } from './capture-target'

/**
 * A book page sent back by the bookmarklet: a `message` from the Simania window that opened this one, or `#capture=…`
 * in the address when that window is gone. The hash is read once on load and cleared, so a reload does not repeat it;
 * a hash for a page that just came by message (the answer reached the bookmarklet late) is not applied twice.
 */
export function useCapture(onCapture: (capture: PageCapture) => void): void {
  const latest = useRef(onCapture)
  useEffect(() => {
    latest.current = onCapture
  })
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: unknown; v?: unknown; capture?: unknown } | null
      if (data?.type !== 'my-library/capture' || data.v !== 1 || providerForOrigin(event.origin) === null) return
      const parsed = PageCapture.safeParse(data.capture)
      if (!parsed.success) {
        toast.error("That page couldn't be read")
        return
      }
      // tells the bookmarklet it can close; without this it falls back to the #capture= address
      const sender = event.source as Window | null
      sender?.postMessage({ type: 'my-library/ack' }, event.origin)
      rememberReceived(parsed.data.url)
      latest.current(parsed.data)
    }
    window.addEventListener('message', onMessage)
    const fromHash = captureFromHash(window.location.hash)
    if (window.location.hash !== '') history.replaceState(history.state, '', window.location.pathname + window.location.search)
    // the answer reached the bookmarklet too late: the other tab already has this page
    if (fromHash !== null && wasJustReceived(fromHash.url)) toast.info('Already sent to My Library — you can close this tab')
    else if (fromHash !== null) latest.current(fromHash)
    return () => window.removeEventListener('message', onMessage)
  }, [])
}
