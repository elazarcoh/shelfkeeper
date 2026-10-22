import { LayoutGrid, List } from 'lucide-react'
import { useId } from 'react'
import { editionFormats, readingStatuses } from '@mylib/domain'
import { FormatIcon } from '@/components/format-icon'
import { NativeSelect } from '@/components/native-select'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { formatLabel, statusLabel } from '@/lib/format'
import type { RouterOutputs } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { filterOptionLabel } from '@/features/people/people-state'
import { holdingOptions, kindOptions, sorts } from './library-filters'
import { effectiveSort, seriesViewId, type LibrarySearch } from './library-search'

type Facets = RouterOutputs['catalog']['facets']
type Sets = RouterOutputs['sets']['mine']

interface FilterFieldsProps {
  search: LibrarySearch
  facets: Facets | undefined
  sets: Sets | undefined
  onChange: (patch: Partial<LibrarySearch>) => void
  /** the Collapse series switch as shown, and what turning it changes */
  collapse: { on: boolean; onChange: (on: boolean) => void }
  className?: string | undefined
}

/** Every library filter field; inline from lg, inside the Filters sheet below it. */
export function FilterFields({ search, facets, sets, onChange, collapse, className }: FilterFieldsProps) {
  const one = (ids: string[] | undefined) => ids?.[0] ?? ''
  const collapseId = useId()
  // search text shows matching books one by one, and a series view is one series already
  const collapseIdle = (search.q ?? '').trim() !== '' ? 'Off while searching' : seriesViewId(search) !== undefined ? 'Off inside a series' : undefined
  const toggleFormat = (f: (typeof editionFormats)[number]) => {
    const current = search.formats ?? []
    const next = current.includes(f) ? current.filter((x) => x !== f) : [...current, f]
    onChange({ formats: next.length > 0 ? next : undefined })
  }

  return (
    <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]', className)}>
      {/* My library | Whole catalog is the switch at the top of the page; a set is browsed across the catalog */}
      <label className="grid gap-1 text-sm text-muted-foreground">
        Set
        <NativeSelect
          value={search.set ?? ''}
          onChange={(e) => onChange({ set: e.target.value === '' ? undefined : e.target.value, scope: undefined })}
        >
          <option value="">None</option>
          {sets?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
      </label>

      <label className="grid gap-1 text-sm text-muted-foreground">
        Copy
        <NativeSelect
          aria-label="Copy"
          value={holdingOptions.find((o) => JSON.stringify(o.availability) === JSON.stringify(search.availability))?.value ?? ''}
          onChange={(e) => onChange({ availability: holdingOptions.find((o) => o.value === e.target.value)?.availability })}
        >
          {holdingOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </label>

      <label className="grid gap-1 text-sm text-muted-foreground">
        Kind
        <NativeSelect
          value={kindOptions.find((o) => JSON.stringify(o.kinds) === JSON.stringify(search.kinds))?.value ?? ''}
          onChange={(e) => onChange({ kinds: kindOptions.find((o) => o.value === e.target.value)?.kinds })}
        >
          {kindOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </label>

      <div className="grid gap-1 text-sm text-muted-foreground">
        Format
        {/* below lg (the Filters sheet) the toggles are full-width and named: an icon alone is a guess on a phone */}
        <div className="flex gap-2 lg:gap-1">
          {editionFormats.map((f) => (
            <Button
              key={f}
              type="button"
              size="sm"
              variant={search.formats?.includes(f) ? 'default' : 'outline'}
              aria-pressed={search.formats?.includes(f) ?? false}
              aria-label={formatLabel[f]}
              className="max-lg:flex-1"
              onClick={() => toggleFormat(f)}
            >
              {/* under 360px the three named toggles do not fit beside their icons: the names stay, the icons go */}
              <FormatIcon format={f} className="size-4 max-[22.5rem]:hidden" />
              <span className="lg:hidden">{formatLabel[f]}</span>
            </Button>
          ))}
        </div>
      </div>

      <label className="grid gap-1 text-sm text-muted-foreground">
        Status
        <NativeSelect
          value={search.statuses?.[0] ?? ''}
          onChange={(e) => {
            const status = readingStatuses.find((s) => s === e.target.value)
            onChange({ statuses: status ? [status] : undefined })
          }}
        >
          <option value="">Any</option>
          {readingStatuses.map((s) => (
            <option key={s} value={s}>
              {statusLabel[s]}
            </option>
          ))}
        </NativeSelect>
      </label>

      <label className="grid gap-1 text-sm text-muted-foreground">
        My rating
        <NativeSelect
          value={search.minRating?.toString() ?? ''}
          onChange={(e) => onChange({ minRating: e.target.value === '' ? undefined : Number(e.target.value) })}
        >
          <option value="">Any</option>
          {[5, 4, 3, 2, 1].map((r) => (
            <option key={r} value={r}>
              {r === 5 ? '5 stars' : `${r}+ stars`}
            </option>
          ))}
        </NativeSelect>
      </label>

      <label className="grid gap-1 text-sm text-muted-foreground">
        Author
        <NativeSelect value={one(search.authorIds)} onChange={(e) => onChange({ authorIds: e.target.value ? [e.target.value] : undefined })}>
          <option value="">Any</option>
          {facets?.authors.map((a) => (
            <option key={a.id} value={a.id}>
              {filterOptionLabel(a)}
            </option>
          ))}
        </NativeSelect>
      </label>

      <label className="grid gap-1 text-sm text-muted-foreground">
        Series
        <NativeSelect value={one(search.seriesIds)} onChange={(e) => onChange({ seriesIds: e.target.value ? [e.target.value] : undefined })}>
          <option value="">Any</option>
          {facets?.series.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
      </label>

      <label className="grid gap-1 text-sm text-muted-foreground">
        Tag
        <NativeSelect value={one(search.tagIds)} onChange={(e) => onChange({ tagIds: e.target.value ? [e.target.value] : undefined })}>
          <option value="">Any</option>
          {facets?.tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </NativeSelect>
      </label>

      <label className="grid gap-1 text-sm text-muted-foreground">
        Sort
        <NativeSelect value={effectiveSort(search)} onChange={(e) => onChange({ sort: sorts.find((s) => s.value === e.target.value)?.value })}>
          {sorts.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </NativeSelect>
      </label>

      <div className="grid gap-1 text-sm text-muted-foreground">
        <label htmlFor={collapseId}>Collapse series</label>
        <div className="flex min-h-9 min-w-0 items-center gap-2 pointer-coarse:min-h-11">
          <Switch id={collapseId} checked={collapse.on} onCheckedChange={collapse.onChange} aria-describedby={collapseIdle ? `${collapseId}-idle` : undefined} />
          {collapseIdle ? (
            <span id={`${collapseId}-idle`} className="min-w-0 truncate text-xs">
              {collapseIdle}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** `compact` (the phone search row): one 44px button that switches to the other view, named for where it goes. */
export function ViewToggle({ view, onChange, compact = false }: { view: 'grid' | 'list'; onChange: (view: 'grid' | 'list') => void; compact?: boolean | undefined }) {
  if (compact) {
    const next = view === 'list' ? 'grid' : 'list'
    return (
      <Button type="button" size="icon" variant="outline" className="shrink-0" aria-label={next === 'list' ? 'List view' : 'Grid view'} onClick={() => onChange(next)}>
        {next === 'list' ? <List className="size-4" /> : <LayoutGrid className="size-4" />}
      </Button>
    )
  }
  return (
    <div className="flex gap-1">
      <Button type="button" size="icon" variant={view === 'list' ? 'outline' : 'default'} aria-label="Grid view" onClick={() => onChange('grid')}>
        <LayoutGrid className="size-4" />
      </Button>
      <Button type="button" size="icon" variant={view === 'list' ? 'default' : 'outline'} aria-label="List view" onClick={() => onChange('list')}>
        <List className="size-4" />
      </Button>
    </div>
  )
}
