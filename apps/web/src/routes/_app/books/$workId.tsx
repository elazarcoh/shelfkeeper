import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { EmptyState, PageBody, PageSection, PageSections } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { BookCaptureRouter } from '@/features/book/capture-router'
import { EditionCard } from '@/features/book/edition-card'
import { EDITIONS_HEADING_ID } from '@/features/book/ids'
import { AddEditionDialog } from '@/features/book/edition-dialogs'
import { editionGroups } from '@/features/book/volume-summary'
import type { EditionDetail } from '@/features/book/edition-form-state'
import { MySessions } from '@/features/book/my-sessions'
import { MyTracking } from '@/features/book/my-tracking'
import { SeriesNav } from '@/features/book/series-nav'
import { HardcoverSection } from '@/features/hardcover/hardcover-section'
import { WorkHeader } from '@/features/book/work-header'
import { errorCode, trpc } from '@/lib/trpc'

export const Route = createFileRoute('/_app/books/$workId')({ component: BookPage })

function BookPage() {
  const { workId } = Route.useParams()
  const { user } = Route.useRouteContext()
  const book = useQuery(trpc.catalog.get.queryOptions({ workId }))

  if (book.isPending) {
    return (
      <PageBody width="narrow">
        <Skeleton className="h-64 w-full" />
      </PageBody>
    )
  }
  if (book.isError) {
    const code = errorCode(book.error)
    const missing = code === 'NOT_FOUND' || code === 'BAD_REQUEST'
    return (
      <PageBody width="narrow">
        <EmptyState
          title={missing ? 'Book not found' : 'Something went wrong'}
          hint={missing ? 'It may have been deleted or merged into another book.' : book.error.message}
          action={
            <Button asChild variant="outline">
              <Link to="/library">Go to Library</Link>
            </Button>
          }
        />
      </PageBody>
    )
  }

  const work = book.data
  return (
    <PageBody width="narrow">
      {/* pages the bookmarklet sends back go to the header's or a copy's Fetch metadata */}
      <BookCaptureRouter>
        <PageSections>
          <WorkHeader work={work} isAdmin={user.role === 'admin'} userId={user.id} />
          <MyTracking work={work} user={user} />
          <MySessions work={work} userId={user.id} />
          {work.series.map((s) => (
            <SeriesNav key={s.id} seriesId={s.id} seriesName={s.name} currentWorkId={work.id} />
          ))}
          <HardcoverSection work={work} />
          <PageSection id={EDITIONS_HEADING_ID} title="Editions" actions={<AddEditionDialog workId={work.id} />}>
            <div className="grid grid-cols-1 gap-3">
              {editionGroups(work.editions).map((g) => {
                const card = (e: EditionDetail) => (
                  <EditionCard
                    key={e.id}
                    work={work}
                    edition={e}
                    canSplit={work.editions.length > 1}
                    canDelete={user.role === 'admin' && work.editions.length > 1}
                  />
                )
                if (g.kind === 'single') return card(g.edition)
                return (
                  <div key={g.key} className="grid grid-cols-1 gap-3">
                    <div>
                      <p className="text-sm font-medium" dir="auto">
                        {g.heading}
                      </p>
                      {g.missing !== null && (
                        <p className="text-sm text-muted-foreground" dir="auto">
                          {g.missing}
                        </p>
                      )}
                    </div>
                    {g.editions.map(card)}
                  </div>
                )
              })}
            </div>
          </PageSection>
        </PageSections>
      </BookCaptureRouter>
    </PageBody>
  )
}
