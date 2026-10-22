import { ArrowLeft, ChevronDown, Layers, LibraryBig, SlidersHorizontal, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { workKinds, workKindLabel } from '@mylib/domain'
import { toast } from 'sonner'
import { DialogPanel } from '@/components/dialog-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useInvalidateBook } from '@/features/book/invalidate'
import type { RouterOutputs } from '@/lib/trpc'
import { FilterFields } from './filter-bar'
import { activeFilterChips, clearFilters, hasRemovableFilters, type FilterChip } from './library-filters'
import type { LibrarySearch } from './library-search'
import { MARK_SERIES_AS } from './quick-actions/series-action-model'
import { useMarkSeriesKind } from './quick-actions/use-mark-series-kind'

interface Props {
  search: LibrarySearch
  facets: RouterOutputs['catalog']['facets'] | undefined
  sets: RouterOutputs['sets']['mine'] | undefined
  onChange: (patch: Partial<LibrarySearch>) => void
  collapse: { on: boolean; onChange: (on: boolean) => void }
  /** books, not cards */
  total: number | undefined
}

/** Below lg: every filter in one sheet; changes apply as you make them. */
export function FiltersSheet({ search, facets, sets, onChange, collapse, total }: Props) {
  const count = activeFilterChips(search, facets).length
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="shrink-0">
          <SlidersHorizontal className="size-4" /> Filters{count > 0 ? ` (${count})` : ''}
        </Button>
      </DialogTrigger>
      <DialogContent bare className="sm:max-w-lg">
        <DialogPanel
          title="Filters"
          description="Changes apply right away."
          footer={
            <>
              <Button variant="ghost" disabled={!hasRemovableFilters(search)} onClick={() => onChange(clearFilters(search))}>
                Clear all
              </Button>
              <DialogClose asChild>
                {/* total is undefined while the new count loads, so the button never shows a stale number */}
                <Button>{total === undefined ? 'Show books' : `Show ${total} ${total === 1 ? 'book' : 'books'}`}</Button>
              </DialogClose>
            </>
          }
        >
          <FilterFields search={search} facets={facets} sets={sets} onChange={onChange} collapse={collapse} />
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}

/** A view's fixed context (its own filter is not a removable chip), plus one tap back out of it. */
function ContextPill({ kind, name, back, onLeave, children }: { kind: 'Set' | 'Series'; name: string; back: string; onLeave: () => void; children?: ReactNode }) {
  const Icon = kind === 'Set' ? Layers : LibraryBig
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-full border px-3 text-sm">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">
          {kind}: <span dir="auto">{name}</span>
        </span>
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onLeave}>
        <ArrowLeft className="size-4 rtl:rotate-180" /> {back}
      </Button>
      {children}
    </div>
  )
}

/** In a set's view, in place of the My library | Whole catalog switch: the set, plus one tap back to My library. */
export function SetContext({ name, onLeave }: { name: string; onLeave: () => void }) {
  return <ContextPill kind="Set" name={name} back="My library" onLeave={onLeave} />
}

/** Inside a series (from its card, or the Series filter): the series, plus one tap back to the collapsed library. */
export function SeriesContext({ id, name, onLeave }: { id: string; name: string; onLeave: () => void }) {
  return (
    <ContextPill kind="Series" name={name} back="Back" onLeave={onLeave}>
      <MarkSeriesAs seriesId={id} />
    </ContextPill>
  )
}

/** The series card's "Mark series as…", for the series view: with the collapsed view off there is no card to open it from. */
function MarkSeriesAs({ seriesId }: { seriesId: string }) {
  const invalidate = useInvalidateBook()
  const { mark, isPending } = useMarkSeriesKind(seriesId)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={isPending}>
          {MARK_SERIES_AS} <ChevronDown className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {workKinds.map((k) => (
          <DropdownMenuItem
            key={k}
            onSelect={() => {
              mark(k)
                .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Something went wrong'))
                .finally(invalidate)
            }}
          >
            {workKindLabel[k]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ActiveFilterChips({ chips, onRemove }: { chips: FilterChip[]; onRemove: (patch: Partial<LibrarySearch>) => void }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Active filters">
      {chips.map((c) => (
        <li key={c.key} className="max-w-full min-w-0">
          <Button type="button" variant="secondary" size="sm" className="max-w-full rounded-full" aria-label={`Remove filter: ${c.label}`} onClick={() => onRemove(c.remove)}>
            <span className="truncate" dir="auto">
              {c.label}
            </span>
            <X className="size-3.5" />
          </Button>
        </li>
      ))}
    </ul>
  )
}
