import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { EditionInput, ExternalItem, InboxResolution } from '@mylib/domain'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { trpc } from '@/lib/trpc'
import { useDebounced } from '@/lib/use-debounced'
import type { DetailsHolding } from './edition-details'
import { EditionDetailsDialog } from './edition-details-dialog'

/** Search the catalog (scoped to what this admin can see) and add the item as a new edition of any book, or link a wanted item to one. */
export function OtherBookPicker({
  busy,
  mode,
  onResolve,
  item,
  holding,
  onAddWith,
}: {
  busy: boolean
  mode: 'copy' | 'wanted'
  onResolve: (resolution: InboxResolution) => void
  /** with `onAddWith`, copy mode also offers "Details…" (#121) */
  item?: ExternalItem
  holding?: DetailsHolding
  onAddWith?: (workId: string) => (edition: EditionInput) => Promise<unknown>
}) {
  const [q, setQ] = useState('')
  const settled = useDebounced(q, 250)
  const results = useQuery({ ...trpc.library.search.queryOptions({ q: settled }), enabled: settled.trim() !== '' })
  return (
    // grid-cols-1 (minmax(0,1fr)) here and on the list: an auto track grows to a long title, so it could not truncate
    <div className="grid grid-cols-1 gap-2">
      <SearchInput aria-label="Find another book" placeholder="Find another book in the catalog…" dir="auto" value={q} onValueChange={setQ} />
      {results.data && results.data.items.length > 0 ? (
        <ul className="grid grid-cols-1 gap-1">
          {results.data.items.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate" dir="auto">
                {w.title}
              </span>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onResolve(mode === 'wanted' ? { action: 'attach_wanted', workId: w.id } : { action: 'link_new_edition', workId: w.id })}
                >
                  {mode === 'wanted' ? 'It’s this book' : 'Add to this book'}
                </Button>
                {mode === 'copy' && item !== undefined && onAddWith !== undefined ? <EditionDetailsDialog bookTitle={w.title} item={item} holding={holding ?? null} busy={busy} onAdd={onAddWith(w.id)} /> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
