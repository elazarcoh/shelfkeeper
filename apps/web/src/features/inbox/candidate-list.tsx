import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

/** The candidate rows of an Inbox card. On phones only the best match shows until "Show N more" is tapped, so a card
 *  stays about one screen tall (#13); from sm every match shows. Children must be the `<li>` rows, best first. */
export function CandidateList({ count, children }: { count: number; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const revealed = useRef(false)
  // the button disappears once tapped: keyboard focus moves to the first match it revealed instead of the page
  useEffect(() => {
    if (!expanded || !revealed.current) return
    revealed.current = false
    listRef.current?.children[1]?.querySelector<HTMLElement>('button, a')?.focus()
  }, [expanded])
  const more = count - 1
  return (
    <>
      {/* phones: dividers between candidates instead of a second level of boxes */}
      <ul ref={listRef} className={`grid grid-cols-1 divide-y sm:gap-2 sm:divide-y-0 ${expanded ? '' : 'max-sm:[&>li:nth-child(n+2)]:hidden'}`}>
        {children}
      </ul>
      {!expanded && more > 0 ? (
        <Button
          size="sm"
          variant="link"
          className="justify-self-start px-0 sm:hidden"
          onClick={() => {
            revealed.current = true
            setExpanded(true)
          }}
        >
          Show {more} more {more === 1 ? 'match' : 'matches'}
        </Button>
      ) : null}
    </>
  )
}
