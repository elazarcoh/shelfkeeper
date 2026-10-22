import { useMutation, useQuery } from '@tanstack/react-query'
import { useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { returnFocusProps } from '@/components/dialog-focus'
import { DialogPanel } from '@/components/dialog-panel'
import { Field } from '@/components/field'
import { SuggestInput } from '@/components/suggest-input'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { trpc } from '@/lib/trpc'
import { usePeopleRefresh } from './use-people-refresh'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: { id: string; name: string; language: string | null }
  returnFocusRef?: RefObject<HTMLElement | null> | undefined
}

/** The form lives in the content, so each opening starts from the name's current language. */
export function NameLanguageDialog({ open, onOpenChange, name, returnFocusRef }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent bare className="sm:max-w-sm" {...returnFocusProps(returnFocusRef)}>
        <LanguageForm name={name} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function LanguageForm({ name, onClose }: { name: Props['name']; onClose: () => void }) {
  const refresh = usePeopleRefresh()
  const facets = useQuery(trpc.catalog.facets.queryOptions())
  const [language, setLanguage] = useState(name.language ?? '')
  const save = useMutation(
    trpc.admin.people.setLanguage.mutationOptions({
      onSuccess: () => {
        toast.success('Saved')
        refresh()
        onClose()
      },
    }),
  )
  return (
    <DialogPanel
      title={`Language of “${name.name}”`}
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({ nameId: name.id, language: language.trim() === '' ? null : language.trim() })
      }}
      footer={
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
      }
    >
      <Field label="Language" htmlFor="name-language-input" hint="e.g. en, he. Leave empty when unknown.">
        <SuggestInput id="name-language-input" dir="ltr" value={language} options={facets.data?.languages ?? []} onChange={setLanguage} />
      </Field>
    </DialogPanel>
  )
}
