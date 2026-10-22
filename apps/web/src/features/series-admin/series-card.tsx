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
import { MergeSeriesDialog } from './merge-series-dialog'
import { SeriesNameLanguageDialog } from './series-name-language-dialog'
import { seriesSummary } from './series-admin-state'
import { SplitSeriesDialog } from './split-series-dialog'
import { useSeriesAdminRefresh } from './use-series-admin-refresh'

export type SeriesAdminRow = RouterOutputs['admin']['series']['list']['series'][number]
type SeriesAdminName = SeriesAdminRow['names'][number]

export function SeriesCard({ series }: { series: SeriesAdminRow }) {
  const refresh = useSeriesAdminRefresh()
  const primary = series.names.find((n) => n.primary) ?? series.names[0]
  const title = primary?.name ?? series.name
  const [merging, setMerging] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addLanguage, setAddLanguage] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const addTrigger = useRef<HTMLButtonElement>(null)
  const mergeTrigger = useRef<HTMLButtonElement>(null)
  const facets = useQuery(trpc.catalog.facets.queryOptions())
  // the add dialog shows its own error (a name another series owns), so no second, global toast
  const addName = useMutation(trpc.admin.series.addName.mutationOptions({ meta: { inlineError: true } }))

  function onAdd(name: string): Promise<unknown> {
    setAddError(null)
    return addName.mutateAsync(
      { seriesId: series.id, name, language: addLanguage.trim() === '' ? null : addLanguage.trim() },
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
      <section aria-label={title} className="grid min-w-0 grid-cols-1 gap-3 px-4 md:px-6">
        <div className="grid grid-cols-1 gap-1">
          <h3 className="text-base font-semibold break-words" dir="auto">
            {title}
          </h3>
          <p className="text-sm text-muted-foreground">{seriesSummary(series.bookCount)}</p>
        </div>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {series.names.map((n) => (
            <NameItem key={n.id} series={series} name={n} />
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button ref={mergeTrigger} type="button" variant="outline" size="sm" onClick={() => setMerging(true)}>
            Same series as…
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
        </div>
        <MergeSeriesDialog open={merging} onOpenChange={setMerging} series={series} returnFocusRef={mergeTrigger} />
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
              <Field label="Language" htmlFor={`add-series-name-language-${series.id}`} hint="e.g. en, he">
                <SuggestInput id={`add-series-name-language-${series.id}`} dir="ltr" value={addLanguage} options={facets.data?.languages ?? []} onChange={setAddLanguage} />
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
function NameItem({ series, name }: { series: SeriesAdminRow; name: SeriesAdminName }) {
  const refresh = useSeriesAdminRefresh()
  const trigger = useRef<HTMLButtonElement>(null)
  const [dialog, setDialog] = useState<'rename' | 'language' | 'split' | 'remove' | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const makePrimary = useMutation(
    trpc.admin.series.makePrimary.mutationOptions({
      onSuccess: () => {
        toast.success('Saved')
        refresh()
      },
    }),
  )
  // the rename dialog shows its own error (a name another series owns), so no second, global toast
  const rename = useMutation(trpc.admin.series.renameName.mutationOptions({ meta: { inlineError: true } }))
  const removeName = useMutation(
    trpc.admin.series.removeName.mutationOptions({
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
    <li className="flex max-w-full min-w-0 flex-wrap items-center gap-1">
      <Badge variant="outline" className="h-auto min-h-6 max-w-full min-w-0 shrink text-sm whitespace-normal [overflow-wrap:anywhere]">
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
          <DropdownMenuItem
            onSelect={() => {
              setRenameError(null)
              setDialog('rename')
            }}
          >
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('language')}>Set language…</DropdownMenuItem>
          {series.names.length >= 2 ? <DropdownMenuItem onSelect={() => setDialog('split')}>Split off this name</DropdownMenuItem> : null}
          {!name.primary ? (
            <DropdownMenuItem variant="destructive" onSelect={() => setDialog('remove')}>
              Remove name
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog
        open={dialog === 'rename'}
        onOpenChange={close}
        returnFocusRef={trigger}
        title="Rename"
        label="Name"
        initial={name.name}
        onSubmit={(next) =>
          rename.mutateAsync(
            { nameId: name.id, name: next },
            {
              onSuccess: () => {
                toast.success('Saved')
                refresh()
              },
              onError: (err) => setRenameError(err.message),
            },
          )
        }
        extra={
          renameError !== null ? (
            <p role="alert" className="text-sm text-destructive" dir="auto">
              {renameError}
            </p>
          ) : null
        }
      />
      <SeriesNameLanguageDialog open={dialog === 'language'} onOpenChange={close} name={name} returnFocusRef={trigger} />
      <SplitSeriesDialog open={dialog === 'split'} onOpenChange={close} series={series} name={name} returnFocusRef={trigger} />
      <ConfirmDialog
        open={dialog === 'remove'}
        onOpenChange={close}
        returnFocusRef={trigger}
        title={`Remove “${name.name}”?`}
        description="The series keeps its books and its other names."
        confirmLabel="Remove"
        destructive
        onConfirm={() => removeName.mutate({ nameId: name.id })}
      />
    </li>
  )
}
