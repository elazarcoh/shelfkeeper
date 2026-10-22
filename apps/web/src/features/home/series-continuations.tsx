import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { WorkCover } from '@/components/work-cover'
import { QuickActionsShell, useQuickActionsOpen } from '@/features/library/quick-actions/quick-actions-shell'
import { SheetFrame } from '@/features/library/quick-actions/quick-actions-sheet'
import { HIDE_CONTINUATION } from '@/features/library/quick-actions/series-action-model'
import { trpc, type RouterOutputs } from '@/lib/trpc'

type Continuation = RouterOutputs['series']['continuations'][number]

export function SeriesContinuations({ items }: { items: Continuation[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((c) => (
        <ContinuationCard key={c.seriesId} c={c} />
      ))}
    </div>
  )
}

/** Hides a series from Series continuation, with an Undo toast; a Library series card brings it back too. */
function useHideContinuation(c: Continuation) {
  const queryClient = useQueryClient()
  const setHidden = useMutation(
    trpc.series.setContinuationHidden.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.series.pathKey() }),
      onError: (e) => toast.error(e.message),
    }),
  )
  return {
    pending: setHidden.isPending,
    hide: () =>
      setHidden.mutate(
        { seriesId: c.seriesId, hidden: true },
        {
          onSuccess: () =>
            toast(`Hid “${c.seriesName}” from Series continuation`, {
              action: { label: 'Undo', onClick: () => setHidden.mutate({ seriesId: c.seriesId, hidden: false }) },
            }),
        },
      ),
  }
}

/** One series' next book. Right-click, ⋯ or long-press offers to hide the series from here. */
function ContinuationCard({ c }: { c: Continuation }) {
  const state = useQuickActionsOpen()
  const { hide, pending } = useHideContinuation(c)
  return (
    <QuickActionsShell
      title={c.seriesName}
      layout="tile"
      state={state}
      menu={(K) => (
        <K.Item disabled={pending} onSelect={hide}>
          {HIDE_CONTINUATION}
        </K.Item>
      )}
      sheet={(open, onOpenChange) => (
        <SheetFrame title={c.seriesName} open={open} onOpenChange={onOpenChange}>
          <Button
            variant="ghost"
            className="justify-start"
            disabled={pending}
            onClick={() => {
              hide()
              onOpenChange(false)
            }}
          >
            {HIDE_CONTINUATION}
          </Button>
        </SheetFrame>
      )}
    >
      <Link to="/books/$workId" params={{ workId: c.nextWorkId }} className="block h-full">
        <Card className="h-full transition-colors hover:bg-muted/50">
          <CardContent className="flex items-center gap-3">
            <WorkCover title={c.nextTitle} coverAssetId={c.nextCoverAssetId} label={false} className="w-10 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-muted-foreground" dir="auto">
                {c.seriesName}
              </p>
              <p className="truncate font-medium" dir="auto">
                {c.nextTitle}
              </p>
              {c.nextAuthors.length > 0 ? (
                <p className="truncate text-sm text-muted-foreground" dir="auto">
                  {c.nextAuthors.join(', ')}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </Link>
    </QuickActionsShell>
  )
}
