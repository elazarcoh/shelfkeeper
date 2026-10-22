import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { workKindLabel, type HealthItem } from '@mylib/domain'
import { Button } from '@/components/ui/button'
import { MergeWorkDialog } from '@/features/book/merge-work-dialog'
import { trpc } from '@/lib/trpc'
import { itemDetail } from './health-state'

export function HealthRow({ item, ignored, onChanged }: { item: HealthItem; ignored: boolean; onChanged: () => void }) {
  const [merging, setMerging] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const ignore = useMutation(trpc.admin.health.ignore.mutationOptions({ onSuccess: onChanged, onError: (e) => toast.error(e.message) }))
  const unignore = useMutation(trpc.admin.health.unignore.mutationOptions({ onSuccess: onChanged, onError: (e) => toast.error(e.message) }))
  const deleteSeries = useMutation(
    trpc.admin.health.deleteEmptySeries.mutationOptions({
      onSuccess: () => {
        toast.success('Series deleted')
        onChanged()
      },
      onError: (e) => {
        toast.error(e.message)
        onChanged()
      },
    }),
  )
  const markKind = useMutation(
    trpc.catalog.update.mutationOptions({
      onSuccess: onChanged,
      onError: (e) => toast.error(e.message),
    }),
  )
  // "Not this": the work is a book by hand, and the row is ignored with it
  const dismissKind = useMutation(trpc.admin.health.dismissKind.mutationOptions({ onSuccess: onChanged, onError: (e) => toast.error(e.message) }))
  const subject = { check: item.check, subjectKey: item.key }
  const busy = ignore.isPending || unignore.isPending || deleteSeries.isPending || markKind.isPending || dismissKind.isPending

  const title =
    item.check === 'duplicates' ? (
      <span className="flex min-w-0 flex-col">
        {item.works.map((w) => (
          <Link key={w.id} to="/books/$workId" params={{ workId: w.id }} className="truncate font-medium hover:underline" dir="auto">
            {w.title}
          </Link>
        ))}
      </span>
    ) : item.check === 'empty_series' || item.check === 'series_gaps' ? (
      <span className="truncate font-medium" dir="auto">
        {item.series.name}
      </span>
    ) : (
      <Link to="/books/$workId" params={{ workId: item.work.id }} className="truncate font-medium hover:underline" dir="auto">
        {item.work.title}
      </Link>
    )

  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        {title}
        <span className="text-sm text-muted-foreground">
          {item.check === 'long_loans' ? (
            <>
              Lent to <bdi>{item.loan.borrower}</bdi> on {item.loan.lentOn}
              {item.loan.dueOn === null ? '' : `, due ${item.loan.dueOn}`}
            </>
          ) : (
            itemDetail(item)
          )}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {item.check === 'duplicates' && !ignored ? (
          <Button size="sm" onClick={() => setMerging(true)}>
            Merge
          </Button>
        ) : null}
        {item.check === 'series_gaps' ? (
          <Button size="sm" variant="outline" asChild>
            <Link to="/library" search={{ seriesIds: [item.series.id] }}>
              Open series
            </Link>
          </Button>
        ) : null}
        {item.check === 'long_loans' ? (
          <Button size="sm" variant="outline" asChild>
            <Link to="/loans">Open loans</Link>
          </Button>
        ) : null}
        {item.check === 'empty_series' && !ignored ? (
          confirmDelete ? (
            <>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => deleteSeries.mutate({ seriesId: item.series.id })}>
                Delete “<bdi>{item.series.name}</bdi>”
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)}>
              Delete series
            </Button>
          )
        ) : null}
        {item.check === 'kind_suggestions' && !ignored ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => markKind.mutate({ workId: item.work.id, patch: { kind: item.suggested } })}>
              Mark as {workKindLabel[item.suggested]}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => dismissKind.mutate({ workId: item.work.id })}>
              Not this
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => (ignored ? unignore.mutate(subject) : ignore.mutate(subject))}>
          {ignored ? 'Unignore' : 'Ignore'}
        </Button>
      </div>
      {item.check === 'duplicates' && merging ? (
        <MergeWorkDialog open={merging} onOpenChange={setMerging} source={item.works[1]} target={item.works[0]} onMerged={onChanged} />
      ) : null}
    </li>
  )
}
