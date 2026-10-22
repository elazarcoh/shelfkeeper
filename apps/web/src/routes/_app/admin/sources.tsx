import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/page'
import { Button } from '@/components/ui/button'
import { SourceDialog } from '@/features/sources/source-dialog'
import { emptySourceForm, toCreateInput } from '@/features/sources/source-form-state'
import { SourceRow } from '@/features/sources/source-row'
import { trpc } from '@/lib/trpc'

export const Route = createFileRoute('/_app/admin/sources')({ component: SourcesPage })

/** Rendered inside the admin layout, which provides PageBody. */
function SourcesPage() {
  const queryClient = useQueryClient()
  const sources = useQuery(trpc.sources.list.queryOptions())
  const create = useMutation(
    trpc.sources.create.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries({ queryKey: trpc.sources.pathKey() }) }),
  )

  return (
    // grid-cols-1: a source row's one-line (truncated) URL must not size the column past a phone screen
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-sm text-muted-foreground">
          Books found in a source go to the Inbox for review. Nothing is ever written back to the source.
        </p>
        <SourceDialog
          title="Add a source"
          initial={emptySourceForm('audiobookshelf')}
          trigger={
            <Button size="sm">
              <Plus className="size-4" /> Add source
            </Button>
          }
          onSave={async (form) => {
            const input = toCreateInput(form)
            if (!input.ok) return input.message
            await create.mutateAsync(input.value)
            toast.success('Source added')
            return null
          }}
        />
      </div>
      {sources.data && sources.data.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {sources.data.map((s) => (
            <SourceRow key={s.id} source={s} />
          ))}
        </ul>
      ) : (
        <EmptyState title="No sources yet" hint="Add an Audiobookshelf, Calibre, Readarr or Chaptarr server to bring its books into the catalog." />
      )}
    </div>
  )
}
