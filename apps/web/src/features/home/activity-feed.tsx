import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { RouterOutputs } from '@/lib/trpc'
import { ACTIVITY_PREVIEW, activityPreview } from './activity-preview'

type Item = RouterOutputs['activity']['feed'][number]

const verb: Record<Item['kind'], string> = {
  started: 'started',
  finished: 'finished',
  abandoned: 'set aside',
  rated: 'rated',
}

export function ActivityFeed({ items }: { items: Item[] }) {
  const [showAll, setShowAll] = useState(false)
  const { shown, hidden } = activityPreview(items, showAll)
  return (
    <div className="grid gap-2">
      <ul className="grid gap-2 text-sm leading-6">
        {shown.map((i) => (
          <li key={i.id} className="min-w-0 break-words">
            <span className="font-medium" dir="auto">
              {i.actorName}
            </span>{' '}
            {verb[i.kind]}{' '}
            {/* underlined at rest: there is no hover on a phone to show the title is a link */}
            <Link
              to="/books/$workId"
              params={{ workId: i.workId }}
              className="py-1 underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground"
              dir="auto"
            >
              {i.workTitle}
            </Link>
            {i.kind === 'rated' && i.rating !== null ? ` (${i.rating}★)` : ''}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <Button variant="link" size="sm" className="h-auto justify-self-start px-0" onClick={() => setShowAll(true)}>
          Show {hidden} more
        </Button>
      ) : null}
      {showAll && items.length > ACTIVITY_PREVIEW ? (
        <Button variant="link" size="sm" className="h-auto justify-self-start px-0" onClick={() => setShowAll(false)}>
          Show less
        </Button>
      ) : null}
    </div>
  )
}
