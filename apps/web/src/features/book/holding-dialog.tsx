import { useMutation } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { toast } from 'sonner'
import type { HoldingAction } from '@mylib/domain'
import { Field } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { emptyToNull } from '@/lib/form'
import { holdingActionLabel, todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useInvalidateBook } from './invalidate'

const notePlaceholder: Record<HoldingAction, string> = {
  no_longer_have: 'e.g. Sold, gave to Dana, lost',
  got_back: 'e.g. Dana returned it',
  returned: 'e.g. Back to the library',
  borrowed_again: 'e.g. City library',
  bought: 'e.g. Bookshop',
}

/** One holding action (No longer have it / Got it back / Returned / …) with a date and an optional note. */
export function HoldingActionDialog({ editionId, action }: { editionId: string; action: HoldingAction }) {
  const invalidate = useInvalidateBook()
  const [open, setOpen] = useState(false)
  const [on, setOn] = useState(todayLocal)
  const [note, setNote] = useState('')
  const change = useMutation(
    trpc.catalog.changeHolding.mutationOptions({
      onSuccess: () => {
        invalidate()
        setOpen(false)
        toast.success('Saved')
      },
    }),
  )

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    change.mutate({ editionId, change: { action, on: on === '' ? todayLocal() : on, note: emptyToNull(note) } })
  }

  const label = holdingActionLabel[action]
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setOn(todayLocal())
          setNote('')
        }
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>Recorded in this copy's history. Your ratings and reading history are kept.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="When" htmlFor={`holding-on-${editionId}`}>
            <Input id={`holding-on-${editionId}`} type="date" value={on} onChange={(e) => setOn(e.target.value)} />
          </Field>
          <Field label="Note" htmlFor={`holding-note-${editionId}`}>
            <Input
              id={`holding-note-${editionId}`}
              dir="auto"
              placeholder={notePlaceholder[action]}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={change.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
