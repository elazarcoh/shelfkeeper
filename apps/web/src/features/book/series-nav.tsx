import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { seriesLabel } from '@/lib/format'
import { trpc } from '@/lib/trpc'

export function SeriesNav({ seriesId, seriesName, currentWorkId }: { seriesId: string; seriesName: string; currentWorkId: string }) {
  const entries = useQuery(trpc.series.entries.queryOptions({ seriesId }))
  if (!entries.data || entries.data.length <= 1) return null

  return (
    <Card>
      <CardHeader>
        {/* wrap-anywhere: CardHeader is an auto-sized grid, so the name's min-content width must allow breaks */}
        <CardTitle dir="auto" className="wrap-anywhere text-match-parent">
          {seriesName}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* grid-cols-1 (minmax(0,1fr)) + break-words: one long unbroken series name or title wraps instead of widening the page */}
        <ol className="grid grid-cols-1 gap-1 text-sm">
          {entries.data.map((e) => {
            const label = `${seriesLabel({ name: seriesName, position: e.position, positionEnd: e.positionEnd })} — ${e.title}${e.status === 'read' ? ' ✓' : ''}`
            return (
              <li key={e.id} dir="auto" className="min-w-0 break-words">
                {e.id === currentWorkId ? (
                  <span className="font-medium">{label}</span>
                ) : (
                  <Link to="/books/$workId" params={{ workId: e.id }} className="underline-offset-4 hover:underline">
                    {label}
                  </Link>
                )}
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}
