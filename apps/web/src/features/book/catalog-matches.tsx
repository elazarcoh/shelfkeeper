import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { RouterOutputs } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { hiddenOnPhone, moreMatchesCount } from './add-book-rules'

type Candidate = RouterOutputs['library']['search']['items'][number]

/**
 * Under the Title field while typing: books already in the catalog, so you add an edition instead of a duplicate.
 * Each match is two tab stops (the title opens the book, one button adds the edition). Phones show two matches and "Show N more".
 * While a search is running with nothing to show yet, a same-height placeholder keeps the fields below from jumping.
 */
export function CatalogMatches({
  candidates,
  busy,
  loading = false,
  onAddAsEdition,
}: {
  candidates: Candidate[]
  busy: boolean
  loading?: boolean
  onAddAsEdition: (workId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (candidates.length === 0) return loading ? <div aria-hidden className="min-h-28 rounded-md bg-muted/60" /> : null
  const more = moreMatchesCount(candidates.length, expanded)
  return (
    // grid-cols-1 (minmax(0,1fr)) here and on the list: an auto track grows to a long title, so it could not clamp
    <section aria-labelledby="catalog-matches" className="grid grid-cols-1 gap-2 rounded-md bg-muted/60 p-3">
      <h2 id="catalog-matches" className="text-sm font-medium">
        Already in the catalog?
      </h2>
      <ul className="grid grid-cols-1 gap-3">
        {candidates.map((c, i) => (
          <li key={c.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-sm', hiddenOnPhone(i, expanded) && 'max-sm:hidden')}>
            {/* the whole title-and-author block opens the book: a 44px target, and the title gets two lines before it truncates */}
            <Link
              to="/books/$workId"
              params={{ workId: c.id }}
              className="group/match block min-h-11 min-w-0 flex-1 basis-40 content-center rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="line-clamp-2 font-medium break-words underline-offset-2 group-hover/match:underline" dir="auto">
                {c.title}
              </span>
              <span className="block truncate text-muted-foreground" dir="auto">
                {c.authors.join(', ')}
              </span>
            </Link>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onAddAsEdition(c.id)}>
              Add as edition
            </Button>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        // -ms-3: the label lines up with the matches above (the ghost button's padding is invisible)
        <Button type="button" variant="ghost" size="sm" className="-ms-3 justify-self-start sm:hidden" onClick={() => setExpanded(true)}>
          Show {more} more
        </Button>
      ) : null}
    </section>
  )
}
