import { Link } from '@tanstack/react-router'
import { Gift, LibraryBig, ListPlus } from 'lucide-react'
import type { LibraryEntry, SeriesGroupCard, WorkCard } from '@mylib/domain'
import { FormatIcon } from '@/components/format-icon'
import { KindBadge } from '@/components/kind-badge'
import { StarRating } from '@/components/star-rating'
import { Badge } from '@/components/ui/badge'
import { WorkCover } from '@/components/work-cover'
import { availabilityLabel, seriesLabel, statusLabel, wishedByLabel } from '@/lib/format'
import { cn } from '@/lib/utils'
import { entryKey, type LibrarySearch } from './library-search'
import { QuickActions, SeriesQuickActions } from './quick-actions/quick-actions'

function Meta({ card, meId, className }: { card: WorkCard; meId: string; className?: string | undefined }) {
  const wished = wishedByLabel(card.wishedBy, meId)
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 text-muted-foreground', className)}>
      {card.formats.map((f) => (
        <FormatIcon key={f} format={f} className="size-3.5" />
      ))}
      {/* a 101px card (three a row at 360px) is narrower than "Read, not owned": the label truncates, not the card */}
      {card.availability !== 'owned' ? (
        <Badge variant="outline" className="max-w-full" title={availabilityLabel[card.availability]}>
          <span className="truncate">{availabilityLabel[card.availability]}</span>
        </Badge>
      ) : null}
      {card.status !== 'none' ? <Badge variant="secondary">{statusLabel[card.status]}</Badge> : null}
      {card.inQueue ? <ListPlus className="size-3.5" aria-label="In Up next" role="img" /> : null}
      {wished !== null ? <Gift className="size-3.5" aria-label={wished} role="img" /> : null}
      {card.rating !== null ? <StarRating value={card.rating} size="sm" /> : null}
    </div>
  )
}

/** A series' covers stacked: the first book in front, up to two behind it, all inside the card's own box. */
function StackedCovers({ group, className }: { group: SeriesGroupCard; className?: string | undefined }) {
  const covers = group.covers.length > 0 ? group.covers : [{ workId: group.id, title: group.name, coverAssetId: null }]
  const step = 8 // % of the box per cover behind
  const width = 100 - step * (covers.length - 1)
  return (
    <div className={cn('relative aspect-[2/3]', className)}>
      {covers.map((c, i) => (
        <div
          key={c.workId}
          className="absolute"
          // logical inset: in a right-to-left page the stack fans the other way, still inside the box
          style={{ insetInlineStart: `${step * i}%`, bottom: `${(step * i * 2) / 3}%`, width: `${width}%`, zIndex: covers.length - i }}
        >
          <WorkCover title={c.title} coverAssetId={c.coverAssetId} label={false} className={cn('w-full', i > 0 && 'ring-1 ring-background brightness-90')} />
        </div>
      ))}
    </div>
  )
}

function seriesCounts(group: SeriesGroupCard): { books: string; read: string | null } {
  return {
    books: `${group.bookCount} ${group.bookCount === 1 ? 'book' : 'books'}`,
    // nothing read yet says nothing: no "0 of 7 read" on every card of a new library
    read: group.readCount > 0 ? `${group.readCount} of ${group.bookCount} read` : null,
  }
}

type SeriesLink = (seriesId: string) => LibrarySearch

function WorkRow({ card, meId }: { card: WorkCard; meId: string }) {
  return (
    <Link to="/books/$workId" params={{ workId: card.id }} className="flex min-w-0 flex-1 items-center gap-3 p-3 hover:bg-muted/50">
      <WorkCover title={card.title} coverAssetId={card.coverAssetId} label={false} className="w-10 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 font-medium">
          <span className="truncate" dir="auto">
            {card.title}
          </span>
          <KindBadge kind={card.kind} compact />
        </p>
        <p className="truncate text-sm text-muted-foreground" dir="auto">
          {card.authors.join(', ')}
          {card.series ? ` · ${seriesLabel(card.series)}` : ''}
        </p>
        <Meta card={card} meId={meId} className="mt-1 sm:hidden" />
      </div>
      <Meta card={card} meId={meId} className="hidden shrink-0 sm:flex" />
    </Link>
  )
}

