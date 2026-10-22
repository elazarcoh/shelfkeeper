import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'
import { EmptyState } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatRunDuration, isActive, statsLine, statusLabel, triggerLabel } from '@/features/jobs/job-summary'
import { trpc } from '@/lib/trpc'

export const Route = createFileRoute('/_app/admin/jobs')({ component: JobsPage })

const ACTIVE_REFRESH_MS = 5000

function JobsPage() {
  const queryClient = useQueryClient()
  const jobs = useQuery({
    ...trpc.jobs.list.queryOptions(),
    refetchInterval: (query) => (query.state.data?.some((run) => isActive(run.status)) ? ACTIVE_REFRESH_MS : false),
  })
  const rerun = useMutation(
    trpc.jobs.rerun.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.jobs.pathKey() })
        toast.success('Sync queued')
      },
    }),
  )

  if (!jobs.data || jobs.data.length === 0) return <EmptyState title="No syncs yet" hint="Use “Sync now” on the Sources tab." />
  return (
    <ul className="divide-y rounded-lg border">
      {jobs.data.map((run) => {
        const duration = formatRunDuration(run.startedAt, run.finishedAt)
        return (
          // minmax(0,1fr), not auto / 1fr: those tracks grow to a long source name or error instead of wrapping it
          <li key={run.id} className="grid grid-cols-1 gap-1 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                <span className="min-w-0 break-words" dir="auto">
                  {run.sourceName}
                </span>
                <Badge
                  variant={
                    run.status === 'failed'
                      ? 'destructive'
                      : run.status === 'succeeded'
                        ? 'secondary'
                        : run.status === 'skipped'
                          ? 'default'
                          : 'outline'
                  }
                >
                  {statusLabel[run.status]}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {triggerLabel[run.trigger]}
                  {run.requestedByName !== null ? ` by ${run.requestedByName}` : ''} · {new Date(run.createdAt).toLocaleString()}
                  {isActive(run.status) && run.startedAt !== null ? ` · started ${new Date(run.startedAt).toLocaleString()}` : ''}
                  {!isActive(run.status) && run.finishedAt !== null
                    ? ` · finished ${new Date(run.finishedAt).toLocaleString()}${duration !== null ? ` (took ${duration})` : ''}`
                    : ''}
                </span>
              </p>
              {run.stats !== null ? <p className="text-sm text-muted-foreground">{statsLine(run.stats)}</p> : null}
              {run.error !== null ? (
                <p className="text-sm break-words text-destructive" dir="auto">
                  {run.error}
                </p>
              ) : null}
              {run.stats && run.stats.errors.length > 0 ? (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">Unreadable items</summary>
                  <ul className="mt-1 grid gap-0.5">
                    {run.stats.errors.map((e, i) => (
                      <li key={`${e.externalId ?? 'unknown'}-${i}`} dir="auto">
                        {e.externalId ?? 'unknown item'} — {e.message}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
            {!isActive(run.status) ? (
              <Button size="sm" variant="outline" disabled={rerun.isPending} onClick={() => rerun.mutate({ runId: run.id })}>
                Re-run
              </Button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
