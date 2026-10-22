import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { absPushFieldLabel, absPushFields, type AbsPushField } from '@mylib/domain'
import { EmptyState } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { trpc } from '@/lib/trpc'
import { effectiveDiffs, isRunning, listedResults, resultLine, sendable, watchedRun, type PushResult, type PushRow } from './abs-push-state'

const dash = (v: string) => (v === '' ? '—' : v)

function toggleSet<T>(set: ReadonlySet<T>, v: T, on: boolean): Set<T> {
  const next = new Set(set)
  if (on) next.add(v)
  else next.delete(v)
  return next
}

export function AbsPushPanel({ showIgnored }: { showIgnored: boolean }) {
  const queryClient = useQueryClient()
  const listOptions = trpc.admin.absPush.list.queryOptions({ showIgnored })
  const list = useQuery(listOptions)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [unticked, setUnticked] = useState<Map<string, Set<AbsPushField>>>(new Map())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [startedRun, setStartedRun] = useState<string | null>(null)

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.admin.absPush.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.admin.health.pathKey() })
  }

  // a page reload keeps showing a run that is still going
  const listed = list.data?.run
  const runId = watchedRun(startedRun, listed)
  // remember a run found running, so its result still shows when it ends
  useEffect(() => {
    if (runId !== null && startedRun === null) setStartedRun(runId)
  }, [runId, startedRun])
  const run = useQuery({
    ...trpc.admin.absPush.run.queryOptions({ runId: runId ?? '' }),
    enabled: runId !== null,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  })
  const running = isRunning(runId, run.data, run.isError)
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !running) refreshAll()
    wasRunning.current = running
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  const setFields = useMutation(
    trpc.admin.absPush.setFields.mutationOptions({
      onMutate: async ({ fields }) => {
        await queryClient.cancelQueries({ queryKey: listOptions.queryKey })
        const before = queryClient.getQueryData(listOptions.queryKey)
        queryClient.setQueryData(listOptions.queryKey, (old) => (old ? { ...old, fields } : old))
        return { before }
      },
      onError: (e, _v, ctx) => {
        if (ctx?.before) queryClient.setQueryData(listOptions.queryKey, ctx.before)
        toast.error(e.message)
      },
      onSettled: () => void queryClient.invalidateQueries({ queryKey: listOptions.queryKey }),
    }),
  )
  const send = useMutation(
    trpc.admin.absPush.send.mutationOptions({
      onSuccess: ({ runId: id }) => setStartedRun(id),
      onError: (e) => toast.error(e.message),
    }),
  )
  const ignore = useMutation(trpc.admin.health.ignore.mutationOptions({ onSuccess: refreshAll, onError: (e) => toast.error(e.message) }))
  const unignore = useMutation(trpc.admin.health.unignore.mutationOptions({ onSuccess: refreshAll, onError: (e) => toast.error(e.message) }))

  if (list.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {list.error.message}
      </p>
    )
  }
  if (!list.data) return <p className="text-sm text-muted-foreground">Loading…</p>

  const { rows, lastSyncAt } = list.data
  const globalFields = list.data.fields
  const books = sendable(rows, globalFields, excluded, unticked)
  const busy = ignore.isPending || unignore.isPending

  function toggleField(field: AbsPushField, on: boolean) {
    setFields.mutate({ fields: absPushFields.filter((f) => (f === field ? on : globalFields.includes(f))) })
  }
  function toggleBookField(id: string, field: AbsPushField, on: boolean) {
    setUnticked((m) => new Map(m).set(id, toggleSet(m.get(id) ?? new Set(), field, !on)))
  }

  const finished = run.data && run.data.status !== 'running' ? run.data : null
  const titleOf = (r: PushResult) => (r.title === r.sourceItemId ? (rows.find((x) => x.sourceItemId === r.sourceItemId)?.title ?? 'A book') : r.title)

  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-sm text-muted-foreground">
        Audiobookshelf last synced {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : 'never'} ·{' '}
        <Link to="/admin/sources" className="underline">
          Sync now in Sources
        </Link>
      </p>
      <fieldset className="grid grid-cols-1 gap-1 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-medium">Fields to send</legend>
        {absPushFields.map((f) => (
          <div key={f} className="flex min-h-11 items-center gap-2">
            <Checkbox id={`abs-field-${f}`} checked={globalFields.includes(f)} onCheckedChange={(v) => toggleField(f, v === true)} />
            <Label htmlFor={`abs-field-${f}`}>{absPushFieldLabel[f]}</Label>
          </div>
        ))}
      </fieldset>

      {running ? (
        <p role="status" className="text-sm">
          {run.data ? `${String(run.data.results.length)} of ${String(run.data.request.length)}…` : 'Sending…'}
        </p>
      ) : null}
      {run.isError ? (
        <p role="alert" dir="auto" className="text-sm text-destructive">
          {run.error.message}
        </p>
      ) : null}
      {finished ? (
        <div role="status" className="grid gap-1 text-sm">
          <p className="font-medium">{resultLine(finished.results)}</p>
          {finished.error ? <p dir="auto" className="text-destructive">{finished.error}</p> : null}
          <ul className="grid gap-1">
            {listedResults(finished.results)
              .map((r) => (
                <li key={r.sourceItemId}>
                  <span dir="auto" className="font-medium">
                    {titleOf(r)}
                  </span>{' '}
                  <span dir="auto" className={r.outcome === 'sent' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}>{r.outcome === 'not_sent' ? 'not sent' : (r.message ?? r.outcome)}</span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      {showIgnored ? null : (
      <div>
        <Button disabled={books.length === 0 || running || send.isPending} onClick={() => send.mutate({ books })}>
          {`Send ${String(books.length)} ${books.length === 1 ? 'book' : 'books'}`}
        </Button>
      </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title={showIgnored ? 'Nothing ignored here.' : 'Nothing to fix here.'} />
      ) : (
        <ul aria-label="Out of sync with Audiobookshelf" className="grid grid-cols-1 gap-2">
          {rows.map((row) => (
            <PushRowItem
              key={row.sourceItemId}
              row={row}
              globalFields={globalFields}
              included={!excluded.has(row.sourceItemId)}
              unticked={unticked.get(row.sourceItemId)}
              expanded={open.has(row.sourceItemId)}
              ignored={showIgnored}
              busy={busy}
              onInclude={(on) => setExcluded((s) => toggleSet(s, row.sourceItemId, !on))}
              onExpand={() => setOpen((s) => toggleSet(s, row.sourceItemId, !s.has(row.sourceItemId)))}
              onField={(f, on) => toggleBookField(row.sourceItemId, f, on)}
              onIgnore={() => {
                const subject = { check: 'abs_out_of_sync', subjectKey: row.sourceItemId } as const
                if (showIgnored) unignore.mutate(subject)
                else ignore.mutate(subject)
              }}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function PushRowItem({
  row,
  globalFields,
  included,
  unticked,
  expanded,
  ignored,
  busy,
  onInclude,
  onExpand,
  onField,
  onIgnore,
}: {
  row: PushRow
  globalFields: readonly AbsPushField[]
  included: boolean
  unticked: Set<AbsPushField> | undefined
  expanded: boolean
  ignored: boolean
  busy: boolean
  onInclude: (on: boolean) => void
  onExpand: () => void
  onField: (f: AbsPushField, on: boolean) => void
  onIgnore: () => void
}) {
  const sendableHere = effectiveDiffs(row, globalFields, unticked).length > 0
  const id = `abs-row-${row.sourceItemId}`
  return (
    <li className={`flex min-w-0 flex-col gap-2 rounded-lg border p-3 ${sendableHere ? '' : 'opacity-60'}`}>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Checkbox id={id} aria-label={`Include ${row.title}`} checked={included && sendableHere} disabled={!sendableHere} onCheckedChange={(v) => onInclude(v === true)} />
          <Link to="/books/$workId" params={{ workId: row.workId }} className="truncate font-medium hover:underline" dir="auto">
            {row.title}
          </Link>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="min-h-11" aria-expanded={expanded} onClick={onExpand}>
            Fields…
          </Button>
          <Button size="sm" variant="ghost" className="min-h-11" disabled={busy} onClick={onIgnore}>
            {ignored ? 'Unignore' : 'Ignore'}
          </Button>
        </div>
      </div>
      <ul className="grid gap-1 text-sm">
        {row.diffs.map((d) => (
          <li key={d.field} className={globalFields.includes(d.field) ? '' : 'text-muted-foreground'}>
            <span className="font-medium">{absPushFieldLabel[d.field]}:</span> <span dir="auto">{dash(d.from)}</span> → <span dir="auto">{dash(d.to)}</span>
          </li>
        ))}
      </ul>
      {expanded ? (
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-3">
          {row.diffs.map((d) => (
            <div key={d.field} className="flex min-h-11 items-center gap-2">
              <Checkbox
                id={`${id}-${d.field}`}
                checked={globalFields.includes(d.field) && !(unticked?.has(d.field) ?? false)}
                disabled={!globalFields.includes(d.field)}
                onCheckedChange={(v) => onField(d.field, v === true)}
              />
              <Label htmlFor={`${id}-${d.field}`}>{absPushFieldLabel[d.field]}</Label>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  )
}
