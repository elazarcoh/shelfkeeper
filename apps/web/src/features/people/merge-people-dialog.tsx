import { useMutation, useQuery } from '@tanstack/react-query'
import { useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { returnFocusProps } from '@/components/dialog-focus'
import { DialogPanel } from '@/components/dialog-panel'
import { SuggestInput } from '@/components/suggest-input'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog'
import { SearchInput } from '@/components/ui/search-input'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { useDebounced } from '@/lib/use-debounced'
import { mergeDraft } from './people-state'
import { usePeopleRefresh } from './use-people-refresh'

type PersonDetail = RouterOutputs['admin']['people']['get']

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** the person the dialog was opened on */
  person: { id: string; names: { name: string }[] }
  returnFocusRef?: RefObject<HTMLElement | null> | undefined
}

const MAX_BOOKS = 10

/** Step 1 picks the other person, step 2 chooses the primary name and languages. The steps live in the content, so each opening starts fresh. */
export function MergePeopleDialog({ open, onOpenChange, person, returnFocusRef }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent bare className="sm:max-w-lg" {...returnFocusProps(returnFocusRef)}>
        <MergeSteps person={person} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function MergeSteps({ person, onClose }: { person: Props['person']; onClose: () => void }) {
  const [otherId, setOtherId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const settled = useDebounced(q, 250)
  const results = useQuery({ ...trpc.admin.people.list.queryOptions({ q: settled, limit: 20 }), enabled: otherId === null && settled.trim() !== '' })

  if (otherId === null) {
    const others = results.data?.people.filter((p) => p.id !== person.id) ?? []
    return (
      <DialogPanel
        title="Same person as…"
        description="Find the other spelling of this person."
        footer={
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
        }
      >
        <div className="grid grid-cols-1 gap-3">
          <SearchInput aria-label="Find the other person" placeholder="Find by any name…" dir="auto" value={q} onValueChange={setQ} />
          {others.length > 0 ? (
            <ul className="grid grid-cols-1 gap-1">
              {others.map((p) => {
                const label = p.names[0]?.name ?? ''
                return (
                  <li key={p.id} className="flex min-w-0 items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate" dir="auto">
                      {p.names.map((n) => n.name).join(' · ')}
                    </span>
                    <Button size="sm" variant="outline" aria-label={`Pick ${label}`} onClick={() => setOtherId(p.id)}>
                      Pick
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : settled.trim() !== '' && results.data !== undefined ? (
            <p className="text-sm text-muted-foreground">No one else found.</p>
          ) : null}
        </div>
      </DialogPanel>
    )
  }
  return <MergeConfirm personId={person.id} otherId={otherId} onBack={() => setOtherId(null)} onClose={onClose} />
}

/** Loads both people, then starts the form from the merge draft (the state is initialised once, when both are in). */
function MergeConfirm({ personId, otherId, onBack, onClose }: { personId: string; otherId: string; onBack: () => void; onClose: () => void }) {
  const opened = useQuery(trpc.admin.people.get.queryOptions({ personId }))
  const other = useQuery(trpc.admin.people.get.queryOptions({ personId: otherId }))
  if (opened.data === undefined || other.data === undefined) {
    const error = opened.error ?? other.error
    return (
      <DialogPanel
        title="Merge people"
        footer={
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
        }
      >
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </DialogPanel>
    )
  }
  return <MergeForm opened={opened.data} other={other.data} onBack={onBack} onClose={onClose} />
}

function MergeForm({ opened, other, onBack, onClose }: { opened: PersonDetail; other: PersonDetail; onBack: () => void; onClose: () => void }) {
  const refresh = usePeopleRefresh()
  const facets = useQuery(trpc.catalog.facets.queryOptions())
  const [draft, setDraft] = useState(() => mergeDraft(opened, other))
  const names = [...opened.names, ...other.names]
  const merge = useMutation(
    trpc.admin.people.merge.mutationOptions({
      onSuccess: () => {
        toast.success(`Merged into ${names.find((n) => n.id === draft.primaryNameId)?.name ?? ''}`)
        refresh()
        onClose()
      },
    }),
  )

  return (
    <DialogPanel
      title="Merge people"
      footer={
        <>
          <Button variant="outline" disabled={merge.isPending} onClick={onBack}>
            Back
          </Button>
          <Button
            disabled={merge.isPending}
            onClick={() =>
              merge.mutate({
                personId: opened.id,
                otherId: other.id,
                primaryNameId: draft.primaryNameId,
                languages: Object.entries(draft.languages).map(([nameId, language]) => ({ nameId, language })),
              })
            }
          >
            Merge
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <PersonBooks person={opened} />
          <PersonBooks person={other} />
        </div>
        <div role="radiogroup" aria-label="Primary name" className="grid grid-cols-1 gap-2">
          {names.map((n) => (
            <div key={n.id} className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-2">
              <label className="flex min-h-9 min-w-0 items-center gap-2 pointer-coarse:min-h-11">
                <input type="radio" name="primary-name" checked={draft.primaryNameId === n.id} onChange={() => setDraft({ ...draft, primaryNameId: n.id })} />
                <span className="min-w-0 break-words" dir="auto">
                  {n.name}
                </span>
              </label>
              <SuggestInput
                aria-label={`Language of ${n.name}`}
                dir="ltr"
                placeholder="Language"
                value={draft.languages[n.id] ?? ''}
                options={facets.data?.languages ?? []}
                onChange={(v) => setDraft({ ...draft, languages: { ...draft.languages, [n.id]: v.trim() === '' ? null : v } })}
              />
            </div>
          ))}
        </div>
        <p className="text-muted-foreground">You can split a name off again later.</p>
      </div>
    </DialogPanel>
  )
}

function PersonBooks({ person }: { person: PersonDetail }) {
  const shown = person.books.slice(0, MAX_BOOKS)
  const more = Math.max(person.bookCount, person.books.length) - shown.length
  return (
    <div className="grid min-w-0 content-start gap-1">
      <p className="font-medium break-words" dir="auto">
        {person.names.find((n) => n.primary)?.name ?? person.names[0]?.name}
      </p>
      {shown.length === 0 ? <p className="text-muted-foreground">No books</p> : null}
      <ul className="grid gap-0.5 text-muted-foreground">
        {shown.map((b, i) => (
          <li key={`${b.workId}-${String(i)}`} className="break-words">
            <bdi>{b.title}</bdi> · {b.role}
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="text-muted-foreground">and {more} more</p> : null}
    </div>
  )
}
