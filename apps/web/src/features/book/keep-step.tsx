import { useState, type ReactNode } from 'react'
import { sourceLabel, type ExtractedPage } from '@mylib/domain'
import { DialogPanel } from '@/components/dialog-panel'
import { NativeSelect } from '@/components/native-select'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { formatLabel } from '@/lib/format'
import type { RouterOutputs } from '@/lib/trpc'
import { groupRows, hardcoverLinkLine, keepLabel, type MetaField, type MetaRow } from './fetch-metadata-state'

type WorkDetail = RouterOutputs['catalog']['get']

/** One field: tick box, its name in a narrow column, the new value (the current one under it, struck through, when it would replace). */
function KeepRow({ row, ticked, onToggle }: { row: MetaRow; ticked: boolean; onToggle: (on: boolean) => void }) {
  const [expanded, setExpanded] = useState(false)
  const id = `meta-${row.field}`
  const replaces = row.current.trim() !== ''
  return (
    <li className="grid min-w-0 grid-cols-[1.25rem_5.5rem_minmax(0,1fr)] items-start gap-x-2 px-3 py-2.5 text-sm">
      <Checkbox id={id} className="mt-0.5" checked={ticked} onCheckedChange={(v) => onToggle(v === true)} />
      <label htmlFor={id} className="font-medium text-muted-foreground">
        {row.label}
      </label>
      <div className="grid min-w-0 gap-0.5">
        {row.field === 'cover' ? (
          <span className="flex items-center gap-2">
            <img src={row.next} alt="" referrerPolicy="no-referrer" className="h-14 w-10 rounded-sm object-cover" />
            {replaces ? <span className="text-xs text-muted-foreground">Replaces this copy’s cover</span> : null}
          </span>
        ) : (
          <>
            {row.field === 'description' ? (
              <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className="text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <span dir="auto" className={`text-start wrap-anywhere ${expanded ? 'block' : 'line-clamp-2'}`}>
                  {row.next}
                </span>
              </button>
            ) : (
              <span dir="auto" className="block text-start wrap-anywhere">
                {row.next}
              </span>
            )}
            {replaces ? (
              <span dir="auto" className="text-start text-xs text-muted-foreground line-through wrap-anywhere line-clamp-2">
                {row.current}
              </span>
            ) : null}
          </>
        )}
      </div>
    </li>
  )
}

function Group({ name, rows, ticked, onToggle, onSetAll }: { name: string; rows: MetaRow[]; ticked: ReadonlySet<MetaField>; onToggle: (f: MetaField, on: boolean) => void; onSetAll: (rows: MetaRow[], on: boolean) => void }) {
  if (rows.length === 0) return null
  const all = rows.every((r) => ticked.has(r.field))
  return (
    <section aria-label={name} className="grid min-w-0 gap-1">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {name} · {rows.length}
        </h3>
        <Button type="button" variant="ghost" size="sm" aria-label={`${all ? 'Select none' : 'Select all'} in ${name}`} onClick={() => onSetAll(rows, !all)}>
          {all ? 'Select none' : 'Select all'}
        </Button>
      </div>
      <ul aria-label={`${name} fields`} className="grid grid-cols-1 divide-y rounded-md border">
        {rows.map((r) => (
          <KeepRow key={r.field} row={r} ticked={ticked.has(r.field)} onToggle={(on) => onToggle(r.field, on)} />
        ))}
      </ul>
    </section>
  )
}

/** Step 2: what the page would change, grouped New / Would replace, with a sticky Back + Keep footer. */
export function KeepStep({
  work,
  page,
  rows,
  ticked,
  onToggle,
  onSetAll,
  currentHardcoverId,
  editionId,
  onChooseEdition,
  scopedToCopy,
  pending,
  error,
  onBack,
  onKeep,
}: {
  work: WorkDetail
  page: ExtractedPage
  rows: MetaRow[]
  ticked: ReadonlySet<MetaField>
  onToggle: (field: MetaField, on: boolean) => void
  onSetAll: (rows: MetaRow[], on: boolean) => void
  /** the book's current Hardcover match, if any */
  currentHardcoverId: number | null
  editionId: string | null
  onChooseEdition: (id: string) => void
  scopedToCopy: boolean
  pending: boolean
  error: string | null
  onBack: () => void
  onKeep: () => void
}) {
  const { fresh, replace } = groupRows(rows)
  const tickedCount = rows.filter((r) => ticked.has(r.field)).length
  const keep = keepLabel(page.provider, tickedCount)
  const line: ReactNode =
    page.provider === 'hardcover' ? (
      <span className="text-xs text-muted-foreground">{hardcoverLinkLine(currentHardcoverId === null ? null : { hardcoverId: currentHardcoverId }, page.providerId)}</span>
    ) : null
  return (
    <DialogPanel
      title="What to keep"
      footer={
        <div className="sticky bottom-0 grid w-full gap-2 bg-background">
          <div className="flex w-full justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onBack}>
              Back
            </Button>
            <Button type="button" disabled={pending || keep.disabled} onClick={onKeep}>
              {keep.text}
            </Button>
          </div>
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive wrap-anywhere">
              {error}
            </p>
          ) : null}
        </div>
      }
    >
      <div className="grid min-w-0 grid-cols-1 gap-4">
        <div className="grid min-w-0 gap-2">
          <div className="flex min-w-0 items-center gap-3">
            {page.coverUrl !== null ? <img src={page.coverUrl} alt="" referrerPolicy="no-referrer" className="h-14 w-10 shrink-0 rounded-sm object-cover" /> : null}
            <div className="grid min-w-0 gap-0.5">
              <a href={page.url} target="_blank" rel="noreferrer" className="font-medium underline-offset-4 wrap-anywhere hover:underline">
                <bdi>{page.title}</bdi>
                <span dir="ltr" className="font-normal text-muted-foreground">
                  {' '}
                  · {sourceLabel(page.provider)}
                </span>
              </a>
              {line}
            </div>
          </div>
          {!scopedToCopy && work.editions.length > 1 ? (
            <label className="flex min-w-0 items-center gap-2 text-sm">
              <span className="shrink-0 text-muted-foreground">Copy details go to</span>
              <NativeSelect className="min-w-0 flex-1" value={editionId ?? ''} onChange={(e) => onChooseEdition(e.target.value)}>
                {work.editions.map((e, i) => (
                  <option key={e.id} value={e.id}>
                    {`${formatLabel[e.format]}${e.publisher === null ? '' : ` · ${e.publisher}`} (${i + 1})`}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">This page has nothing your {scopedToCopy ? 'copy' : 'book'} doesn’t already say.</p>
        ) : (
          <>
            <Group name="New" rows={fresh} ticked={ticked} onToggle={onToggle} onSetAll={onSetAll} />
            <Group name="Would replace" rows={replace} ticked={ticked} onToggle={onToggle} onSetAll={onSetAll} />
          </>
        )}
        <p className="text-xs text-muted-foreground">Fields you keep are locked (🔒), like any edit, so syncs leave them alone.</p>
      </div>
    </DialogPanel>
  )
}
