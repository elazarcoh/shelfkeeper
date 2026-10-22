import { useEffect, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { LoadMore } from '@/components/load-more'
import { EmptyState, PageBody, PageHeader, PageSection, PageSections } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MyProposalCard } from '@/features/inbox/my-proposal-card'
import { ProposalCard } from '@/features/inbox/proposal-card'
import { takeTarget } from '@/features/shelf/capture-target'
import { useCapture } from '@/features/shelf/use-capture'
import { bulkCreateSummary, drain, sumCounts, withRemainingNote } from '@/features/inbox/resolution'
import { todayLocal } from '@/lib/format'
import { nextLimit } from '@/lib/infinite'
import { usePageStickyBarHeight } from '@/lib/sticky-bar'
import { trpc, trpcClient } from '@/lib/trpc'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidParam = (v: unknown): string | undefined => (typeof v === 'string' && UUID.test(v) ? v : undefined)

/** `batch`: only that shelf batch's (or CSV file's) books; `item`: scroll to that book and mark it. */
export type InboxSearch = { batch?: string; item?: string }

export const Route = createFileRoute('/_app/inbox')({
  validateSearch: (raw: Record<string, unknown>): InboxSearch => {
    const batch = uuidParam(raw['batch'])
    const item = uuidParam(raw['item'])
    return { ...(batch === undefined ? {} : { batch }), ...(item === undefined ? {} : { item }) }
  },
  component: InboxPage,
})

/** The bulk actions stay under the top bar while the cards scroll (below lg); from lg they sit in the flow.
 *  data-sticky-bar + usePageStickyBarHeight: scroll-padding-top leaves room for them (index.css). */
/** Cards per load: each list asks for this many more as it scrolls to its end (#49). */
const STEP = 50

const BULK_BAR =
  'sticky top-(--top-offset) z-page-sticky -mx-4 flex flex-wrap gap-2 bg-background/95 px-4 py-2 backdrop-blur md:-mx-6 md:px-6 lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:py-0 lg:backdrop-blur-none'

