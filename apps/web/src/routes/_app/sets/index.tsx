import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { EllipsisVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { NameDialog } from '@/components/name-dialog'
import { PageBody, PageHeader } from '@/components/page'
import { useRemovalFocus } from '@/components/removal-focus'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { trpc, type RouterOutputs } from '@/lib/trpc'

type SetRow = RouterOutputs['sets']['mine'][number]

const SETS_HEADING_ID = 'sets-list-heading'

export const Route = createFileRoute('/_app/sets/')({ component: SetsPage })

function SetsPage() {
  const { user } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const sets = useQuery(trpc.sets.mine.queryOptions())
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.sets.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.library.pathKey() })
  }
  const create = useMutation(trpc.sets.create.mutationOptions({ onSuccess: refresh }))
  const update = useMutation(trpc.sets.update.mutationOptions({ onSuccess: refresh }))
  const remove = useMutation(trpc.sets.delete.mutationOptions({ onSuccess: refresh }))
  const setActive = useMutation(trpc.sets.setActive.mutationOptions({ onSuccess: refresh }))
  const canEdit = (s: SetRow) => (s.scope === 'global' ? user.role === 'admin' : true)

  return (
    <PageBody width="narrow">
      <PageHeader
        title="Sets"
        description="Your library is the sets you switch on, plus every book you've rated, queued or given a status."
        actions={
          <NameDialog
            title="New personal set"
            label="Set name"
            submitLabel="Create set"
            trigger={
              <Button size="sm">
                <Plus className="size-4" /> New set
              </Button>
            }
            onSubmit={(name) => create.mutateAsync({ kind: 'manual', scope: 'personal', name })}
          />
        }
      />
      {/* focusable (tabIndex -1) so focus has somewhere to land after the last row is deleted */}
      <h2 id={SETS_HEADING_ID} tabIndex={-1} className="sr-only rounded-sm outline-none focus-visible:not-sr-only focus-visible:ring-[3px] focus-visible:ring-ring/50">
        Your sets
      </h2>
      <ul aria-labelledby={SETS_HEADING_ID} className="divide-y rounded-lg border">
        {sets.data?.map((s) => (
          <SetRowItem
            key={s.id}
            set={s}
            editable={canEdit(s)}
            onActive={(active) => setActive.mutate({ setId: s.id, active })}
            onRename={(name) => update.mutateAsync({ setId: s.id, patch: { name } })}
            onDelete={(onError) => remove.mutate({ setId: s.id }, { onError })}
          />
        ))}
      </ul>
    </PageBody>
  )
}

function SetRowItem({
  set: s,
  editable,
  onActive,
  onRename,
  onDelete,
}: {
  set: SetRow
  editable: boolean
  onActive: (active: boolean) => void
  onRename: (name: string) => Promise<unknown>
  onDelete: (onError: () => void) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // the dialogs open from the menu, so they have no trigger of their own: closing returns focus to ⋯ (triggerRef);
  // Delete's close focus is ⋯ on Cancel, repointed on confirm because this row (and its ⋯) is about to go
  const focus = useRemovalFocus()
  const switchId = `active-${s.id}`
  return (
    <li className="flex items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4">
      {/* relative + the link's after:inset-0: the whole name-and-badges column (44px+) opens the set */}
      <div className="relative min-w-0 flex-1 py-1">
        <Link
          to="/library"
          search={{ set: s.id }}
          className="block truncate font-medium text-match-parent after:absolute after:inset-0 hover:underline"
          dir="auto"
        >
          {s.name}
        </Link>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Badge variant="outline">{s.scope === 'global' ? 'Household' : 'Personal'}</Badge>
          {s.kind === 'smart' ? <Badge variant="outline">Smart</Badge> : null}
          {s.assignedByAdmin ? <Badge variant="secondary">Assigned by admin</Badge> : null}
        </div>
      </div>
      <label htmlFor={switchId} className="flex min-h-11 shrink-0 items-center gap-2 text-sm">
        <span className="hidden sm:inline">In my library</span>
        <Switch id={switchId} aria-label={`In my library: ${s.name}`} checked={s.active} onCheckedChange={onActive} />
      </label>
      {editable ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button ref={focus.triggerRef} data-set-menu variant="ghost" size="icon" aria-label={`Actions for ${s.name}`}>
                <EllipsisVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <Pencil /> Rename
              </DropdownMenuItem>
              {!s.isDefaultPersonal ? (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    focus.onOpenChange(true)
                    setDeleting(true)
                  }}
                >
                  <Trash2 /> Delete
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <NameDialog
            title="Rename set"
            label="Set name"
            initial={s.name}
            open={renaming}
            onOpenChange={setRenaming}
            returnFocusRef={focus.triggerRef}
            onSubmit={onRename}
          />
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            returnFocusRef={focus.closeFocus}
            title={`Delete “${s.name}”?`}
            description="The books stay in the catalog."
            confirmLabel="Delete set"
            destructive
            onConfirm={() => {
              // the next row's ⋯ (rows without a menu have none, so they are skipped), else the list heading
              focus.retarget('[data-set-menu]', SETS_HEADING_ID)
              onDelete(focus.restore)
            }}
          />
        </>
      ) : (
        <span aria-hidden className="w-9 shrink-0 pointer-coarse:w-11" />
      )}
    </li>
  )
}
