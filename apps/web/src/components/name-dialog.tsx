import { useState, type ReactNode, type RefObject, type SubmitEvent } from 'react'
import { returnFocusProps } from '@/components/dialog-focus'
import { DialogPanel } from '@/components/dialog-panel'
import { Field } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface NameDialogProps {
  /** uncontrolled: the element that opens it */
  trigger?: ReactNode
  /** controlled: e.g. opened from a menu item */
  open?: boolean | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
  /** controlled: where focus goes on close (Radix returns it only to its own DialogTrigger), e.g. the menu's button */
  returnFocusRef?: RefObject<HTMLElement | null> | undefined
  title: string
  label: string
  initial?: string
  submitLabel?: string
  /** extra form controls rendered under the name field */
  extra?: ReactNode
  onSubmit: (name: string) => Promise<unknown>
}

/** Small reusable "enter a name" dialog (create set, rename set, save smart set…). */
export function NameDialog({ trigger, open, onOpenChange, returnFocusRef, title, label, initial = '', submitLabel = 'Save', extra, onSubmit }: NameDialogProps) {
  const [innerOpen, setInnerOpen] = useState(false)
  const isOpen = open ?? innerOpen
  const setOpen = (next: boolean) => {
    onOpenChange?.(next)
    if (open === undefined) setInnerOpen(next)
  }
  const [name, setName] = useState(initial)
  const [pending, setPending] = useState(false)

  // reset the field as the dialog opens, during render so the old draft never paints; not when `initial`
  // changes while it is open (a refetch would wipe the typing)
  const [wasOpen, setWasOpen] = useState(isOpen)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) setName(initial)
  }

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    if (name.trim() === '') return
    setPending(true)
    onSubmit(name.trim())
      .then(() => setOpen(false))
      .catch(() => undefined) // the global mutation handler shows the error
      .finally(() => setPending(false))
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {trigger !== undefined ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent bare className="sm:max-w-sm" {...returnFocusProps(returnFocusRef)}>
        <DialogPanel
          title={title}
          onSubmit={submit}
          footer={
            <Button type="submit" disabled={pending || name.trim() === ''}>
              {submitLabel}
            </Button>
          }
        >
          <div className="grid gap-4">
            <Field label={label} htmlFor="name-dialog-input">
              <Input id="name-dialog-input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {extra}
          </div>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}
