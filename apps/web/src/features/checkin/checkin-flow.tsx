import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { CheckinSessionCard } from './session-card'
import { NewBookCard } from './new-book-card'

/**
 * One card at a time: resolve each in-progress session, then "started anything new?", then dismiss. Opened by
 * itself, it skips a book checked in on within the last 12 hours; opened by hand (`everything`), it asks about all.
 */
export function CheckinFlow({ onFinished, everything }: { onFinished: () => void; everything: boolean }) {
  const state = useQuery(trpc.sessions.checkinState.queryOptions({ today: todayLocal() }))
  const [resolved, setResolved] = useState<string[]>([])
  const [pastNewBook, setPastNewBook] = useState(false)
  const { mutate: dismiss } = useMutation(trpc.sessions.dismissCheckin.mutationOptions({ onSuccess: onFinished }))

  const skipped = everything ? [] : (state.data?.recentlyCheckedIn ?? [])
  const next = state.data?.inProgress.find((s) => !resolved.includes(s.id) && !skipped.includes(s.id))
  const done = state.data !== undefined && next === undefined && pastNewBook
  // side effect belongs in an effect, not render — otherwise every re-render re-sends the dismissal
  useEffect(() => {
    if (done) dismiss({ today: todayLocal() })
  }, [done, dismiss])

  // a resolved card unmounts with the focused button: focus moves to the next card's title (the last one is
  // "Started anything new?"), so keyboard and screen-reader users are not dropped to the top of the page
  const flowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (resolved.length > 0) flowRef.current?.querySelector<HTMLElement>('[data-checkin-title]')?.focus()
  }, [resolved.length])

  if (!state.data || done) return null

  return (
    <div ref={flowRef} className="grid grid-cols-1">
      {next ? (
        <CheckinSessionCard
          key={next.id}
          sessionId={next.id}
          workId={next.workId}
          title={next.workTitle}
          editionId={next.editionId}
          progress={next.progress}
          mode={next.mode}
          started={next}
          onDone={() => setResolved((ids) => [...ids, next.id])}
        />
      ) : (
        <NewBookCard onDone={() => setPastNewBook(true)} />
      )}
    </div>
  )
}
