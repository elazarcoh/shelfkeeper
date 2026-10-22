import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import type { HardcoverEdition, HardcoverSearchHit } from '@mylib/domain'
import { trpcClient } from '@/lib/trpc'
import { detailsLine, ResultRow } from './result-row'

const message = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong')

/** Hardcover's search hits; tapping a row picks the book (its main version), "Versions" lists the editions to pick one. */
export function HardcoverResults({ results, busy, onPick, onError }: { results: HardcoverSearchHit[]; busy: boolean; onPick: (hardcoverId: number, editionId: number | null) => void; onError: (message: string) => void }) {
  if (results.length === 0) return <p className="text-sm text-muted-foreground">No books found — try another search</p>
  return (
    <ul aria-label="Hardcover results" className="grid gap-2">
      {results.map((hit) => (
        <ResultRow
          key={hit.id}
          coverUrl={hit.imageUrl}
          title={hit.title}
          details={detailsLine([hit.authors.join(', '), hit.year, hit.series[0]])}
          label={`Use ${hit.title}`}
          disabled={busy}
          onPick={() => onPick(hit.id, null)}
          below={<Versions hardcoverId={hit.id} busy={busy} onPick={(editionId) => onPick(hit.id, editionId)} onError={onError} />}
        />
      ))}
    </ul>
  )
}

/** Fetched once, on the first open; the rows stay mounted, so closing and reopening asks nothing more. */
export function Versions({ hardcoverId, busy, onPick, onError }: { hardcoverId: number; busy: boolean; onPick: (editionId: number) => void; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false)
  const versions = useMutation({
    mutationFn: () => trpcClient.hardcover.versions.mutate({ hardcoverId }),
    onError: (e) => {
      onError(message(e))
      setOpen(false)
    },
  })
  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (versions.data === undefined && !versions.isPending) versions.mutate()
  }
  const editions: HardcoverEdition[] = versions.data?.editions ?? []

  return (
    <div className="px-2 pb-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="rounded-md px-1 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:py-2.5"
      >
        {open ? 'Versions ▴' : 'Versions ▾'}
      </button>
      {open ? (
        versions.isPending ? (
          <p className="px-1 text-xs text-muted-foreground">Loading…</p>
        ) : versions.data !== undefined && editions.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">No versions listed</p>
        ) : (
          <ul aria-label="Versions" className="mt-1 grid gap-1">
            {editions.map((edition, i) => (
              <li key={edition.id} className="min-w-0">
                <button
                  type="button"
                  aria-label={`Use version ${i + 1}`}
                  disabled={busy}
                  onClick={() => onPick(edition.id)}
                  className="grid w-full min-w-0 rounded-md border px-2 py-1.5 text-start text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 pointer-coarse:min-h-11"
                >
                  <span dir="auto" className="wrap-anywhere">
                    {detailsLine([edition.format, edition.pages === null ? 'No page count' : `${edition.pages} pages`])}
                  </span>
                  <span dir="auto" className="text-muted-foreground wrap-anywhere">
                    {detailsLine([edition.publisher, edition.releaseDate?.slice(0, 4), edition.isbn13 ?? edition.isbn10 ?? 'no ISBN'])}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  )
}
