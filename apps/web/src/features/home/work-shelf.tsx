import { Link } from '@tanstack/react-router'
import type { WorkCard } from '@mylib/domain'
import { WorkCover } from '@/components/work-cover'
import { ProgressBar } from '@/features/progress/progress-bar'

/**
 * A row of covers that scrolls sideways and snaps, bleeding to the page edge (matches PageBody's 16/24/32px padding).
 * `progress` (work id → latest fraction) puts a thin bar under a book that has progress points. It is given only when
 * the reader has a current point (shelfProgress): without it the cards are exactly as before progress existed.
 */
export function WorkShelf({ items, label, progress }: { items: WorkCard[]; label: string; progress?: ReadonlyMap<string, number> | undefined }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="-mx-4 -mt-1 snap-x snap-mandatory scroll-px-4 overflow-x-auto px-4 pt-1 pb-2 [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:-mx-6 md:scroll-px-6 md:px-6 lg:-mx-8 lg:scroll-px-8 lg:px-8"
    >
    <ul role="list" className="flex gap-3">
      {items.map((card) => (
        <li key={card.id} role="listitem" className="w-28 shrink-0 snap-start md:w-32">
          <Link to="/books/$workId" params={{ workId: card.id }} className="group grid gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <WorkCover title={card.title} coverAssetId={card.coverAssetId} label={false} className="w-full transition group-hover:-translate-y-0.5 group-hover:shadow-md" />
            <span className="grid min-w-0 gap-0.5">
              <span className="line-clamp-2 text-sm leading-snug font-medium break-words" dir="auto">
                {card.title}
              </span>
              <span className="truncate text-xs text-muted-foreground" dir="auto">
                {card.authors.join(', ')}
              </span>
            </span>
          </Link>
          {progress?.get(card.id) !== undefined ? (
            <ProgressBar fraction={progress.get(card.id) ?? 0} label={`Progress in ${card.title}`} className="mt-1.5" />
          ) : progress !== undefined ? (
            // a reader who uses progress: the row stays reserved under books without a point, so the shelf's cards line up
            <div aria-hidden="true" className="mt-1.5 h-1.5" />
          ) : null}
        </li>
      ))}
    </ul>
    </div>
  )
}
