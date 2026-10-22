import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { FetchMetadataDialog } from './fetch-metadata-dialog'
import { useInvalidateBook } from './invalidate'
import { MergeWorkDialog } from './merge-work-dialog'

type WorkDetail = RouterOutputs['catalog']['get']

/** The book's upkeep actions behind one ⋯ button (spec ruling 8); each opens the same dialog its old button did. */
export function BookMoreMenu({ work, isAdmin, extraItems, triggerRef: outerRef }: { work: WorkDetail; isAdmin: boolean; extraItems?: ReactNode; triggerRef?: RefObject<HTMLButtonElement | null> }) {
  const navigate = useNavigate()
  const invalidate = useInvalidateBook()
  const ownRef = useRef<HTMLButtonElement>(null)
  const triggerRef = outerRef ?? ownRef
  const [open, setOpen] = useState<'fetch' | 'merge' | 'delete' | null>(null)
  const del = useMutation(
    trpc.catalog.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Book deleted')
        // Leave the deleted book's page first so its own query is not refetched into a NOT_FOUND.
        void navigate({ to: '/library' }).then(invalidate)
      },
    }),
  )
  const close = (next: boolean) => {
    if (!next) setOpen(null)
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} variant="ghost" size="sm" aria-label="More actions for this book">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen('fetch')}>Fetch metadata…</DropdownMenuItem>
          {extraItems}
          {isAdmin ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setOpen('merge')}>Merge into…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setOpen('delete')}>Delete book…</DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* a page sent back by the bookmarklet reopens the dialog itself, so this one takes `true` as well */}
      <FetchMetadataDialog work={work} open={open === 'fetch'} onOpenChange={(next) => setOpen(next ? 'fetch' : null)} returnFocusRef={triggerRef} />
      {isAdmin ? (
        <>
          <MergeWorkDialog open={open === 'merge'} onOpenChange={close} source={{ id: work.id, title: work.title }} returnFocusRef={triggerRef} />
          <ConfirmDialog
            open={open === 'delete'}
            onOpenChange={close}
            returnFocusRef={triggerRef}
            title={`Delete “${work.title}”?`}
            description="It is deleted for everyone in the household."
            confirmLabel="Delete book"
            destructive
            onConfirm={() => del.mutate({ workId: work.id })}
          />
        </>
      ) : null}
    </>
  )
}