function SeriesRow({ group, link }: { group: SeriesGroupCard; link: SeriesLink }) {
  const counts = seriesCounts(group)
  return (
    <Link to="/library" search={link(group.id)} className="flex min-w-0 flex-1 items-center gap-3 p-3 hover:bg-muted/50">
      <StackedCovers group={group} className="w-10 shrink-0" />
      <div className="min-w-0 flex-1">
        {/* outside the name's paragraph, so dir="auto" takes its direction from the name alone */}
        <span className="sr-only">Series: </span>
        <p className="truncate font-medium text-match-parent" dir="auto">
          {group.name}
        </p>
        <p className="truncate text-sm text-muted-foreground">
          Series · {counts.books}
          {counts.read !== null ? ` · ${counts.read}` : ''}
        </p>
      </div>
      <LibraryBig className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  )
}

function WorkTile({ card, meId }: { card: WorkCard; meId: string }) {
  return (
    // grid-cols-1 (minmax(0,1fr)): an auto track grows to the meta row's widest badge, past the card's column
    <Link to="/books/$workId" params={{ workId: card.id }} className="group grid grid-cols-1 gap-2">
      <div className="relative">
        <WorkCover title={card.title} coverAssetId={card.coverAssetId} label={false} className="w-full transition group-hover:-translate-y-0.5 group-hover:shadow-md" />
        {/* top-start: the quick-actions ⋯ sits top-end */}
        <KindBadge kind={card.kind} compact className="absolute start-1 top-1" />
      </div>
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm font-medium break-words" dir="auto">
          {card.title}
        </p>
        <p className="truncate text-xs text-muted-foreground" dir="auto">
          {card.authors.join(', ')}
        </p>
        {card.series ? <p className="truncate text-xs text-muted-foreground">{seriesLabel(card.series)}</p> : null}
      </div>
      <Meta card={card} meId={meId} />
    </Link>
  )
}

function SeriesTile({ group, link }: { group: SeriesGroupCard; link: SeriesLink }) {
  const counts = seriesCounts(group)
  return (
    <Link to="/library" search={link(group.id)} className="group grid grid-cols-1 gap-2">
      <StackedCovers group={group} className="w-full transition group-hover:-translate-y-0.5" />
      <div className="min-w-0">
        <span className="sr-only">Series: </span>
        <p className="truncate text-sm font-medium text-match-parent" dir="auto">
          {group.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">{counts.books}</p>
        {counts.read !== null ? <p className="truncate text-xs text-muted-foreground">{counts.read}</p> : null}
      </div>
    </Link>
  )
}

/** The Library's books and (collapsed) series cards; a series card opens the Library inside that series. Book and series cards have quick actions. */
export function WorkList({ items, view, seriesLink, isAdmin, meId }: { items: LibraryEntry[]; view: 'grid' | 'list'; seriesLink: SeriesLink; isAdmin: boolean; meId: string }) {
  if (view === 'list') {
    return (
      <ul aria-label="Books" className="divide-y rounded-lg border">
        {items.map((e) => (
          <li key={entryKey(e)} className="min-w-0">
            {e.kind === 'work' ? (
              <QuickActions card={e.work} isAdmin={isAdmin} layout="row">
                <WorkRow card={e.work} meId={meId} />
              </QuickActions>
            ) : (
              <SeriesQuickActions card={e.series} isAdmin={isAdmin} layout="row">
                <SeriesRow group={e.series} link={seriesLink} />
              </SeriesQuickActions>
            )}
          </li>
        ))}
      </ul>
    )
  }
  return (
    // 6.25rem: three covers a row from a 360px phone (328px of content), two at 320
    <ul aria-label="Books" className="grid grid-cols-[repeat(auto-fill,minmax(6.25rem,1fr))] gap-x-3 gap-y-5 md:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] md:gap-x-4">
      {items.map((e) => (
        <li key={entryKey(e)} className="min-w-0">
          {e.kind === 'work' ? (
            <QuickActions card={e.work} isAdmin={isAdmin} layout="tile">
              <WorkTile card={e.work} meId={meId} />
            </QuickActions>
          ) : (
            <SeriesQuickActions card={e.series} isAdmin={isAdmin} layout="tile">
              <SeriesTile group={e.series} link={seriesLink} />
            </SeriesQuickActions>
          )}
        </li>
      ))}
    </ul>
  )
}
