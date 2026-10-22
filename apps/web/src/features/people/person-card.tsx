import { useMutation, useQuery } from '@tanstack/react-query'
import { EllipsisVertical } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Field } from '@/components/field'
import { NameDialog } from '@/components/name-dialog'
import { SuggestInput } from '@/components/suggest-input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { languageName } from '@/lib/format'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { MergePeopleDialog } from './merge-people-dialog'
import { NameLanguageDialog } from './name-language-dialog'
import { peopleSummary } from './people-state'
import { SplitNameDialog } from './split-name-dialog'
import { usePeopleRefresh } from './use-people-refresh'

export type PersonRow = RouterOutputs['admin']['people']['list']['people'][number]
type PersonName = PersonRow['names'][number]

export function PersonCard({ person }: { person: PersonRow }) {
  const refresh = usePeopleRefresh()
  const primary = person.names.find((n) => n.primary) ?? person.names[0]
  const title = primary?.name ?? ''
  const [merging, setMerging] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addLanguage, setAddLanguage] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const addTrigger = useRef<HTMLButtonElement>(null)
  const mergeTrigger = useRef<HTMLButtonElement>(null)
  const facets = useQuery(trpc.catalog.facets.queryOptions())
  // the add dialog shows its own error (a name that already belongs to someone else), so no second, global toast
  const addName = useMutation(trpc.admin.people.addName.mutationOptions({ meta: { inlineError: true } }))
  const remove = useMutation(
    trpc.admin.people.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Deleted')
        refresh()
      },
    }),
  )
  const hasBooks = person.authorOf + person.translatorOf + person.narratorOf + person.illustratorOf > 0

  function onAdd(name: string): Promise<unknown> {
    setAddError(null)
    return addName.mutateAsync(
      { personId: person.id, name, language: addLanguage.trim() === '' ? null : addLanguage.trim() },
      {
        onSuccess: () => {
          toast.success('Name added')
          refresh()
        },
        onError: (err) => setAddError(err.message),
      },
    )
  }

  return (
    <Card>
      <section aria-label={title} className="grid grid-cols-1 gap-3 px-4 md:px-6">
        <div className="grid gap-1">
          <h3 className="text-base font-semibold break-words" dir="auto">
            {title}
          </h3>
          <p className="text-sm text-muted-foreground">{peopleSummary(person)}</p>
        </div>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {person.names.map((n) => (
            <NameItem key={n.id} person={person} name={n} />
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button ref={mergeTrigger} type="button" variant="outline" size="sm" onClick={() => setMerging(true)}>
            Same person as…
          </Button>
          <Button
            ref={addTrigger}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setAddError(null)
              setAddLanguage('')
              setAdding(true)
            }}
          >
            Add a name
          </Button>
          {!hasBooks ? (
            <ConfirmDialog
              title={`Delete ${title}?`}
              confirmLabel="Delete"
              destructive
              onConfirm={() => remove.mutate({ personId: person.id })}
              trigger={
                <Button type="button" variant="outline" size="sm">
                  Delete
                </Button>
              }
            />
          ) : null}
        </div>
        <MergePeopleDialog open={merging} onOpenChange={setMerging} person={person} returnFocusRef={mergeTrigger} />
        <NameDialog
          open={adding}
          onOpenChange={setAdding}
          returnFocusRef={addTrigger}
          title="Add a name"
          label="Name"
          submitLabel="Add"
          onSubmit={onAdd}
          extra={
            <>
              <Field label="Language" htmlFor={`add-name-language-${person.id}`} hint="e.g. en, he">
                <SuggestInput id={`add-name-language-${person.id}`} dir="ltr" value={addLanguage} options={facets.data?.languages ?? []} onChange={setAddLanguage} />
              </Field>
              {addError !== null ? (
                <p role="alert" className="text-sm text-destructive" dir="auto">
                  {addError}
                </p>
              ) : null}
            </>
          }
        />
      </section>
    </Card>
  )
}

/** One name as a badge, with its ⋯ menu; the dialogs the menu opens are controlled from here. */
function NameItem({ person, name }: { person: PersonRow; name: PersonName }) {
  const refresh = usePeopleRefresh()
  const trigger = useRef<HTMLButtonElement>(null)
  const [dialog, setDialog] = useState<'language' | 'split' | 'remove' | null>(null)
  const makePrimary = useMutation(
    trpc.admin.people.makePrimary.mutationOptions({
      onSuccess: () => {
        toast.success('Saved')
        refresh()
      },
    }),
  )
  const removeName = useMutation(
    trpc.admin.people.removeName.mutationOptions({
      onSuccess: () => {
        toast.success('Removed')
        refresh()
      },
    }),
  )
  const close = (open: boolean) => {
    if (!open) setDialog(null)
  }

  return (
    <li className="flex items-center gap-1">
      <Badge variant="outline" className="h-6 text-sm">
        <bdi>{name.name}</bdi>
        {name.language !== null ? <> · {languageName(name.language)}</> : null}
      </Badge>
      {name.primary ? <Badge variant="secondary">Primary</Badge> : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} type="button" variant="ghost" size="icon" aria-label={`Actions for ${name.name}`}>
            <EllipsisVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!name.primary ? <DropdownMenuItem onSelect={() => makePrimary.mutate({ nameId: name.id })}>Make primary</DropdownMenuItem> : null}
          <DropdownMenuItem onSelect={() => setDialog('language')}>Set language…</DropdownMenuItem>
          {person.names.length >= 2 ? <DropdownMenuItem onSelect={() => setDialog('split')}>Split off this name</DropdownMenuItem> : null}
          {!name.primary ? (
            <DropdownMenuItem variant="destructive" onSelect={() => setDialog('remove')}>
              Remove name
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <NameLanguageDialog open={dialog === 'language'} onOpenChange={close} name={name} returnFocusRef={trigger} />
      <SplitNameDialog open={dialog === 'split'} onOpenChange={close} person={person} name={name} returnFocusRef={trigger} />
      <ConfirmDialog
        open={dialog === 'remove'}
        onOpenChange={close}
        returnFocusRef={trigger}
        title={`Remove “${name.name}”?`}
        description="Books crediting it keep this person and show another of their names."
        confirmLabel="Remove"
        destructive
        onConfirm={() => removeName.mutate({ nameId: name.id })}
      />
    </li>
  )
}
