import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { returnFocusProps } from '@/components/dialog-focus'
import { DialogPanel } from '@/components/dialog-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { SearchInput } from '@/components/ui/search-input'
import { trpc } from '@/lib/trpc'
import { useDebounced } from '@/lib/use-debounced'
import { useInvalidateBook } from './invalidate'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** the book that is merged away */
  source: { id: string; title: string }
  /** controlled use (opened from a menu item): where focus goes on close */
  returnFocusRef?: RefObject<HTMLElement | null> | undefined
  /** start at the confirm step with this book as the one to merge into */
  target?: { id: string; title: string } | undefined
  /** after a merge: called instead of opening the merged book */
  onMerged?: (() => void) | undefined
}

/** Step 1 picks the book to merge into, step 2 confirms. The steps live in the content, so each opening starts fresh. */
export function MergeWorkDialog({ open, onOpenChange, source, returnFocusRef, target, onMerged }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent bare className="sm:max-w-md" {...returnFocusProps(returnFocusRef)}>
        <MergeSteps source={source} initialTarget={target} onMerged={onMerged} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

const MAX_LINES = 5

function MergeSteps({ source, initialTarget, onMerged, onClose }: { source: { id: string; title: string }; initialTarget?: { id: string; title: string } | undefined; onMerged?: (() => void) | undefined; onClose: () => void }) {
  const navigate = useNavigate()
  const invalidate = useInvalidateBook()
  const [target, setTarget] = useState<{ id: string; title: string } | null>(initialTarget ?? null)
  const [q, setQ] = useState('')
  const settled = useDebounced(q, 250)
  const results = useQuery({ ...trpc.library.search.queryOptions({ q: settled }), enabled: target === null && settled.trim() !== '' })
  // for "N editions move"; the book page and the card menu have it cached or fetch it once
  const sourceWork = useQuery(trpc.catalog.get.queryOptions({ workId: source.id }))
  const merge = useMutation(trpc.catalog.mergeWorks.mutationOptions())

  function confirm(t: { id: string; title: string }) {
    merge.mutate(
      { targetWorkId: t.id, sourceWorkIds: [source.id] },
      {
        onSuccess: ({ workId, dropped }) => {
          const lines = dropped.slice(0, MAX_LINES)
          if (dropped.length > MAX_LINES) lines.push(`and ${String(dropped.length - MAX_LINES)} more`)
          toast.success(`Merged into “${t.title}”`, lines.length > 0 ? { description: lines.join('\n'), classNames: { description: 'whitespace-pre-line' } } : {})
          onClose()
          if (onMerged) {
            invalidate()
            onMerged()
          } else {
            // Leave the source's page first so its own query is not refetched into a NOT_FOUND.
            void navigate({ to: '/books/$workId', params: { workId } }).then(invalidate)
          }
        },
      },
    )
  }

  if (target === null) {
    const others = results.data?.items.filter((w) => w.id !== source.id) ?? []
    return (
      <DialogPanel
        title="Merge into another book"
        description={
          <>
            Find the book that should keep <span dir="auto">“{source.title}”</span> as one of its editions.
          </>
        }
        footer={
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
        }
      >
        {/* grid-cols-1 (minmax(0,1fr)): an auto track grows to a long title, so it could not truncate */}
        <div className="grid grid-cols-1 gap-3">
          <SearchInput aria-label="Find the book to merge into" placeholder="Find a book in the catalog…" dir="auto" value={q} onValueChange={setQ} />
          {others.length > 0 ? (
            <ul className="grid grid-cols-1 gap-1">
              {others.map((w) => (
                <li key={w.id} className="flex min-w-0 items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate" dir="auto">
                    {w.title}
                  </span>
                  <Button size="sm" variant="outline" aria-label={`Pick ${w.title}`} onClick={() => setTarget({ id: w.id, title: w.title })}>
                    Pick
                  </Button>
                </li>
              ))}
            </ul>
          ) : settled.trim() !== '' && results.data !== undefined ? (
            <p className="text-sm text-muted-foreground">No other book found.</p>
          ) : null}
        </div>
      </DialogPanel>
    )
  }

  const count = sourceWork.data?.editions.length
  const editions = count === undefined ? 'editions' : count === 1 ? '1 edition' : `${String(count)} editions`
  return (
    <DialogPanel
      title="Merge books"
      footer={
        <>
          <Button variant="outline" disabled={merge.isPending} onClick={() => setTarget(null)}>
            Back
          </Button>
          <Button disabled={merge.isPending} onClick={() => confirm(target)}>
            Merge
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-2 text-sm">
        {/* English sentences around the titles: each title is bidi-isolated (bdi), so a Hebrew one cannot flip the sentence */}
        <p className="font-medium break-words">
          Merge “<bdi>{source.title}</bdi>” into “<bdi>{target.title}</bdi>”?
        </p>
        <p className="text-muted-foreground break-words">
          The {editions} of “<bdi>{source.title}</bdi>” move to “<bdi>{target.title}</bdi>”, and “<bdi>{source.title}</bdi>” is deleted. “
          <bdi>{target.title}</bdi>”’s title, authors, description and series positions win.
        </p>
      </div>
    </DialogPanel>
  )
}
