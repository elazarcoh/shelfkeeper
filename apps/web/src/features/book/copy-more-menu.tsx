import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useRemovalFocus } from '@/components/removal-focus'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { CoverDialog } from './cover-dialog'
import type { EditionDetail } from './edition-form-state'
import { FetchMetadataDialog } from './fetch-metadata-dialog'
import { EDITIONS_HEADING_ID, WORK_TITLE_ID } from './ids'
import { useInvalidateBook } from './invalidate'

type WorkDetail = RouterOutputs['catalog']['get']

/** One copy's upkeep actions behind a ⋯ button; its holding actions and Edit stay on the card. */
export function CopyMoreMenu({ work, edition, canSplit, canDelete }: { work: WorkDetail; edition: EditionDetail; canSplit: boolean; canDelete: boolean }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const invalidate = useInvalidateBook()
  // the ⋯ button is the removal-focus trigger: Cancel returns to it, a confirmed delete moves on to the next card
  const deleteFocus = useRemovalFocus()
  const triggerRef = deleteFocus.triggerRef
  const [open, setOpen] = useState<'fetch' | 'cover' | 'split' | 'delete' | null>(null)
  const split = useMutation(
    trpc.catalog.splitEdition.mutationOptions({
      onSuccess: async ({ workId }) => {
        invalidate()
        toast.success('Moved to a new book')
        // load the new book first so its title is on the page when the navigation ends, then focus it
        await queryClient.query(trpc.catalog.get.queryOptions({ workId })).catch(() => undefined)
        await navigate({ to: '/books/$workId', params: { workId } })
        requestAnimationFrame(() => document.getElementById(WORK_TITLE_ID)?.focus())
      },
    }),
  )
  const remove = useMutation(
    trpc.catalog.deleteEdition.mutationOptions({
      onSuccess: () => {
        invalidate()
        toast.success('Edition deleted')
      },
    }),
  )
  const close = (next: boolean) => {
    if (!next) setOpen(null)
  }
  return (
    <>
      <DropdownMenu onOpenChange={deleteFocus.onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} variant="ghost" size="sm" aria-label="More actions for this copy">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen('fetch')}>Fetch metadata…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen('cover')}>Set cover…</DropdownMenuItem>
          {canSplit || canDelete ? <DropdownMenuSeparator /> : null}
          {canSplit ? <DropdownMenuItem onSelect={() => setOpen('split')}>Split into new book…</DropdownMenuItem> : null}
          {canDelete ? <DropdownMenuItem onSelect={() => setOpen('delete')}>Delete (mistake)…</DropdownMenuItem> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* a page sent back by the bookmarklet reopens the dialog itself, so this one takes `true` as well */}
      <FetchMetadataDialog work={work} copy={edition} open={open === 'fetch'} onOpenChange={(next) => setOpen(next ? 'fetch' : null)} returnFocusRef={triggerRef} />
      <CoverDialog target={{ kind: 'edition', editionId: edition.id }} open={open === 'cover'} onOpenChange={close} returnFocusRef={triggerRef} />
      {canSplit ? (
        <ConfirmDialog
          open={open === 'split'}
          onOpenChange={close}
          returnFocusRef={triggerRef}
          title="Move this edition into a new, separate book?"
          confirmLabel="Split into new book"
          // on success the page moves to the new book and focuses its title (split's onSuccess)
          onConfirm={() => split.mutate({ editionId: edition.id })}
        />
      ) : null}
      {canDelete ? (
        <ConfirmDialog
          open={open === 'delete'}
          onOpenChange={(next) => {
            deleteFocus.onOpenChange(next)
            close(next)
          }}
          returnFocusRef={deleteFocus.closeFocus}
          title="Delete this edition as a mistake?"
          description='Its history is deleted too. To record a lost copy, use "No longer have it".'
          confirmLabel="Delete edition"
          destructive
          onConfirm={() => {
            // this card goes: focus the next card's Edit, else the Editions heading
            deleteFocus.retarget('[data-edition-edit]', EDITIONS_HEADING_ID)
            remove.mutate({ editionId: edition.id }, { onError: deleteFocus.restore })
          }}
        />
      ) : null}
    </>
  )
}
