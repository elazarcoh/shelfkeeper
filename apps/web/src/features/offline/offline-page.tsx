import { useMemo, useState } from 'react'
import { searchOffline, type OfflineWork } from '@mylib/domain'
import { FormatIcon } from '@/components/format-icon'
import { KindBadge } from '@/components/kind-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { WorkCover } from '@/components/work-cover'
import { withBase } from '@/lib/base-path'
import { availabilityLabel, seriesLabel, statusLabel } from '@/lib/format'
import { useSavedCopy } from './use-offline-copy'

function Row({ work }: { work: OfflineWork }) {
  return (
    <li className="flex items-center gap-3 p-3">
      {/* a cover shows when this phone has seen it before (the service worker keeps them); else the placeholder */}
      <WorkCover title={work.title} coverAssetId={work.coverAssetId} label={false} className="w-10 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 font-medium">
          <span className="truncate" dir="auto">
            {work.title}
          </span>
          <KindBadge kind={work.kind} compact />
        </p>
        <p className="truncate text-sm text-muted-foreground" dir="auto">
          {work.authors.join(', ')}
          {work.series ? ` · ${seriesLabel(work.series)}` : ''}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground">
          {work.formats.map((f) => (
            <FormatIcon key={f} format={f} className="size-3.5" />
          ))}
          <Badge variant={work.availability === 'owned' ? 'default' : 'outline'}>{availabilityLabel[work.availability]}</Badge>
          {work.status !== 'none' ? <Badge variant="secondary">{statusLabel[work.status]}</Badge> : null}
        </div>
      </div>
    </li>
  )
}

const dateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const PAGE = 50
const byTitle = (a: OfflineWork, b: OfflineWork) => a.title.localeCompare(b.title)

/**
 * #62: the catalog as last saved on this phone, searchable with no connection; it changes nothing.
 * Outside the app shell (#167): it keeps clear of the status bar itself, and the search stays at the top while the list scrolls.
 */
export function OfflinePage() {
  const copy = useSavedCopy()
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PAGE)
  const saved = copy.data ?? null
  const searching = query.trim() !== ''
  const sorted = useMemo(() => (saved === null ? [] : [...saved.snapshot.works].sort(byTitle)), [saved])
  // with nothing typed, the whole copy to browse, a page at a time
  const results = saved === null ? [] : searching ? searchOffline(saved.snapshot.works, query) : sorted.slice(0, shown)
  return (
    <div className="min-h-dvh bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
      <header className="sticky top-0 z-10 border-b bg-background/95 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto grid max-w-2xl gap-2 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold tracking-tight">Offline</h1>
            <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={() => window.location.assign(withBase('/'))}>
              Try again
            </Button>
          </div>
          {saved !== null ? (
            // not type=search: the browser would add a second clear button; no autofocus, so the keyboard waits for a tap
            <SearchInput inputMode="search" enterKeyHint="search" dir="auto" value={query} onValueChange={setQuery} placeholder="Title, author or series" aria-label="Search the offline copy" />
          ) : null}
        </div>
      </header>
      <main className="mx-auto grid max-w-2xl gap-3 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {copy.isPending ? null : saved === null ? (
          <p className="text-sm text-muted-foreground">My Library can't be reached, and there's no offline copy on this device yet. Open My Library once with a connection and it saves one.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {searching
                ? results.length === 0
                  ? 'Not in the catalog'
                  : `${results.length} found`
                : `My Library can't be reached. This is ${saved.name}'s copy of the catalog from ${dateTime(saved.snapshot.at)}, ${sorted.length} books.`}
            </p>
            {results.length > 0 ? (
              <ul className="divide-y rounded-md border" aria-label="Offline results">
                {results.map((w) => (
                  <Row key={w.id} work={w} />
                ))}
              </ul>
            ) : null}
            {!searching && shown < sorted.length ? (
              <Button variant="outline" className="justify-self-center" onClick={() => setShown((n) => n + PAGE)}>
                Show more
              </Button>
            ) : null}
          </>
        )}
      </main>
    </div>
  )
}
