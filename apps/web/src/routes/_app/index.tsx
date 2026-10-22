import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { EmptyState, PageBody, PageHeader, PageSection, PageSections } from '@/components/page'
import { Button } from '@/components/ui/button'
import { CheckinFlow } from '@/features/checkin/checkin-flow'
import { type CheckinFlowState, checkinRequest, parseHomeSearch } from '@/features/home/checkin-request'
import { ActivityFeed } from '@/features/home/activity-feed'
import { GoalProgress } from '@/features/home/goal-progress'
import { UP_NEXT_HEADING_ID } from '@/features/home/ids'
import { QueueList } from '@/features/home/queue-list'
import { SeriesContinuations } from '@/features/home/series-continuations'
import { shelfProgress } from '@/features/home/shelf-progress'
import { WorkShelf } from '@/features/home/work-shelf'
import { todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'

export const Route = createFileRoute('/_app/')({ validateSearch: parseHomeSearch, component: HomePage })

function InboxNotice({ isAdmin }: { isAdmin: boolean }) {
  const count = useQuery({ ...trpc.inbox.count.queryOptions(), enabled: isAdmin })
  if (!isAdmin || !count.data) return null
  return (
    <Link to="/inbox" className="rounded-lg border p-4 text-sm hover:bg-muted">
      {count.data} {count.data === 1 ? 'book' : 'books'} waiting in your Inbox
    </Link>
  )
}

function CheckinGate() {
  // 'auto' opened by itself, 'manual' by the button; once open it stays open until finished, even when a point saved
  // in the flow makes the refetched state no longer due (#45: that book was just checked in on)
  const [flow, setFlow] = useState<CheckinFlowState>('closed')
  const state = useQuery(trpc.sessions.checkinState.queryOptions({ today: todayLocal() }))
  const queryClient = useQueryClient()
  const { checkin } = Route.useSearch()
  const navigate = Route.useNavigate()
  const ready = state.data !== undefined
  // ?checkin=true (from the command palette) opens the manual flow, then drops the param so Back or a reload doesn't
  useEffect(() => {
    if (checkin !== true || !ready) return
    setFlow(checkinRequest)
    void navigate({ search: {}, replace: true })
  }, [checkin, ready, navigate])
  if (!state.data) return null
  if (flow === 'closed' && state.data.dueToday && checkin !== true) setFlow('auto')

  if (flow === 'closed' || flow === 'finished') {
    return (
      <Button variant="outline" size="sm" onClick={() => setFlow('manual')}>
        Check in
      </Button>
    )
  }
  return (
    <CheckinFlow
      everything={flow === 'manual'}
      onFinished={() => {
        setFlow('finished')
        void queryClient.invalidateQueries({ queryKey: trpc.sessions.pathKey() })
      }}
    />
  )
}

function HomePage() {
  const { user } = Route.useRouteContext()
  const reading = useQuery(trpc.library.list.queryOptions({ filter: { op: 'status', statuses: ['reading'] }, limit: 12 }))
  const queue = useQuery(trpc.library.queue.queryOptions())
  const recent = useQuery(trpc.library.list.queryOptions({ scope: 'catalog', sort: 'added', limit: 12 }))
  const goals = useQuery(trpc.goals.mine.queryOptions())
  const continuations = useQuery(trpc.series.continuations.queryOptions())
  const activity = useQuery(trpc.activity.feed.queryOptions())
  // the latest fraction per book being read: a thin bar under its cover when progress points exist
  const current = useQuery(trpc.progress.current.queryOptions())

  return (
    <PageBody>
      <PageHeader title={`Hi, ${user.displayName}`} description="Your reading at a glance." />
      <PageSections>
        <CheckinGate />
        <InboxNotice isAdmin={user.role === 'admin'} />
        <PageSection id="home-reading" title="Currently reading">
          {reading.data && reading.data.items.length > 0 ? (
            <WorkShelf items={reading.data.items} label="Currently reading" progress={shelfProgress(current.data)} />
          ) : (
            <EmptyState title="Nothing in progress" hint='Check in or set a book to "Reading" from its page.' />
          )}
        </PageSection>
        {goals.data && goals.data.length > 0 ? (
          <PageSection id="home-goals" title="Goal progress">
            <GoalProgress goals={goals.data} />
          </PageSection>
        ) : null}
        <PageSection
          id={UP_NEXT_HEADING_ID}
          title="Up next"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to="/next">What next?</Link>
            </Button>
          }
        >
          {queue.data && queue.data.length > 0 ? (
            <QueueList items={queue.data} />
          ) : (
            <EmptyState title="Your Up next list is empty" hint='Use "Add to Up next" on any book.' />
          )}
        </PageSection>
        {continuations.data && continuations.data.length > 0 ? (
          <PageSection id="home-series" title="Series continuations">
            <SeriesContinuations items={continuations.data} />
          </PageSection>
        ) : null}
        {activity.data && activity.data.length > 0 ? (
          <PageSection id="home-activity" title="Household activity">
            <ActivityFeed items={activity.data} />
          </PageSection>
        ) : null}
        <PageSection id="home-recent" title="Recently added">
          {recent.data && recent.data.items.length > 0 ? (
            <WorkShelf items={recent.data.items} label="Recently added" />
          ) : (
            <EmptyState title="The catalog is empty" hint="Add your first book with “Add book”." />
          )}
        </PageSection>
      </PageSections>
    </PageBody>
  )
}
