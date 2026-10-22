import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Gift } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { DialogPanel } from '@/components/dialog-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import type { WishFields } from '@mylib/domain'
import { trpc } from '@/lib/trpc'
import { WishFieldsEditor } from './wish-fields'
import { fieldsFromDraft, seedDraft, type WishDraft } from './wish-form-state'

/** A wish changes the wishlist, and what the Library and book pages show (wishedBy, hidden-until-owned). */
export function invalidateWishes(queryClient: QueryClient): void {
  for (const key of [trpc.wishlist.pathKey(), trpc.library.pathKey(), trpc.catalog.pathKey()]) {
    void queryClient.invalidateQueries({ queryKey: key })
  }
}

/** "Want it" / "On your wishlist" for one work: the form to add, change or remove my wish. `trigger="edit"` is the wishlist row's small Edit button. */
export function WishDialog({ workId, title, userId, wish, trigger = 'button' }: { workId: string; title: string; userId: string; wish?: WishFields | undefined; trigger?: 'button' | 'edit' }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const wishes = useQuery({ ...trpc.wishlist.forWork.queryOptions({ workId }), enabled: wish === undefined })
  // a row already carries its fields (no request); the book page loads them
  const mine: WishFields | null | undefined = wish ?? (wishes.data === undefined ? undefined : (wishes.data.find((w) => w.userId === userId)?.fields ?? null))
  const [open, setOpen] = useState(false)
  const [edits, setEdits] = useState<WishDraft | null>(null)
  // null until the wish has loaded: Save stays off, so a blank form can never overwrite it
  const draft = seedDraft(edits, mine)

  const upsert = useMutation(
    trpc.wishlist.upsert.mutationOptions({
      onSuccess: () => {
        invalidateWishes(queryClient)
        setOpen(false)
        toast.success('Saved to your wishlist')
      },
      meta: { inlineError: true },
    }),
  )
  const remove = useMutation(
    trpc.wishlist.remove.mutationOptions({
      onSuccess: (res) => {
        invalidateWishes(queryClient)
        setOpen(false)
        toast.success('Removed from your wishlist')
        if (res.workDeleted) void navigate({ to: '/wishlist' })
      },
      meta: { inlineError: true },
    }),
  )

  // reset as it opens, during render
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setEdits(null)
      upsert.reset()
      remove.reset()
    }
  }

  const busy = upsert.isPending || remove.isPending
  const hasWish = mine !== null && mine !== undefined
  const edit = trigger === 'edit'
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={edit ? 'outline' : hasWish ? 'secondary' : 'default'} size={edit ? 'sm' : 'default'} className="pointer-coarse:min-h-11">
          {edit ? null : <Gift className="size-4" />}
          {edit ? 'Edit' : hasWish ? 'On your wishlist' : 'Want it'}
        </Button>
      </DialogTrigger>
      <DialogContent bare className="sm:max-w-sm">
        <DialogPanel
          title={hasWish ? 'On your wishlist' : 'Want it'}
          description={
            <span className="block break-words text-match-parent" dir="auto">
              {title}
            </span>
          }
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy && draft !== null) upsert.mutate({ workId, ...fieldsFromDraft(draft) })
          }}
          footer={
            <>
              {hasWish ? (
                <Button type="button" variant="outline" disabled={busy} onClick={() => remove.mutate({ workId })}>
                  Remove
                </Button>
              ) : null}
              <Button type="submit" disabled={busy || draft === null}>
                Save
              </Button>
            </>
          }
        >
          {draft !== null ? (
            <WishFieldsEditor draft={draft} onChange={setEdits} />
          ) : wishes.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {wishes.error.message}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {upsert.error || remove.error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {(upsert.error ?? remove.error)?.message}
            </p>
          ) : null}
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}
