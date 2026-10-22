import { useMutation } from '@tanstack/react-query'
import { useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { returnFocusProps } from '@/components/dialog-focus'
import { DialogPanel } from '@/components/dialog-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { trpc } from '@/lib/trpc'
import { usePeopleRefresh } from './use-people-refresh'

interface NameRef {
  id: string
  name: string
  primary: boolean
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  person: { names: NameRef[] }
  /** the name that becomes a person of its own */
  name: NameRef
  returnFocusRef?: RefObject<HTMLElement | null> | undefined
}

/**
 * Splitting off a non-primary name just needs a confirmation; splitting off the primary also asks which remaining name
 * becomes the person's primary. The server may answer with a person it already pruned (a name no book credits), so the
 * result is only toasted, never navigated to.
 */
export function SplitNameDialog({ open, onOpenChange, person, name, returnFocusRef }: Props) {
  const refresh = usePeopleRefresh()
  const split = useMutation(
    trpc.admin.people.splitOff.mutationOptions({
      onSuccess: () => {
        toast.success(`Split off ${name.name}`)
        refresh()
        onOpenChange(false)
      },
    }),
  )
  if (!name.primary) {
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        returnFocusRef={returnFocusRef}
        title={`Split off “${name.name}”?`}
        description="It becomes a separate person, with the books that credit it."
        confirmLabel="Split off"
        onConfirm={() => split.mutate({ nameId: name.id, primaryNameId: null })}
      />
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent bare className="sm:max-w-sm" {...returnFocusProps(returnFocusRef)}>
        <PickPrimary others={person.names.filter((n) => n.id !== name.id)} title={`Split off “${name.name}”`} pending={split.isPending} onSplit={(primaryNameId) => split.mutate({ nameId: name.id, primaryNameId })} />
      </DialogContent>
    </Dialog>
  )
}

/** In the content, so each opening defaults to the first other name. */
function PickPrimary({ others, title, pending, onSplit }: { others: NameRef[]; title: string; pending: boolean; onSplit: (primaryNameId: string | null) => void }) {
  const [primaryId, setPrimaryId] = useState(others[0]?.id ?? null)
  return (
    <DialogPanel
      title={title}
      description="It becomes a separate person. Pick which of the remaining names is the primary one."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button disabled={pending || primaryId === null} onClick={() => onSplit(primaryId)}>
            Split off
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="New primary name" className="grid gap-1 text-sm">
        {others.map((n) => (
          <label key={n.id} className="flex min-h-9 items-center gap-2 pointer-coarse:min-h-11">
            <input type="radio" name="new-primary-name" checked={primaryId === n.id} onChange={() => setPrimaryId(n.id)} />
            <span dir="auto">{n.name}</span>
          </label>
        ))}
      </div>
    </DialogPanel>
  )
}
