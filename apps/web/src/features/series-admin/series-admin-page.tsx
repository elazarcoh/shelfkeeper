import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { LoadMore } from '@/components/load-more'
import { EmptyState } from '@/components/page'
import { SearchInput } from '@/components/ui/search-input'
import { trpc } from '@/lib/trpc'
import { useDebounced } from '@/lib/use-debounced'
import { SeriesCard } from './series-card'

const PAGE = 100

export function SeriesAdminPage() {
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const debounced = useDebounced(q, 250)
  const list = useQuery({ ...trpc.admin.series.list.queryOptions({ q: debounced, limit }), placeholderData: keepPreviousData })

  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="max-w-prose text-sm text-muted-foreground">Every series, under each name it goes by. Mark two as the same series when one is written in two languages.</p>
      <SearchInput
        aria-label="Find a series"
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
        list.data.series.length === 0 ? (
          <EmptyState title="No series found." />
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {list.data.series.map((s) => (
              <SeriesCard key={s.id} series={s} />
            ))}
          </div>
        )
      ) : null}
      {list.data?.more ? <LoadMore loading={list.isFetching} failed={list.isError} onMore={() => setLimit((l) => l + PAGE)} /> : null}
    </div>
  )
}
