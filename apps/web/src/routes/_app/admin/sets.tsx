import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { NameDialog } from '@/components/name-dialog'
import { EmptyState } from '@/components/page'
import { useRemovalFocus } from '@/components/removal-focus'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { trpc, type RouterOutputs } from '@/lib/trpc'

export const Route = createFileRoute('/_app/admin/sets')({ component: HouseholdSetsPage })

type HouseholdSet = RouterOutputs['admin']['sets']['list'][number]

const HEADING_ID = 'household-sets-heading'

function HouseholdSetsPage() {
  const queryClient = useQueryClient()
  const sets = useQuery(trpc.admin.sets.list.queryOptions())
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.admin.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.sets.pathKey() })
  }
  const create = useMutation(trpc.sets.create.mutationOptions({ onSuccess: refresh }))
  const update = useMutation(trpc.sets.update.mutationOptions({ onSuccess: refresh }))
  const remove = useMutation(trpc.sets.delete.mutationOptions({ onSuccess: refresh }))

  return (
    // grid-cols-1 (minmax(0,1fr)): an auto track grows to a long set name instead of letting it wrap
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-sm text-muted-foreground">
          Add books to a household set from a book’s page (“Add to set…”). Smart household sets are saved from the Library filters.
        </p>
        <NameDialog
          title="New household set"
          label="Set name"
          submitLabel="Create set"
          trigger={
            <Button size="sm">
              <Plus className="size-4" /> New household set
            </Button>
          }
          onSubmit={(name) => create.mutateAsync({ kind: 'manual', scope: 'global', name })}
        />
      </div>
      {/* focusable (tabIndex -1) so focus has somewhere to land after the last set is deleted */}
      <h2 id={HEADING_ID} tabIndex={-1} className="sr-only rounded-sm outline-none focus-visible:not-sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50">
        Household sets
      </h2>
      {sets.data && sets.data.length > 0 ? (
        <ul aria-labelledby={HEADING_ID} className="divide-y rounded-lg border">
          {sets.data.map((s) => (
            <HouseholdSetRow
              key={s.id}
              set={s}
              onDefaultChange={(on) => update.mutate({ setId: s.id, patch: { defaultForNewUsers: on } })}
              onRename={(name) => update.mutateAsync({ setId: s.id, patch: { name } })}
              onDelete={(onError) => remove.mutate({ setId: s.id }, { onError })}
            />
          ))}
        </ul>
      ) : (
        <EmptyState title="No household sets yet" hint="Create one, e.g. “Kids’ shelf” or “Living room”." />
      )}
    </div>
  )
}

function HouseholdSetRow({
  set: s,
  onDefaultChange,
  onRename,
  onDelete,
}: {
  set: HouseholdSet
  onDefaultChange: (on: boolean) => void
  onRename: (name: string) => Promise<unknown>
  onDelete: (onError: () => void) => void
}) {
  // Delete's close focus: its button on Cancel, repointed on confirm because this row is about to go
  const deleteFocus = useRemovalFocus()
  return (
    // below sm the name takes a row of its own and the controls share the next one (a shrinking name column was
    // crushed to a few letters per line between them)
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 p-4 sm:gap-3">
      <div className="flex min-w-0 basis-full flex-wrap items-center gap-2 sm:flex-1 sm:basis-0">
        <Link to="/library" search={{ set: s.id }} className="min-w-0 font-medium break-words hover:underline pointer-coarse:touch-hit" dir="auto">
          {s.name}
        </Link>
        {s.kind === 'smart' ? <Badge variant="outline">Smart</Badge> : null}
      </div>
      <div className="flex min-h-11 flex-1 items-center gap-2 sm:flex-none">
        <Checkbox id={`default-${s.id}`} checked={s.defaultForNewUsers} onCheckedChange={(v) => onDefaultChange(v === true)} />
        <Label htmlFor={`default-${s.id}`}>On for new people</Label>
      </div>
      <NameDialog
        title="Rename set"
        label="Set name"
        initial={s.name}
        trigger={
          <Button variant="ghost" size="sm">
            Rename
          </Button>
        }
        onSubmit={onRename}
      />
      <ConfirmDialog
        trigger={
          <Button ref={deleteFocus.triggerRef} variant="ghost" size="sm" data-household-set-delete>
            Delete
          </Button>
        }
        title={`Delete the household set “${s.name}”?`}
        description="The books stay in the catalog."
        confirmLabel="Delete set"
        destructive
        returnFocusRef={deleteFocus.closeFocus}
        onOpenChange={deleteFocus.onOpenChange}
        onConfirm={() => {
          // the next row's Delete, else the list heading
          deleteFocus.retarget('[data-household-set-delete]', HEADING_ID)
          onDelete(deleteFocus.restore)
        }}
      />
    </li>
  )
}
