import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { EditionInput, InboxResolution } from '@mylib/domain'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { CandidateCard } from './candidate-card'
import { CandidateList } from './candidate-list'
import { ItemSummary } from './item-summary'
import { OtherBookPicker } from './other-book-picker'

type Entry = RouterOutputs['inbox']['list']['items'][number]

export function ProposalCard({ entry }: { entry: Entry }) {
  const queryClient = useQueryClient()
  const mode = entry.kind === 'create_wanted' ? 'wanted' : 'copy'
  const resolve = useMutation(
    trpc.inbox.resolve.mutationOptions({
      onSuccess: (_result, variables) => {
        for (const key of [trpc.inbox.pathKey(), trpc.library.pathKey(), trpc.catalog.pathKey()]) void queryClient.invalidateQueries({ queryKey: key })
        const action = variables.resolution.action
        toast.success(action === 'ignore' ? 'Ignored' : action === 'create_wanted' ? 'Added as a wanted book' : action === 'attach_wanted' ? 'Linked to the book' : 'Added to the catalog')
      },
      // a CONFLICT means someone else already resolved this item — refresh the list instead of leaving a stale row
      onError: () => void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() }),
    }),
  )
  const act = (resolution: InboxResolution) => resolve.mutate({ proposalId: entry.id, resolution })
  const addWith = (workId: string) => (edition: EditionInput) => resolve.mutateAsync({ proposalId: entry.id, resolution: { action: 'link_new_edition', workId, edition } })
  const headingId = `inbox-${entry.id}`

  return (
    <section aria-labelledby={headingId} className="grid grid-cols-1 gap-4 rounded-lg border p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      {/* grid-cols-1 here and below (minmax(0,1fr)): an auto track grows to a long title's or source name's width */}
      <div className="grid min-w-0 grid-cols-1 content-start gap-2">
        <h3 id={headingId} className="text-lg font-semibold break-words text-match-parent" dir="auto">
          {entry.item.title}
        </h3>
        {mode === 'wanted' ? (
          <Badge variant="secondary" className="max-w-full">
            <span className="truncate">
              Wanted in <span dir="auto">{entry.sourceName}</span>
            </span>
          </Badge>
        ) : null}
        <ItemSummary item={entry.item} sourceName={entry.sourceName} />
        <div className="flex flex-wrap gap-2 pt-2">
          {mode === 'wanted' ? (
            <Button size="sm" variant="secondary" disabled={resolve.isPending} onClick={() => act({ action: 'create_wanted' })}>
              Add as wanted book
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled={resolve.isPending} onClick={() => act({ action: 'create_work' })}>
              Create new book
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={resolve.isPending} onClick={() => act({ action: 'ignore' })}>
            Ignore
          </Button>
        </div>
      </div>
      {/* stacked (below md): a rule separates the matches from the row's own actions; with no match it is a quiet note, not a heading */}
      <div className="grid min-w-0 grid-cols-1 content-start gap-2 max-md:border-t max-md:pt-4">
        <p className={entry.candidates.length > 0 ? 'text-sm font-medium' : 'text-sm text-muted-foreground'}>
          {entry.candidates.length > 0 ? (mode === 'wanted' ? 'Is it one of these books?' : 'Is it one of these?') : 'No similar books in the catalog'}
        </p>
        <CandidateList count={entry.candidates.length}>
          {entry.candidates.map((c) => (
            <CandidateCard key={`${c.workId}-${c.editionId ?? ''}`} candidate={c} item={entry.item} itemFormat={entry.item.format} busy={resolve.isPending} mode={mode} onResolve={act} onAddWith={addWith} />
          ))}
        </CandidateList>
        <OtherBookPicker busy={resolve.isPending} mode={mode} onResolve={act} item={entry.item} onAddWith={addWith} />
      </div>
    </section>
  )
}
