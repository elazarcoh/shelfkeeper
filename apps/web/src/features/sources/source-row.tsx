import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { sourceKindLabel } from '@/lib/format'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { SourceDialog } from './source-dialog'
import { secretLabel, sourceFormFrom, toUpdatePatch } from './source-form-state'

type Source = RouterOutputs['sources']['list'][number]

const scheduleText = { hourly: 'hourly', daily: 'daily', weekly: 'weekly' } as const

export function SourceRow({ source }: { source: Source }) {
  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.sources.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.jobs.pathKey() })
  }
  const test = useMutation(
    trpc.sources.test.mutationOptions({
      onSuccess: (result) => {
        if (result.ok) toast.success(<span dir="auto">Connected — {result.value.libraries.join(', ')}</span>)
        else toast.error(<span dir="auto">{result.error.message}</span>)
      },
    }),
  )
  const sync = useMutation(
    trpc.sources.syncNow.mutationOptions({
      onSuccess: () => {
        refresh()
        toast.success('Sync queued')
      },
    }),
  )
  const update = useMutation(trpc.sources.update.mutationOptions({ onSuccess: refresh }))
  const [confirmRemove, setConfirmRemove] = useState(false)
  const removal = useQuery({ ...trpc.sources.removalInfo.queryOptions({ sourceId: source.id }), enabled: confirmRemove })
  const remove = useMutation(
    trpc.sources.remove.mutationOptions({
      onSuccess: () => {
        refresh()
        void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() })
        toast.success(<span dir="auto">Removed {source.name}</span>)
      },
      onError: (error) => toast.error(error.message),
    }),
  )

  return (
    // below sm the details take a row of their own (wrapping, not truncated) and the buttons share the next one;
    // a shrinking details column was crushed between them
    <li className="flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
        <p className="font-medium break-words" dir="auto">
          {source.name} <Badge variant="outline">{sourceKindLabel[source.kind]}</Badge>
        </p>
        <p className="text-sm wrap-anywhere text-muted-foreground sm:truncate">
          {source.config.baseUrl} · {source.schedule === null ? 'manual sync' : `syncs ${scheduleText[source.schedule]}`}
          {source.lastSyncAt !== null ? ` · last sync ${new Date(source.lastSyncAt).toLocaleString()} (${source.lastSyncStatus ?? '—'})` : ' · never synced'}
        </p>
        {source.credentialsUnreadable && (
          <p className="text-sm text-destructive" dir="auto">
            Stored {secretLabel[source.kind].toLowerCase()} can't be read — re-enter it
          </p>
        )}
      </div>
      <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate({ sourceId: source.id })}>
        Test connection
      </Button>
      <Button size="sm" disabled={sync.isPending} onClick={() => sync.mutate({ sourceId: source.id })}>
        Sync now
      </Button>
      <SourceDialog
        title={`Edit ${source.name}`}
        editing
        initial={sourceFormFrom(source)}
        trigger={
          <Button size="sm" variant="ghost">
            Edit
          </Button>
        }
        onSave={async (form) => {
          const patch = toUpdatePatch(form)
          if (!patch.ok) return patch.message
          await update.mutateAsync({ sourceId: source.id, patch: patch.value })
          toast.success('Saved')
          return null
        }}
      />
      <Button size="sm" variant="ghost" className="text-destructive" disabled={remove.isPending} onClick={() => setConfirmRemove(true)}>
        Remove
      </Button>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${source.name}?`}
        description={
          removal.data === undefined
            ? 'Counting what it brought in…'
            : `${removal.data.pendingProposals} pending Inbox proposals will be discarded. ${removal.data.books} books stay in the library.`
        }
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          setConfirmRemove(false)
          remove.mutate({ sourceId: source.id })
        }}
      />
    </li>
  )
}
