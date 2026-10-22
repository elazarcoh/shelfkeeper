import { useMutation } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { useEffect, useMemo, useState, type SubmitEvent } from 'react'
import { toast } from 'sonner'
import { WorkPatch } from '@mylib/domain'
import { DialogPanel } from '@/components/dialog-panel'
import { showFieldErrors } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { fieldErrors, type FieldErrors } from '@/lib/form'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { useInvalidateBook } from './invalidate'
import { TitlesList } from './titles-list'
import { WorkFields } from './work-form'
import { withTitlesFrom, workFormFromDetail, workPatchFromForm } from './work-form-state'

export function EditWorkDialog({ work }: { work: RouterOutputs['catalog']['get'] }) {
  const initial = useMemo(() => workFormFromDetail(work), [work])
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(initial)
  const [errors, setErrors] = useState<FieldErrors>({})
  const invalidate = useInvalidateBook()
  // a title changed from the list while the dialog is open: re-seed only the title fields, keep the other edits
  useEffect(() => {
    setForm((f) => withTitlesFrom(f, initial))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.title, initial.subtitle, initial.titleId])
  const update = useMutation(
    trpc.catalog.update.mutationOptions({
      onSuccess: () => {
        invalidate()
        setOpen(false)
        toast.success('Saved')
      },
    }),
  )

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const changed = workPatchFromForm(initial, form)
    if (Object.keys(changed).length === 0) {
      setOpen(false)
      return
    }
    const parsed = WorkPatch.safeParse(changed)
    if (!parsed.success) {
      showFieldErrors(e.currentTarget, fieldErrors(parsed.error), setErrors)
      return
    }
    update.mutate({ workId: work.id, patch: parsed.data })
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
        <Button variant="outline" size="sm">
          <Pencil className="size-4" /> Edit details
        </Button>
      </DialogTrigger>
      <DialogContent bare className="sm:max-w-xl">
        <DialogPanel
          title="Edit book"
          description="Fields you edit are locked (🔒) so future automatic updates leave them alone."
          onSubmit={submit}
          footer={
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          }
        >
          <WorkFields idPrefix="edit-work" value={form} onChange={setForm} errors={errors} provenance={work.provenance} workId={work.id} />
          <div className="mt-4">
            <TitlesList work={work} />
          </div>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}
