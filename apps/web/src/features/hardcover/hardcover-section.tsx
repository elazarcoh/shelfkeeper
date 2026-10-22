import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { PageSection } from '@/components/page'
import { FetchMetadataDialog } from '@/features/book/fetch-metadata-dialog'
import { Button } from '@/components/ui/button'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { ratingLine } from './status-line'

const PHONE_SHOWN = 3

export function HardcoverSection({ work }: { work: RouterOutputs['catalog']['get'] }) {
  const data = useQuery(trpc.hardcover.forWork.queryOptions({ workId: work.id }))
  const [finding, setFinding] = useState(false)
  const [all, setAll] = useState(false)
  const findRef = useRef<HTMLButtonElement>(null)
  if (!data.data?.enabled) return null
  const view = data.data.view
  const matched = view !== null && view.match !== 'none' && view.match !== 'rejected'
  const dialog = <FetchMetadataDialog work={work} initialSource="hardcover" open={finding} onOpenChange={setFinding} returnFocusRef={findRef} />
  if (!matched) {
    return (
      <PageSection id="hardcover" title="Hardcover">
        <p className="text-sm text-muted-foreground">
          {view === null ? 'Not checked yet' : 'Not on Hardcover'} ·{' '}
          <Button ref={findRef} variant="link" className="h-auto p-0" onClick={() => setFinding(true)}>
            Find it…
          </Button>
        </p>
        {dialog}
      </PageSection>
    )
  }
  const rating = ratingLine(view.rating, view.ratingsCount)
  const tags = [...view.tags.genre.slice(0, 2), ...view.tags.mood.slice(0, 2)]
  const line = [rating, ...tags].filter((v): v is string => v !== null)
  return (
    <PageSection
      id="hardcover"
      title="Hardcover"
      actions={
        <Button ref={findRef} variant="ghost" size="sm" onClick={() => setFinding(true)}>
          Change…
        </Button>
      }
    >
      <div className="grid gap-2">
        <p className="text-sm" dir="auto">
          {line.join(' · ')}
          {view.hardcoverId !== null ? (
            <>
              {' · '}
              <a className="underline" href={`https://hardcover.app/id/book/${view.hardcoverId}`} target="_blank" rel="noreferrer noopener">
                Open ↗
              </a>
            </>
          ) : null}
        </p>
        {view.similar.length > 0 && (
          <div className="grid gap-1">
            <p className="text-sm font-medium">Similar in the library</p>
            <ul className="grid grid-cols-1 gap-1 text-sm">
              {view.similar.map((w, i) => (
                // phones show three until "Show all"; wider screens show all six
                <li key={w.id} dir="auto" className={`min-w-0 break-words ${!all && i >= PHONE_SHOWN ? 'hidden sm:list-item' : ''}`}>
                  <Link to="/books/$workId" params={{ workId: w.id }} className="underline">
                    {w.title}
                  </Link>
                  {w.status === 'read' ? ' ✓' : ''}
                </li>
              ))}
            </ul>
            {!all && view.similar.length > PHONE_SHOWN ? (
              <Button variant="link" className="h-auto justify-self-start p-0 sm:hidden" onClick={() => setAll(true)}>
                Show all
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {dialog}
    </PageSection>
  )
}
