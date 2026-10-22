import { useMutation } from '@tanstack/react-query'
import { EllipsisVertical, Plus } from 'lucide-react'
import { useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { returnFocusProps } from '@/components/dialog-focus'
import { DialogPanel } from '@/components/dialog-panel'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { languageName } from '@/lib/format'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { useInvalidateBook } from './invalidate'

type WorkDetail = RouterOutputs['catalog']['get']
type TitleRow = WorkDetail['titles'][number]

const OTHER = 'other'

/** The select's value for a stored language: English and Hebrew by code, anything else (or unknown) is "Other…". */
const languageChoice = (language: string | null): string => (language === 'en' || language === 'he' ? language : OTHER)

const rowLanguage = (t: TitleRow): string => (t.language === null ? 'Unknown language' : languageName(t.language))

/** The book's titles, one per language, inside the edit dialog (#145). */
export function TitlesList({ work }: { work: WorkDetail }) {
  const [adding, setAdding] = useState(false)
  const addTrigger = useRef<HTMLButtonElement>(null)
  return (
    <section className="grid grid-cols-1 gap-2" aria-label="Titles in other languages">
      <h3 className="text-sm font-medium">Titles</h3>
      <ul className="grid grid-cols-1 gap-2">
        {work.titles.map((t) => (
          <TitleItem key={t.id} work={work} row={t} />
        ))}
      </ul>
      <div>
        <Button ref={addTrigger} type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> Add a title in another language
        </Button>
      </div>
      <TitleDialog open={adding} onOpenChange={setAdding} workId={work.id} returnFocusRef={addTrigger} />
    </section>
  )
}

function TitleItem({ work, row }: { work: WorkDetail; row: TitleRow }) {
  const invalidate = useInvalidateBook()
  const trigger = useRef<HTMLButtonElement>(null)
  const [dialog, setDialog] = useState<'edit' | 'remove' | null>(null)
  const [newPrimaryId, setNewPrimaryId] = useState('')
  const others = work.titles.filter((t) => t.id !== row.id)
  const done = (message: string) => () => {
    toast.success(message)
    invalidate()
  }
  const makePrimary = useMutation(trpc.catalog.titles.makePrimary.mutationOptions({ onSuccess: done('Saved') }))
  const remove = useMutation(trpc.catalog.titles.remove.mutationOptions({ onSuccess: done('Removed') }))
  const close = (open: boolean) => {
    if (!open) setDialog(null)
  }

  return (
    <li className="flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="outline">{rowLanguage(row)}</Badge>
          {row.primary ? <Badge variant="secondary">Primary</Badge> : null}
        </div>
        <p className="mt-1 break-words" dir="auto">
          {row.title}
        </p>
        {row.subtitle !== null ? (
          <p className="text-sm break-words text-muted-foreground" dir="auto">
            {row.subtitle}
          </p>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} type="button" variant="ghost" size="icon" aria-label={`Actions for ${row.title}`}>
            <EllipsisVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDialog('edit')}>Edit…</DropdownMenuItem>
          {!row.primary ? <DropdownMenuItem disabled={makePrimary.isPending} onSelect={() => makePrimary.mutate({ titleId: row.id })}>Make primary</DropdownMenuItem> : null}
          {others.length > 0 ? (
            <DropdownMenuItem
              variant="destructive"
              disabled={remove.isPending}
              onSelect={() => {
                setNewPrimaryId(others[0]?.id ?? '')
                setDialog('remove')
              }}
            >
              Remove
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <TitleDialog open={dialog === 'edit'} onOpenChange={close} workId={work.id} row={row} returnFocusRef={trigger} />
      <ConfirmDialog
        open={dialog === 'remove'}
        onOpenChange={close}
        returnFocusRef={trigger}
        title={`Remove “${row.title}”?`}
        description={
          row.primary ? (
            <span className="grid grid-cols-1 gap-2">
              <span>This is the primary title. Choose the one that takes over.</span>
              <NativeSelect aria-label="New primary" value={newPrimaryId} onChange={(e) => setNewPrimaryId(e.target.value)}>
                {others.map((t) => (
                  <option key={t.id} value={t.id}>
                    {rowLanguage(t)}: {t.title}
                  </option>
                ))}
              </NativeSelect>
            </span>
          ) : undefined
        }
        confirmLabel="Remove"
        destructive
        onConfirm={() => remove.mutate({ titleId: row.id, newPrimaryId: row.primary ? newPrimaryId : null })}
      />
    </li>
  )
}

interface TitleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workId: string
  /** given: edit this row; absent: add a new one */
  row?: TitleRow
  returnFocusRef?: RefObject<HTMLElement | null> | undefined
}

/** The form lives in the content, so each opening starts from the row's stored values. */
function TitleDialog({ open, onOpenChange, workId, row, returnFocusRef }: TitleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent bare className="sm:max-w-md" {...returnFocusProps(returnFocusRef)}>
        <TitleForm workId={workId} row={row} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function TitleForm({ workId, row, onClose }: { workId: string; row: TitleRow | undefined; onClose: () => void }) {
  const invalidate = useInvalidateBook()
  const [choice, setChoice] = useState(row === undefined ? 'en' : languageChoice(row.language))
  const [other, setOther] = useState(row !== undefined && languageChoice(row.language) === OTHER ? (row.language ?? '') : '')
  const [title, setTitle] = useState(row?.title ?? '')
  const [subtitle, setSubtitle] = useState(row?.subtitle ?? '')
  const onSuccess = () => {
    toast.success('Saved')
    invalidate()
    onClose()
  }
  const add = useMutation(trpc.catalog.titles.add.mutationOptions({ onSuccess }))
  const update = useMutation(trpc.catalog.titles.update.mutationOptions({ onSuccess }))
  const language = choice === OTHER ? other.trim() : choice

  return (
    <DialogPanel
      title={row === undefined ? 'Add a title' : 'Edit title'}
      onSubmit={(e) => {
        e.preventDefault()
        // this form sits inside the edit-book form's React tree: its submit must not save that one too
        e.stopPropagation()
        const sub = subtitle.trim() === '' ? null : subtitle.trim()
        if (row === undefined) add.mutate({ workId, language, title, subtitle: sub })
        else update.mutate({ titleId: row.id, language, title, subtitle: sub })
      }}
      footer={
        <Button type="submit" disabled={add.isPending || update.isPending}>
          Save
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label="Language" htmlFor="title-language">
          <NativeSelect id="title-language" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="en">English</option>
            <option value="he">Hebrew</option>
            <option value={OTHER}>Other…</option>
          </NativeSelect>
        </Field>
        {choice === OTHER ? (
          <Field label="Language code" htmlFor="title-language-other" hint="e.g. fr, ru. Leave empty when unknown.">
            <Input id="title-language-other" dir="ltr" value={other} onChange={(e) => setOther(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Title" htmlFor="title-title">
          <Input id="title-title" dir="auto" required value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Subtitle" htmlFor="title-subtitle">
          <Input id="title-subtitle" dir="auto" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
        </Field>
      </div>
    </DialogPanel>
  )
}
