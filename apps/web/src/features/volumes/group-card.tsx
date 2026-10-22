import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { reviewDefaults, reviewProblem, type GroupReview, type VolumeCatalogEdition, type VolumeCatalogEntry, type VolumeGroup } from '@mylib/domain'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { trpc } from '@/lib/trpc'
import { toMergeInput } from './volumes-state'

const MAX_LINES = 6

function editionText(e: VolumeCatalogEdition): string {
  const volume = e.volume === null ? null : e.volumeCount === null ? `vol ${String(e.volume)}` : `vol ${String(e.volume)} of ${String(e.volumeCount)}`
  return [e.format, e.language, volume].filter((p): p is string => p !== null).join(' · ')
}

/** "" and anything that is not a whole number read as no number. */
function numberOrNull(text: string): number | null {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : null
}

export function GroupCard({ group, entries, onDismiss }: { group: VolumeGroup; entries: readonly VolumeCatalogEntry[]; onDismiss: (key: string) => void }) {
  const queryClient = useQueryClient()
  const headingId = useId()
  const radioName = useId()
  const [review, setReview] = useState<GroupReview>(() => reviewDefaults(group, entries))
  const byId = new Map(entries.map((e) => [e.id, e]))
  const outOfRange = [review.volumeCount, ...review.members.map((m) => m.volume)].some((n) => n !== null && (n < 1 || n > 999))
  const problem = outOfRange ? 'Volumes are numbers from 1 to 999' : reviewProblem(review, entries)

  const merge = useMutation(
    trpc.admin.volumes.merge.mutationOptions({
      onSuccess: ({ fused, dropped }, input) => {
        const all = [...fused, ...dropped]
        const lines = all.slice(0, MAX_LINES)
        if (all.length > MAX_LINES) lines.push(`and ${String(all.length - MAX_LINES)} more`)
        toast.success(`Merged into “${input.title}”`, lines.length > 0 ? { description: lines.join('\n'), classNames: { description: 'whitespace-pre-line' } } : {})
        void queryClient.invalidateQueries({ queryKey: trpc.admin.pathKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.catalog.pathKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.library.pathKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.stats.pathKey() })
      },
    }),
  )

  const setVolume = (workId: string, text: string) =>
    setReview((r) => ({ ...r, members: r.members.map((m) => (m.workId === workId ? { ...m, volume: numberOrNull(text) } : m)) }))

  return (
    <Card>
      <section aria-labelledby={headingId} className="grid gap-4">
        <CardHeader>
          <CardTitle id={headingId} role="heading" aria-level={3} dir="auto">
            {group.bookTitle}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-xs text-muted-foreground">Book to keep</p>
          <ul role="radiogroup" aria-label="Book to keep" className="grid gap-3">
            {review.members.map((m) => {
              const entry = byId.get(m.workId)
              const volumeId = `${radioName}-vol-${m.workId}`
              const titleId = `${radioName}-title-${m.workId}`
              const keepId = `${radioName}-keep-${m.workId}`
              return (
                <li key={m.workId} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_auto] sm:items-start">
                  <div className="grid min-w-0 gap-0.5 text-sm">
                    <Link id={titleId} to="/books/$workId" params={{ workId: m.workId }} dir="auto" className="font-medium break-words hover:underline pointer-coarse:touch-hit">
                      {entry?.title ?? m.workId}
                    </Link>
                    {entry?.authors[0] !== undefined ? (
                      <span className="text-muted-foreground" dir="auto">
                        {entry.authors[0]}
                      </span>
                    ) : null}
                    {entry !== undefined && entry.editions.length > 0 ? <span className="text-xs text-muted-foreground">{entry.editions.map(editionText).join('; ')}</span> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex min-h-11 items-center gap-2">
                      <input
                        id={keepId}
                        type="radio"
                        name={radioName}
                        aria-describedby={titleId}
                        checked={review.survivorId === m.workId}
                        onChange={() => setReview((r) => ({ ...r, survivorId: m.workId }))}
                      />
                      <Label htmlFor={keepId}>Keep this book</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor={volumeId}>Volume</Label>
                      <Input
                        id={volumeId}
                        aria-describedby={titleId}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={999}
                        className="w-20"
                        value={m.volume === null ? '' : String(m.volume)}
                        onChange={(e) => setVolume(m.workId, e.target.value)}
                      />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="grid gap-1.5">
              <Label htmlFor={`${radioName}-title`}>Book title</Label>
              <Input id={`${radioName}-title`} dir="auto" value={review.title} onChange={(e) => setReview((r) => ({ ...r, title: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${radioName}-count`}>Number of volumes</Label>
              <Input
                id={`${radioName}-count`}
                type="number"
                inputMode="numeric"
                min={1}
                max={999}
                className="w-28"
                value={review.volumeCount === null ? '' : String(review.volumeCount)}
                onChange={(e) => setReview((r) => ({ ...r, volumeCount: numberOrNull(e.target.value) }))}
              />
            </div>
          </div>
          {problem !== null ? (
            <p className="text-sm text-muted-foreground" dir="auto">
              {problem}
            </p>
          ) : null}
          {merge.error ? (
            <p role="alert" className="text-sm text-destructive" dir="auto">
              {merge.error.message}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={problem !== null || merge.isPending} onClick={() => merge.mutate(toMergeInput(review))}>
              Merge as volumes
            </Button>
            <Button type="button" variant="outline" disabled={merge.isPending} onClick={() => onDismiss(group.key)}>
              Not volumes
            </Button>
          </div>
        </CardContent>
      </section>
    </Card>
  )
}
