import { useId, useState } from 'react'
import { isAllowedCoverUrl, sourceLabel, volumeLabel, type ExtractedPage, type PageCapture, type ShelfRow } from '@mylib/domain'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { BookLinker } from './book-linker'
import { OwnershipPicker, type Ownership } from './ownership-picker'
import { type ReviewRow } from './shelf-state'
import { StatusChip } from './status-chip'
import { fieldsFromVolume, VolumeFields, volumeFromFields, type VolumeText } from './volume-fields'

/** The same bottom bar as Add book: above the tabs and the keyboard below lg, edge to edge, in the flow from lg. */
const ACTION_BAR =
  'sticky bottom-[max(var(--bottom-offset),var(--keyboard-inset,0px))] z-page-sticky -mx-4 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur md:[--bleed:max(1.5rem,calc((100cqw_-_42rem)/2_+_1.5rem))] md:-mx-(--bleed) md:px-(--bleed) lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0 lg:py-0 lg:backdrop-blur-none'

const byline = (row: ShelfRow): string => [row.authors.join(', '), row.seriesNumber !== null ? `${row.series ?? 'Series'} #${row.seriesNumber}` : (row.series ?? ''), volumeLabel(row.volume, row.volumeCount) ?? ''].filter((p) => p !== '').join(' · ')

function RowEditor({ row, onCommit }: { row: ShelfRow; onCommit: (patch: Partial<ShelfRow>) => void }) {
  const volumeId = useId()
  const [title, setTitle] = useState(row.title)
  const [authors, setAuthors] = useState(row.authors.join(', '))
  const [seriesNumber, setSeriesNumber] = useState(row.seriesNumber ?? '')
  const [volume, setVolume] = useState<VolumeText>(fieldsFromVolume(row.volume === null ? null : { number: row.volume, count: row.volumeCount }))
  const [volumeEdited, setVolumeEdited] = useState(false)
  return (
    <div
      className="grid gap-2"
      onBlur={(e) => {
        // commit when focus leaves the fields, not when it moves between them
        if (e.currentTarget.contains(e.relatedTarget)) return
        const cleanTitle = title.trim() === '' ? row.title : title.trim()
        const v = volumeEdited ? volumeFromFields(volume) : undefined
        // an invalid volume is not saved (the row keeps its own)
        const volumePatch = v === undefined || v === 'invalid' ? {} : { volume: v?.number ?? null, volumeCount: v?.count ?? null, volumeSet: true }
        onCommit({
          title: cleanTitle,
          authors: authors.split(',').map((a) => a.trim()).filter((a) => a !== ''),
          seriesNumber: seriesNumber.trim() === '' ? null : seriesNumber.trim(),
          ...volumePatch,
        })
      }}
    >
      <Input aria-label="Title" dir="auto" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      <Input aria-label="Authors (separated by commas)" dir="auto" value={authors} onChange={(e) => setAuthors(e.target.value)} />
      <Input aria-label="Series number" dir="auto" value={seriesNumber} onChange={(e) => setSeriesNumber(e.target.value)} />
      <VolumeFields
        idPrefix={volumeId}
        value={volume}
        onChange={(v) => {
          setVolume(v)
          setVolumeEdited(true)
        }}
      />
    </div>
  )
}

export function ReviewList({
  rows,
  linked,
  onToggle,
  onEdit,
  onPickMaybe,
  onLink,
  ownership,
  onOwnership,
  borrowedFrom,
  onBorrowedFrom,
  importing,
  onImport,
}: {
  rows: ReviewRow[]
  linked: Record<string, ExtractedPage>
  onToggle: (key: string) => void
  onEdit: (key: string, patch: Partial<ShelfRow>) => void
  onPickMaybe: (key: string) => void
  onLink: (key: string, capture: PageCapture) => Promise<unknown>
  ownership: Ownership
  onOwnership: (value: Ownership) => void
  borrowedFrom: string
  onBorrowedFrom: (value: string) => void
  importing: boolean
  onImport: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  /** the one row whose look-up is open */
  const [linking, setLinking] = useState<string | null>(null)
  const count = rows.filter((r) => r.checked).length
  return (
    <section aria-labelledby="shelf-review" className="grid gap-3">
      <h2 id="shelf-review" className="text-lg font-semibold">
        Review the list
      </h2>
      <ul className="divide-y rounded-lg border text-sm">
        {rows.map((r) => {
          const page = linked[r.key]
          return (
            <li key={r.key} className="grid min-w-0 gap-2 p-3">
              <div className="flex min-w-0 items-start gap-3">
                <Checkbox className="mt-0.5" checked={r.checked} aria-label={`Add ${r.row.title}`} onCheckedChange={() => onToggle(r.key)} />
                <div className="grid min-w-0 flex-1 gap-1">
                  {editing === r.key ? (
                    <RowEditor
                      row={r.row}
                      onCommit={(patch) => {
                        setEditing(null)
                        onEdit(r.key, patch)
                      }}
                    />
                  ) : (
                    <button type="button" className="min-w-0 text-start" onClick={() => setEditing(r.key)}>
                      <span className="block font-medium wrap-anywhere text-match-parent" dir="auto">
                        {r.row.title}
                      </span>
                      {byline(r.row) !== '' ? (
                        <span className="block text-muted-foreground wrap-anywhere text-match-parent" dir="auto">
                          {byline(r.row)}
                        </span>
                      ) : null}
                    </button>
                  )}
                  <div>
                    <StatusChip status={r.status} onPickMaybe={r.status?.kind === 'maybe' ? () => onPickMaybe(r.key) : undefined} />
                  </div>
                  {r.status?.kind === 'maybe' && r.preset !== null ? <p className="text-xs text-muted-foreground">Will be filed as a copy of that book</p> : null}
                  {r.status?.kind === 'have' && r.checked ? <p className="text-xs text-muted-foreground">Will be added as a second copy</p> : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 ps-8">
                {page ? (
                  <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    {page.coverUrl !== null && isAllowedCoverUrl(page.coverUrl) ? <img src={page.coverUrl} alt="" referrerPolicy="no-referrer" className="h-12 w-8 rounded-sm object-cover" /> : null}
                    Linked to {sourceLabel(page.provider)}
                  </span>
                ) : null}
                <Button type="button" variant="outline" size="xs" aria-expanded={linking === r.key} onClick={() => setLinking((k) => (k === r.key ? null : r.key))}>
                  {linking === r.key ? 'Close' : page ? 'Link another' : 'Find the book'}
                </Button>
              </div>
              {linking === r.key ? (
                <div className="ps-8">
                  <BookLinker
                    idPrefix={`row-${r.key}`}
                    seed={{ ...r.row }}
                    target={{ kind: 'row', key: r.key }}
                    onCapture={async (capture) => {
                      await onLink(r.key, capture)
                      setLinking(null)
                    }}
                  />
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      <div data-sticky-submit className={ACTION_BAR}>
        <OwnershipPicker ownership={ownership} onOwnership={(v) => (v === 'wishlist' ? undefined : onOwnership(v))} borrowedFrom={borrowedFrom} onBorrowedFrom={onBorrowedFrom} />
        <Button type="button" disabled={count === 0 || importing} onClick={onImport}>
          Add {count} {count === 1 ? 'book' : 'books'}
        </Button>
      </div>
    </section>
  )
}
