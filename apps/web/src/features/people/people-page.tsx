import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { LoadMore } from '@/components/load-more'
import { EmptyState } from '@/components/page'
import { SearchInput } from '@/components/ui/search-input'
import { trpc } from '@/lib/trpc'
import { useDebounced } from '@/lib/use-debounced'
import { PersonCard } from './person-card'

const PAGE = 100

export function PeoplePage() {
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const debounced = useDebounced(q, 250)
  const list = useQuery({ ...trpc.admin.people.list.queryOptions({ q: debounced, limit }), placeholderData: keepPreviousData })

  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="max-w-prose text-sm text-muted-foreground">Authors, translators and narrators. Mark two as the same person when one is written in two languages.</p>
      <SearchInput
        aria-label="Find a person"
        placeholder="Find by any name…"
        dir="auto"
        value={q}
        onValueChange={(v) => {
          setQ(v)
          setLimit(PAGE)
        }}
        wrapperClassName="max-w-md"
      />
      {list.isPending ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {list.error ? (
        <p role="alert" className="text-sm text-destructive">
          {list.error.message}
        </p>
      ) : null}
      {list.data ? (
        list.data.people.length === 0 ? (
          <EmptyState title="No one found." />
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {list.data.people.map((p) => (
              <PersonCard key={p.id} person={p} />
            ))}
          </div>
        )
      ) : null}
      {list.data?.more ? <LoadMore loading={list.isFetching} failed={list.isError} onMore={() => setLimit((l) => l + PAGE)} /> : null}
    </div>
  )
}
