import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { SessionMode } from '@mylib/domain'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { useDebounced } from '@/lib/use-debounced'
import { CheckinCard } from './checkin-card'
import { DateChoice, type DateChoiceValue } from './date-choice'
import { EditionPicker } from './edition-picker'
import { resolveStartEdition } from './start-edition'
import { upNextSuggestion } from './up-next-suggestion'

function BookPicker({ onSelect }: { onSelect: (work: { id: string; title: string }) => void }) {
  const [q, setQ] = useState('')
  const settled = useDebounced(q, 250)
  const results = useQuery({ ...trpc.library.search.queryOptions({ q: settled }), enabled: settled.trim() !== '' })
  return (
    <div className="grid gap-2">
      <SearchInput aria-label="Find a book" placeholder="Search title, author…" value={q} onValueChange={setQ} />
      {results.data && results.data.items.length > 0 ? (
        <ul className="grid gap-1">
          {results.data.items.map((w) => (
            <li key={w.id}>
              <Button type="button" variant="outline" className="w-full justify-start" onClick={() => onSelect(w)}>
                <span dir="auto">{w.title}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function NewBookCard({ onDone }: { onDone: () => void }) {
  const [picked, setPicked] = useState<{ id: string; title: string } | null>(null)
  const [mode, setMode] = useState<SessionMode>('read')
  const [when, setWhen] = useState<DateChoiceValue>({ date: todayLocal(), precision: 'day' })
  const [editionPick, setEditionPick] = useState<string | null>(null)
  // the picked book's editions decide whether to ask "which edition?"
  const work = useQuery({ ...trpc.catalog.get.queryOptions({ workId: picked?.id ?? '' }), enabled: picked !== null })
  const editions = work.data?.editions ?? []
  // #84: the first Up next book is one tap away; picking it goes through the same mode/date/edition step
  const queue = useQuery(trpc.library.queue.queryOptions())
  const suggestion = upNextSuggestion(queue.data ?? [])
  const queryClient = useQueryClient()
  const start = useMutation(
    trpc.sessions.start.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.library.pathKey() })
        await queryClient.invalidateQueries({ queryKey: trpc.series.pathKey() })
        await queryClient.invalidateQueries({ queryKey: trpc.activity.pathKey() })
        onDone()
      },
    }),
  )

  return (
    <CheckinCard title="Started anything new?">
      {picked === null ? (
        <div className="grid gap-2">
          {suggestion ? (
            <Button type="button" variant="secondary" className="w-full justify-start" onClick={() => setPicked({ id: suggestion.id, title: suggestion.title })}>
              <span className="truncate">
                Up next: <bdi>{suggestion.title}</bdi>
              </span>
            </Button>
          ) : null}
          <BookPicker onSelect={setPicked} />
        </div>
      ) : (
        <div className="grid gap-3">
          <p dir="auto">
            <strong>{picked.title}</strong>
          </p>
          <div className="flex gap-2">
            <Button type="button" variant={mode === 'read' ? 'default' : 'outline'} onClick={() => setMode('read')}>
              Reading
            </Button>
            <Button type="button" variant={mode === 'listen' ? 'default' : 'outline'} onClick={() => setMode('listen')}>
              Listening
            </Button>
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Started</span>
            <DateChoice value={when} onChange={setWhen} />
          </div>
          <EditionPicker id="new-book-edition" editions={editions} mode={mode} value={editionPick} onChange={setEditionPick} />
          <Button
            onClick={() =>
              start.mutate({
                workId: picked.id,
                editionId: resolveStartEdition(editions, mode, editionPick),
                mode,
                startedOn: when.date,
                startedPrecision: when.precision,
              })
            }
            disabled={start.isPending || work.isPending}
          >
            Start
          </Button>
        </div>
      )}
      <Button variant="ghost" onClick={onDone}>
        Skip
      </Button>
    </CheckinCard>
  )
}