function InboxPage() {
  const { user } = Route.useRouteContext()
  const { batch, item } = Route.useSearch()
  const isAdmin = user.role === 'admin'
  const queryClient = useQueryClient()
  // a growing limit, not pages: a resolved card leaves the list, and an offset would skip the one that moved up
  const [sourcesLimit, setSourcesLimit] = useState(STEP)
  const [mineLimit, setMineLimit] = useState(STEP)
  const inbox = useQuery({ ...trpc.inbox.list.queryOptions({ limit: sourcesLimit }), enabled: isAdmin, placeholderData: keepPreviousData })
  const mine = useQuery({ ...trpc.inbox.mine.queryOptions({ sourceId: batch ?? null, limit: mineLimit }), placeholderData: keepPreviousData })
  const refresh = () => {
    for (const key of [trpc.inbox.pathKey(), trpc.library.pathKey(), trpc.catalog.pathKey(), trpc.sessions.pathKey(), trpc.stats.pathKey()]) void queryClient.invalidateQueries({ queryKey: key })
  }
  const acceptExact = useMutation({
    mutationFn: () => drain(() => trpcClient.inbox.acceptExact.mutate(), (r) => r.accepted > 0),
    onSuccess: (rounds) => {
      refresh()
      const accepted = rounds.reduce((n, r) => n + r.accepted, 0)
      const remaining = rounds.at(-1)?.remaining ?? 0
      toast.success(withRemainingNote(`Linked ${accepted} exact ${accepted === 1 ? 'match' : 'matches'}`, remaining))
    },
    onError: refresh,
  })
  const createUnmatched = useMutation({
    mutationFn: () => drain(() => trpcClient.inbox.createUnmatched.mutate(), (r) => r.created + r.linked + r.wanted > 0),
    onSuccess: (rounds) => {
      refresh()
      const remaining = rounds.at(-1)?.remaining ?? 0
      toast.success(withRemainingNote(bulkCreateSummary(sumCounts(rounds)), remaining))
    },
    onError: refresh,
  })
  // my imports: the holding history is dated by my own day, taken when I click (never at render)
  const acceptMineExact = useMutation({
    mutationFn: () => {
      const today = todayLocal()
      return drain(() => trpcClient.inbox.acceptMineExact.mutate({ today }), (r) => r.accepted > 0)
    },
    onSuccess: (rounds) => {
      refresh()
      const accepted = rounds.reduce((n, r) => n + r.accepted, 0)
      toast.success(withRemainingNote(`Filed ${accepted} exact ${accepted === 1 ? 'match' : 'matches'}`, rounds.at(-1)?.remaining ?? 0))
    },
    onError: refresh,
  })
  const createMineUnmatched = useMutation({
    mutationFn: () => {
      const today = todayLocal()
      return drain(() => trpcClient.inbox.createMineUnmatched.mutate({ today }), (r) => r.created > 0)
    },
    onSuccess: (rounds) => {
      refresh()
      const created = rounds.reduce((n, r) => n + r.created, 0)
      const skipped = rounds.reduce((n, r) => n + r.skipped, 0)
      const message = `Added ${created} ${created === 1 ? 'book' : 'books'}${skipped > 0 ? `, skipped ${skipped}` : ''}`
      toast.success(withRemainingNote(message, rounds.at(-1)?.remaining ?? 0))
    },
    onError: refresh,
  })
  // a page sent back by the bookmarklet belongs to the book whose Find was tapped last
  const attach = useMutation(
    trpc.shelf.attachPage.mutationOptions({
      onSuccess: (r, variables) => {
        toast.success(<span dir="auto">Linked: {r.title}</span>)
        document.getElementById(`mine-${variables.proposalId}`)?.scrollIntoView({ block: 'center' })
      },
      onSettled: () => void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() }),
    }),
  )
  useCapture((capture) => {
    const target = takeTarget(undefined, undefined, ['proposal'])
    if (target?.kind === 'proposal') attach.mutate({ proposalId: target.id, capture })
    else toast('Tap Find on Simania on a book first, then send the page')
  })
  // "Nothing to review" only once every list this person sees has actually loaded (a member's `list`
  // query is disabled, so it never settles and is left out)
  const loading = mine.isPending || (isAdmin && inbox.isPending)
  const loadError = mine.error ?? (isAdmin ? inbox.error : null)
  const mineExact = mine.data?.exactMatches ?? 0
  const mineUnmatched = mine.data?.unmatched ?? 0
  const items = inbox.data?.items ?? []
  const total = inbox.data?.total ?? 0
  // computed on the server across every pending item, not just this page (F2)
  const exact = inbox.data?.exactMatches ?? 0
  const unmatched = inbox.data?.unmatched ?? 0
  const batches = mine.data?.shelfBatches ?? []
  const shownBatch = batch === undefined ? null : (batches.find((b) => b.sourceId === batch) ?? null)
  const mineCount = mine.data?.items.length ?? 0
  // the bulk actions act on every import, so they stay out of a one-batch view
  const mineBar = batch === undefined && mineCount > 0 && (mineExact > 0 || mineUnmatched > 0)
  // the next limit while the list has more (null when it came back short, or while the larger one loads)
  const mineMore = mine.data === undefined || mine.isPlaceholderData ? null : nextLimit(mineCount, mineLimit, STEP)
  const sourcesMore = inbox.data === undefined || inbox.isPlaceholderData ? null : nextLimit(items.length, sourcesLimit, STEP)
  const focused = item !== undefined && (mine.data?.items.some((e) => e.id === item) ?? false)
  useEffect(() => {
    if (focused) document.getElementById(`mine-${item}`)?.scrollIntoView({ block: 'center' })
  }, [focused, item])
  // a link to a book further down than the first load: keep loading until it is in the list
  useEffect(() => {
    if (item !== undefined && !focused && mineMore !== null) setMineLimit(mineMore)
  }, [item, focused, mineMore])
  const sourcesBar = isAdmin && (exact > 0 || unmatched > 0)
  // a focused card scrolls clear of the bulk bars too, however tall their wrapped buttons make them
  usePageStickyBarHeight(`${String(mineBar)}-${String(sourcesBar)}`)

  return (
    <PageBody>
      <PageHeader title="Inbox" description="Suggestions waiting for your decision." />
      <PageSections>
        {batch !== undefined && !mine.isPending ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted px-3 py-2 text-sm">
            <span className="min-w-0 wrap-anywhere">
              {shownBatch !== null ? (
                <>
                  Only <bdi className="font-medium">{shownBatch.label}</bdi> · {shownBatch.linked} of {shownBatch.total} linked
                </>
              ) : (
                'Nothing left from this batch'
              )}
            </span>
            <Link to="/inbox" className="font-medium underline underline-offset-2">
              Show all
            </Link>
          </div>
        ) : null}
        {batch === undefined && batches.length > 0 ? (
          <ul aria-label="Shelf batches" className="grid gap-1 text-sm">
            {batches.map((b) => (
              <li key={b.sourceId} className="flex min-w-0 flex-wrap items-center gap-x-3">
                <bdi className="min-w-0 wrap-anywhere">{b.label}</bdi>
                <span className="text-muted-foreground">
                  {b.linked} of {b.total} linked
                </span>
                <Link to="/inbox" search={{ batch: b.sourceId }} className="underline underline-offset-2">
                  Show only these
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {mineCount > 0 ? (
          <PageSection id="inbox-mine" title={`Your imports${mine.data && batch === undefined && mine.data.total > mineCount ? ` (showing ${mineCount} of ${mine.data.total})` : ''}`}>
            <div className="grid gap-4">
              {mineBar ? (
                <div data-sticky-bar className={BULK_BAR}>
                  {mineExact > 0 ? (
                    <Button disabled={acceptMineExact.isPending} onClick={() => acceptMineExact.mutate()}>
                      Accept all exact matches ({mineExact})
                    </Button>
                  ) : null}
                  {mineUnmatched > 0 ? (
                    <Button variant="outline" disabled={createMineUnmatched.isPending} onClick={() => createMineUnmatched.mutate()}>
                      Create books for all unmatched ({mineUnmatched})
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {mine.data?.items.map((entry) => (
                <MyProposalCard key={entry.id} entry={entry} highlight={entry.id === item} />
              ))}
            </div>
            {mineMore !== null || mine.isPlaceholderData ? (
              <LoadMore loading={mine.isPlaceholderData} failed={false} onMore={() => {
                  if (mineMore !== null) setMineLimit(mineMore)
                }} />
            ) : null}
          </PageSection>
        ) : null}
        {isAdmin ? (
          <PageSection id="inbox-sources" title="From your sources">
            <div className="grid gap-4">
              {sourcesBar ? (
                <div data-sticky-bar className={BULK_BAR}>
                  {exact > 0 ? (
                    <Button disabled={acceptExact.isPending} onClick={() => acceptExact.mutate()}>
                      Accept all exact matches ({exact})
                    </Button>
                  ) : null}
                  {unmatched > 0 ? (
                    <Button variant="outline" disabled={createUnmatched.isPending} onClick={() => createUnmatched.mutate()}>
                      Create books for all unmatched ({unmatched})
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {total > items.length ? (
                <p className="text-sm text-muted-foreground">
                  Showing {items.length} of {total}
                </p>
              ) : null}
              {items.map((entry) => (
                <ProposalCard key={entry.id} entry={entry} />
              ))}
            </div>
            {sourcesMore !== null || inbox.isPlaceholderData ? (
              <LoadMore loading={inbox.isPlaceholderData} failed={false} onMore={() => {
                  if (sourcesMore !== null) setSourcesLimit(sourcesMore)
                }} />
            ) : null}
          </PageSection>
        ) : null}
        {loading ? <Skeleton className="h-40 w-full" /> : null}
        {loadError !== null ? (
          <p role="alert" className="text-sm text-destructive" dir="auto">
            Could not load the Inbox: {loadError.message} — reload the page to try again
          </p>
        ) : null}
        {!loading && loadError === null && batch === undefined && mineCount === 0 && (!isAdmin || items.length === 0) ? (
          <EmptyState
            title="Nothing to review"
            hint={isAdmin ? 'New books from your sources and your CSV imports show up here.' : 'Books from your CSV imports show up here.'}
            action={
              <>
                <Button asChild variant="outline">
                  <Link to="/books/import">Import a CSV file</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link to="/books/shelf">From a shelf photo</Link>
                </Button>
              </>
            }
          />
        ) : null}
      </PageSections>
    </PageBody>
  )
}
