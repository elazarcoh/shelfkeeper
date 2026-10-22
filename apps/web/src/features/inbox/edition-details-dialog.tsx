import { useState, type SubmitEvent } from 'react'
import { EditionInput, type ExternalItem } from '@mylib/domain'
import { DialogPanel } from '@/components/dialog-panel'
import { showFieldErrors } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { EditionFields } from '@/features/book/edition-form'
import { editionFormToInput } from '@/features/book/edition-form-state'
import { fieldErrors, type FieldErrors } from '@/lib/form'
import { detailsForm, type DetailsHolding } from './edition-details'

/**
 * "Details…": add the item to an existing book through the full Add edition form, filled in from the item (#121).
 * It closes only once the add succeeded; on a refusal the person's input stays (the error shows as a toast).
 */
export function EditionDetailsDialog({
  bookTitle,
  item,
  holding,
  busy,
  onAdd,
}: {
  bookTitle: string
  item: ExternalItem
  holding: DetailsHolding
  busy: boolean
  onAdd: (edition: EditionInput) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(() => detailsForm(item, holding))
  const [errors, setErrors] = useState<FieldErrors>({})

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const parsed = EditionInput.safeParse(editionFormToInput(form))
    if (!parsed.success) {
      showFieldErrors(e.currentTarget, fieldErrors(parsed.error), setErrors)
      return
    }
    onAdd(parsed.data).then(
      () => setOpen(false),
      () => undefined,
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // the item may have changed since (a corrected volume, a linked page)
          setForm(detailsForm(item, holding))
          setErrors({})
        }
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" disabled={busy}>
          Details…
        </Button>
      </DialogTrigger>
      <DialogContent bare className="sm:max-w-lg">
        <DialogPanel
          title={
            <>
              Add to <bdi>{bookTitle}</bdi>
            </>
          }
          description="A new edition of this book, as you describe it. Fields you change are locked against future automatic updates."
          onSubmit={submit}
          footer={
            <Button type="submit" disabled={busy}>
              Add edition
            </Button>
          }
        >
          <EditionFields idPrefix="inbox-details" value={form} onChange={setForm} errors={errors} showHolding={holding !== null} />
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}
