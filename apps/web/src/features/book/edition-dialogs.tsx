import { useMutation } from '@tanstack/react-query'
import { Pencil, Plus } from 'lucide-react'
import { useMemo, useState, type SubmitEvent } from 'react'
import { toast } from 'sonner'
import { EditionInput, EditionPatch } from '@mylib/domain'
import { DialogPanel } from '@/components/dialog-panel'
import { showFieldErrors } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { changedFields, fieldErrors, type FieldErrors } from '@/lib/form'
import { trpc } from '@/lib/trpc'
import { EditionFields } from './edition-form'
import { editionFormFromDetail, editionFormToInput, emptyEditionForm, type EditionDetail } from './edition-form-state'
import { useInvalidateBook } from './invalidate'

export function AddEditionDialog({ workId }: { workId: string }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(() => emptyEditionForm('physical'))
  const [errors, setErrors] = useState<FieldErrors>({})
  const invalidate = useInvalidateBook()
  const add = useMutation(
    trpc.catalog.addEdition.mutationOptions({
      onSuccess: () => {
        invalidate()
        setOpen(false)
        toast.success('Edition added')
      },
    }),
  )

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const parsed = EditionInput.safeParse(editionFormToInput(form))
    if (!parsed.success) {
      showFieldErrors(e.currentTarget, fieldErrors(parsed.error), setErrors)
      return
    }
    add.mutate({ workId, edition: parsed.data })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setForm(emptyEditionForm('physical'))
          setErrors({})
        }
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" /> Add edition
        </Button>
      </DialogTrigger>
      <DialogContent bare className="sm:max-w-lg">
        <DialogPanel
          title="Add an edition"
          description="A physical copy, ebook or audiobook of this same book."
          onSubmit={submit}
          footer={
            <Button type="submit" disabled={add.isPending}>
              Add edition
            </Button>
          }
        >
          <EditionFields idPrefix="add-edition" value={form} onChange={setForm} errors={errors} showHolding />
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}

export function EditEditionDialog({ edition }: { edition: EditionDetail }) {
  const initial = useMemo(() => editionFormFromDetail(edition), [edition])
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(initial)
  const [errors, setErrors] = useState<FieldErrors>({})
  const invalidate = useInvalidateBook()
  const update = useMutation(
    trpc.catalog.updateEdition.mutationOptions({
      onSuccess: () => {
        invalidate()
        setOpen(false)
        toast.success('Saved')
      },
    }),
  )

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const changed = changedFields(editionFormToInput(initial), editionFormToInput(form))
    if (Object.keys(changed).length === 0) {
      setOpen(false)
      return
    }
    const parsed = EditionPatch.safeParse(changed)
    if (!parsed.success) {
      showFieldErrors(e.currentTarget, fieldErrors(parsed.error), setErrors)
      return
    }
    update.mutate({ editionId: edition.id, patch: parsed.data })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setForm(initial)
          setErrors({})
        }
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-edition-edit>
          <Pencil className="size-4" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent bare className="sm:max-w-lg">
        <DialogPanel
          title="Edit edition"
          description="Fields you edit are locked against future automatic updates."
          onSubmit={submit}
          footer={
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          }
        >
          <EditionFields idPrefix="edit-edition" value={form} onChange={setForm} errors={errors} provenance={edition.provenance} />
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}
