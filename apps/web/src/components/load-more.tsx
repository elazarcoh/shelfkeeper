import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'

/**
 * The end of an infinite list: loads more by itself as it scrolls near the screen, and is a "Show more" button for
 * keyboards, screen readers and browsers without IntersectionObserver. After a failed load it waits for a tap.
 */
export function LoadMore({ loading, failed, onMore, label = 'Show more' }: { loading: boolean; failed: boolean; onMore: () => void; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null)
  const more = useRef(onMore)
  useEffect(() => {
    more.current = onMore
  })

  // re-observed after each load: a short page leaves the button on screen, and a new observer reports it at once
  useEffect(() => {
    const el = ref.current
    if (el === null || loading || failed || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more.current()
    }, { rootMargin: '0px 0px 600px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [loading, failed])

  return (
    <div className="mt-6 flex flex-col items-center gap-2 text-sm">
      {failed ? (
        <p role="alert" className="text-destructive">
          Couldn’t load more
        </p>
      ) : null}
      <Button ref={ref} type="button" variant="outline" size="sm" disabled={loading} onClick={() => onMore()}>
        {loading ? 'Loading…' : failed ? 'Try again' : label}
      </Button>
    </div>
  )
}
