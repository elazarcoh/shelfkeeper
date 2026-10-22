import { useMutation, useQuery } from '@tanstack/react-query'
import { useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { returnFocusProps } from '@/components/dialog-focus'
import { DialogPanel } from '@/components/dialog-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { trpc } from '@/lib/trpc'
import { splitDisabled } from './series-admin-state'
import { useSeriesAdminRefresh } from './use-series-admin-refresh'

interface NameRef {
  id: string
  name: string
  primary: boolean
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  series: { id: string; names: NameRef[] }
  /** the name that becomes a series of its own */
  name: NameRef
  returnFocusRef?: RefObject<HTMLElement | null> | undefined
}

/** The form lives in the content, so each opening starts with no book ticked. */
export function SplitSeriesDialog({ open, onOpenChange, series, name, returnFocusRef }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent bare className="sm:max-w-md" {...returnFocusProps(returnFocusRef)}>
        <SplitForm series={series} name={name} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

/**
 * Tick the books that move to the new series. Splitting the primary name also asks which remaining name becomes the
 * series' primary.
 */
function SplitForm({ series, name, onClose }: { series: Props['series']; name: NameRef; onClose: () => void }) {
  const refresh = useSeriesAdminRefresh()
  const detail = useQuery(trpc.admin.series.get.queryOptions({ seriesId: series.id }))
  const others = series.names.filter((n) => n.id !== name.id)
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [primaryId, setPrimaryId] = useState<string | null>(others[0]?.id ?? null)
  const split = useMutation(
    trpc.admin.series.split.mutationOptions({
      onSuccess: () => {
        toast.success(`Split off ${name.name}`)
        refresh()
        onClose()
      },
    }),
  )
  const books = detail.data?.books ?? []
  const disabled = split.isPending || detail.data === undefined || splitDisabled(ticked.size, books.length) || (name.primary && primaryId === null)

  function toggle(workId: string) {
    const next = new Set(ticked)
    if (next.has(workId)) next.delete(workId)
    else next.add(workId)
    setTicked(next)
  }

  return (
    <DialogPanel
      title={`Split off “${name.name}”`}
      description="It becomes a separate series. Tick the books that move to it; at least one stays here."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button disabled={disabled} onClick={() => split.mutate({ nameId: name.id, workIds: [...ticked], primaryNameId: name.primary ? primaryId : null })}>
            Split off
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 text-sm">
        {detail.error ? (
          <p role="alert" className="text-destructive">
            {detail.error.message}
          </p>
        ) : detail.data === undefined ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <div role="group" aria-label="Books to move" className="grid grid-cols-1 gap-1">
            {books.map((b) => (
              <label key={b.workId} className="flex min-h-9 items-center gap-2 pointer-coarse:min-h-11">
                <input type="checkbox" checked={ticked.has(b.workId)} onChange={() => toggle(b.workId)} />
                <span className="min-w-0 break-words" dir="auto">
                  {b.title}
                </span>
              </label>
            ))}
          </div>
        )}
        {name.primary ? (
          <div role="radiogroup" aria-label="New primary name" className="grid grid-cols-1 gap-1">
            <p className="text-muted-foreground">Which of the remaining names is the primary one?</p>
            {others.map((n) => (
              <label key={n.id} className="flex min-h-9 items-center gap-2 pointer-coarse:min-h-11">
                <input type="radio" name="new-primary-name" checked={primaryId === n.id} onChange={() => setPrimaryId(n.id)} />
                <span dir="auto">{n.name}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>
    </DialogPanel>
  )
}
