import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Fragment, useRef, useState } from 'react'
import { wishVolumes, wishVolumesLabel } from '@mylib/domain'
import { KindBadge } from '@/components/kind-badge'
import { Badge } from '@/components/ui/badge'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { WorkCover } from '@/components/work-cover'
import { WishDialog } from '@/features/wishlist/wish-dialog'
import { availabilityLabel, bookLanguages, seriesLabel, wishedByLabel } from '@/lib/format'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { BookMoreMenu } from './book-more-menu'
import { EditWorkDialog } from './edit-work-dialog'
import { FetchMetadataDialog } from './fetch-metadata-dialog'
import { WORK_TITLE_ID } from './ids'

export function WorkHeader({ work, isAdmin, userId }: { work: RouterOutputs['catalog']['get']; isAdmin: boolean; userId: string }) {
  // the same query the wish dialog reads: one request
  const wishes = useQuery(trpc.wishlist.forWork.queryOptions({ workId: work.id }))
  const wished = wishedByLabel(wishes.data ?? [], userId)
  const myWish = wishes.data?.find((w) => w.userId === userId) ?? wishes.data?.[0]
  const wishVols = myWish === undefined ? null : wishVolumes(myWish.fields, work.editions)
  // the same query the Hardcover section reads: one request
  const hardcover = useQuery(trpc.hardcover.forWork.queryOptions({ workId: work.id }))
  const moreRef = useRef<HTMLButtonElement>(null)
  const [finding, setFinding] = useState(false)
  const meta = [work.originalYear === null ? null : String(work.originalYear), bookLanguages(work.editions)].filter((v) => v !== null)

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex items-start gap-4 sm:gap-6">
        <WorkCover title={work.title} coverAssetId={work.coverAssetId} className="w-24 shrink-0 text-xs sm:w-32 md:w-40" />
        {/* grid-cols-1 (minmax(0,1fr)): an auto track would grow to a long name's min-content width */}
        <div className="grid min-w-0 flex-1 grid-cols-1 content-start gap-2">
          {/* focusable (tabIndex -1): after "Split into new book", focus lands on the new book's title */}
          <h1 id={WORK_TITLE_ID} tabIndex={-1} className="text-2xl font-semibold tracking-tight break-words text-match-parent rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:text-3xl" dir="auto">
            {work.title}
          </h1>
          {work.subtitle !== null ? (
            <p className="text-base text-muted-foreground break-words text-match-parent sm:text-lg" dir="auto">
              {work.subtitle}
            </p>
          ) : null}
          <p dir="auto" className="min-w-0 break-words text-match-parent">
            by{' '}
            {work.authors.map((a, i) => (
              <Fragment key={a.id}>
                {i > 0 ? ', ' : ''}
                <Link to="/library" search={{ scope: 'catalog', authorIds: [a.id] }} className="underline-offset-4 hover:underline">
                  {a.name}
                </Link>
              </Fragment>
            ))}
          </p>
          {/* coarse pointers: each chip link gets a 44px hit area (touch-hit), the rows spaced so neighbours barely overlap */}
          <div className="flex flex-wrap gap-2 pointer-coarse:gap-y-3">
            <KindBadge kind={work.kind} />
            {work.availability !== 'owned' ? <Badge variant="secondary">{availabilityLabel[work.availability]}</Badge> : null}
            {/* a long series or tag name truncates (full name in the tooltip) instead of widening the narrow column */}
            {work.series.map((s) => (
              <Link
                key={s.id}
                to="/library"
                search={{ scope: 'catalog', seriesIds: [s.id] }}
                className="max-w-full min-w-0 pointer-coarse:touch-hit"
                title={seriesLabel(s)}
              >
                <Badge className="max-w-full">
                  <span className="min-w-0 truncate" dir="auto">
                    {seriesLabel(s)}
                  </span>
                </Badge>
              </Link>
            ))}
            {work.tags.map((t) => (
              <Link key={t.id} to="/library" search={{ scope: 'catalog', tagIds: [t.id] }} className="max-w-full min-w-0 pointer-coarse:touch-hit" title={t.name}>
                <Badge variant="outline" className="max-w-full">
                  <span className="min-w-0 truncate" dir="auto">
                    {t.name}
                  </span>
                </Badge>
              </Link>
            ))}
          </div>
          {wished !== null ? (
            <p className="text-sm text-muted-foreground break-words text-match-parent" dir="auto">
              {wished}
            </p>
          ) : null}
          {wishVols !== null ? (
            <p className="text-sm text-muted-foreground break-words text-match-parent" dir="auto">
              {wishVolumesLabel(wishVols)}
            </p>
          ) : null}
          {meta.length > 0 ? <p className="text-sm text-muted-foreground">{meta.join(' · ')}</p> : null}
        </div>
      </div>
      {work.description !== null ? (
        <p className="max-w-prose text-sm leading-relaxed break-words whitespace-pre-line" dir="auto">
          {work.description}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <EditWorkDialog work={work} />
        <WishDialog workId={work.id} title={work.title} userId={userId} />
        <BookMoreMenu
          triggerRef={moreRef}
          work={work}
          isAdmin={isAdmin}
          extraItems={hardcover.data?.enabled ? <DropdownMenuItem onSelect={() => setFinding(true)}>Find on Hardcover…</DropdownMenuItem> : null}
        />
        {hardcover.data?.enabled ? (
          <FetchMetadataDialog work={work} initialSource="hardcover" open={finding} onOpenChange={setFinding} returnFocusRef={moreRef} />
        ) : null}
      </div>
    </div>
  )
}
