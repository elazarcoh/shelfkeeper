import { useMutation, useQuery } from '@tanstack/react-query'
import { useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { returnFocusProps } from '@/components/dialog-focus'
import { DialogPanel } from '@/components/dialog-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { SearchInput } from '@/components/ui/search-input'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { useDebounced } from '@/lib/use-debounced'
import { mergePrimaryDefault, seriesSummary } from './series-admin-state'
import { useSeriesAdminRefresh } from './use-series-admin-refresh'

type SeriesDetail = RouterOutputs['admin']['series']['get']

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** the series the dialog was opened on */
  series: { id: string; names: { name: string }[] }
  returnFocusRef?: RefObject<HTMLElement | null> | undefined
}

const MAX_BOOKS = 10

/** Step 1 picks the other series, step 2 chooses the primary name. The steps live in the content, so each opening starts fresh. */
export function MergeSeriesDialog({ open, onOpenChange, series, returnFocusRef }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent bare className="sm:max-w-lg" {...returnFocusProps(returnFocusRef)}>
        <MergeSteps series={series} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function MergeSteps({ series, onClose }: { series: Props['series']; onClose: () => void }) {
  const [otherId, setOtherId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const settled = useDebounced(q, 250)
  const results = useQuery({ ...trpc.admin.series.list.queryOptions({ q: settled, limit: 20 }), enabled: otherId === null && settled.trim() !== '' })

  if (otherId === null) {
    const others = results.data?.series.filter((s) => s.id !== series.id) ?? []
    return (
      <DialogPanel
        title="Same series as…"
        description="Find the other spelling of this series."
        footer={
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
        }
      >
        <div className="grid grid-cols-1 gap-3">
          <SearchInput aria-label="Find the other series" placeholder="Find by any name…" dir="auto" value={q} onValueChange={setQ} />
          {others.length > 0 ? (
            <ul className="grid grid-cols-1 gap-1">
              {others.map((s) => {
                const label = s.names[0]?.name ?? s.name
                return (
                  <li key={s.id} className="flex min-w-0 items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate" dir="auto">
                      {s.names.map((n) => n.name).join(' · ')}
                      <span className="text-muted-foreground"> ({seriesSummary(s.bookCount)})</span>
                    </span>
                    <Button size="sm" variant="outline" aria-label={`Pick ${label}`} onClick={() => setOtherId(s.id)}>
                      Pick
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : settled.trim() !== '' && results.data !== undefined ? (
            <p className="text-sm text-muted-foreground">No other series found.</p>
          ) : null}
        </div>
      </DialogPanel>
    )
  }
  return <MergeConfirm seriesId={series.id} otherId={otherId} onBack={() => setOtherId(null)} onClose={onClose} />
}

/** Loads both series, then starts the form from the default primary (the state is initialised once, when both are in). */
function MergeConfirm({ seriesId, otherId, onBack, onClose }: { seriesId: string; otherId: string; onBack: () => void; onClose: () => void }) {
  const opened = useQuery(trpc.admin.series.get.queryOptions({ seriesId }))
  const other = useQuery(trpc.admin.series.get.queryOptions({ seriesId: otherId }))
  if (opened.data === undefined || other.data === undefined) {
    const error = opened.error ?? other.error
    return (
      <DialogPanel
        title="Merge series"
        footer={
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
        }
      >
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </DialogPanel>
    )
  }
  return <MergeForm opened={opened.data} other={other.data} onBack={onBack} onClose={onClose} />
}

function MergeForm({ opened, other, onBack, onClose }: { opened: SeriesDetail; other: SeriesDetail; onBack: () => void; onClose: () => void }) {
  const refresh = useSeriesAdminRefresh()
  const [primaryNameId, setPrimaryNameId] = useState(() => mergePrimaryDefault(opened, other))
  const names = [...opened.names, ...other.names]
  const openedBooks = new Set(opened.books.map((b) => b.workId))
  const inBoth = other.books.filter((b) => openedBooks.has(b.workId)).length
  const merge = useMutation(
    trpc.admin.series.merge.mutationOptions({
      onSuccess: () => {
        toast.success(`Merged into ${names.find((n) => n.id === primaryNameId)?.name ?? ''}`)
        refresh()
        onClose()
      },
    }),
  )

  return (
    <DialogPanel
      title="Merge series"
      footer={
        <>
          <Button variant="outline" disabled={merge.isPending} onClick={onBack}>
            Back
          </Button>
          <Button disabled={merge.isPending} onClick={() => merge.mutate({ seriesId: opened.id, otherId: other.id, primaryNameId })}>
            Merge
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SeriesBooks series={opened} />
          <SeriesBooks series={other} />
        </div>
        <div role="radiogroup" aria-label="Primary name" className="grid grid-cols-1 gap-2">
          {names.map((n) => (
            <label key={n.id} className="flex min-h-9 min-w-0 items-center gap-2 pointer-coarse:min-h-11">
              <input type="radio" name="primary-name" checked={primaryNameId === n.id} onChange={() => setPrimaryNameId(n.id)} />
              <span className="min-w-0 break-words" dir="auto">
                {n.name}
              </span>
            </label>
          ))}
        </div>
        <p className="text-muted-foreground">
          <bdi>{other.names.find((n) => n.primary)?.name ?? other.name}</bdi> is removed; its {seriesSummary(other.bookCount).toLowerCase()} move here ({inBoth} already in both). You can split a name off again
          later; books you tick move with it.
        </p>
      </div>
    </DialogPanel>
  )
}

function SeriesBooks({ series }: { series: SeriesDetail }) {
  const shown = series.books.slice(0, MAX_BOOKS)
  const more = Math.max(series.bookCount, series.books.length) - shown.length
  return (
    <div className="grid min-w-0 grid-cols-1 content-start gap-1">
      <p className="font-medium break-words" dir="auto">
        {series.names.find((n) => n.primary)?.name ?? series.names[0]?.name}
      </p>
      {shown.length === 0 ? <p className="text-muted-foreground">No books</p> : null}
      <ul className="grid grid-cols-1 gap-0.5 text-muted-foreground">
        {shown.map((b) => (
          <li key={b.workId} className="break-words">
            <bdi>{b.title}</bdi>
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="text-muted-foreground">and {more} more</p> : null}
    </div>
  )
}
