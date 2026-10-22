import { useQuery } from '@tanstack/react-query'
import { Lock, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { isLocked, workKinds, workKindLabel, type Provenance } from '@mylib/domain'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { MoreDetails } from '@/components/more-details'
import { SuggestInput } from '@/components/suggest-input'
import { findByName } from '@/components/suggest-logic'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { firstError, type FieldErrors } from '@/lib/form'
import { useSuggestions } from '@/lib/suggestions'
import { trpc } from '@/lib/trpc'
import { isOptionalWorkKey } from './add-book-rules'
import { formatSeriesHint, seriesPositionHint } from './series-hint'
import type { SeriesRow, WorkFormState } from './work-form-state'

interface WorkFieldsProps {
  value: WorkFormState
  onChange: (value: WorkFormState) => void
  errors: FieldErrors
  provenance?: Provenance | undefined
  idPrefix?: string
  /** rendered right after the Title field */
  afterTitle?: ReactNode
  /** below sm, tuck everything but Title and Authors behind "More details" */
  collapseOptional?: boolean
  /** the book being edited (Add book has none): its own series position is not "taken" */
  workId?: string | undefined
}

export function WorkFields({ value, onChange, errors, provenance, idPrefix = 'work', afterTitle, collapseOptional = false, workId }: WorkFieldsProps) {
  const suggestions = useSuggestions()
  const set = <K extends keyof WorkFormState>(key: K, v: WorkFormState[K]) => onChange({ ...value, [key]: v })
  const locked = (field: string) => provenance !== undefined && isLocked(provenance, field)
  const id = (field: string) => `${idPrefix}-${field}`

  return (
    // grid-cols-1 (minmax(0,1fr)): an auto track grows to a long title in the catalog matches below the Title field
    <div className="grid grid-cols-1 gap-4">
      <Field label="Title" htmlFor={id('title')} error={errors.title} locked={locked('title')}>
        <Input id={id('title')} dir="auto" value={value.title} onChange={(e) => set('title', e.target.value)} />
      </Field>
      {afterTitle}
      <Field label="Authors (one per line)" htmlFor={id('authors')} error={firstError(errors, 'authors')} locked={locked('authors')}>
        <SuggestInput
          id={id('authors')}
          dir="auto"
          multiline
          rows={2}
          mode="lines"
          options={suggestions.contributors}
          newLabel={suggestions.ready ? 'New author' : undefined}
          value={value.authors}
          onChange={(v) => set('authors', v)}
        />
      </Field>
      <MoreDetails collapsible={collapseOptional} errors={errors} isOptionalKey={isOptionalWorkKey}>
        <Field label="Subtitle" htmlFor={id('subtitle')} error={errors.subtitle} locked={locked('subtitle')}>
          <Input id={id('subtitle')} dir="auto" value={value.subtitle} onChange={(e) => set('subtitle', e.target.value)} />
        </Field>
        <SeriesEditor
          rows={value.series}
          onChange={(rows) => set('series', rows)}
          error={firstError(errors, 'series')}
          locked={locked('series')}
          series={suggestions.series}
          ready={suggestions.ready}
          workId={workId}
        />
        <Field label="Tags (comma separated)" htmlFor={id('tags')} error={firstError(errors, 'tags')} locked={locked('tags')}>
          <SuggestInput id={id('tags')} dir="auto" mode="comma" options={suggestions.tags} newLabel={suggestions.ready ? 'New tag' : undefined} value={value.tags} onChange={(v) => set('tags', v)} />
        </Field>
        <Field label="Kind" htmlFor={id('kind')} error={errors.kind} locked={locked('kind')}>
          <NativeSelect id={id('kind')} value={value.kind} onChange={(e) => onChange({ ...value, kind: workKinds.find((k) => k === e.target.value) ?? 'book', kindTouched: true })}>
            {workKinds.map((k) => (
              <option key={k} value={k}>
                {workKindLabel[k]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Original year" htmlFor={id('year')} error={errors.originalYear} locked={locked('originalYear')}>
          <Input id={id('year')} inputMode="numeric" value={value.originalYear} onChange={(e) => set('originalYear', e.target.value)} />
        </Field>
        <Field label="Description" htmlFor={id('description')} error={errors.description} locked={locked('description')}>
          <Textarea id={id('description')} dir="auto" rows={4} value={value.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
      </MoreDetails>
    </div>
  )
}

type SeriesOption = { id: string; name: string }

function SeriesEditor({
  rows,
  onChange,
  error,
  locked,
  series,
  ready,
  workId,
}: {
  rows: SeriesRow[]
  onChange: (rows: SeriesRow[]) => void
  error: string | undefined
  locked: boolean
  series: readonly SeriesOption[]
  ready: boolean
  workId: string | undefined
}) {
  const names = useMemo(() => series.map((s) => s.name), [series])
  const patch = (index: number, change: Partial<SeriesRow>) => onChange(rows.map((r, i) => (i === index ? { ...r, ...change } : r)))
  return (
    <div className="grid gap-2">
      <span className="flex items-center gap-1.5 text-sm font-medium">
        Series
        {locked ? <Lock className="size-3 text-muted-foreground" aria-label="locked" /> : null}
      </span>
      {rows.map((row, i) => (
        <SeriesRowEditor
          key={i}
          index={i}
          row={row}
          names={names}
          series={series}
          ready={ready}
          workId={workId}
          onPatch={(change) => patch(i, change)}
          onRemove={() => onChange(rows.filter((_, j) => j !== i))}
        />
      ))}
      <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => onChange([...rows, { name: '', position: '' }])}>
        <Plus className="size-4" /> Add series
      </Button>
      {error !== undefined ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

function SeriesRowEditor({
  index,
  row,
  names,
  series,
  ready,
  workId,
  onPatch,
  onRemove,
}: {
  index: number
  row: SeriesRow
  names: readonly string[]
  series: readonly SeriesOption[]
  ready: boolean
  workId: string | undefined
  onPatch: (change: Partial<SeriesRow>) => void
  onRemove: () => void
}) {
  const n = index + 1
  const seriesId = findByName(series, row.name)?.id
  const entries = useQuery({ ...trpc.series.entries.queryOptions({ seriesId: seriesId ?? '' }), enabled: seriesId !== undefined })
  const hint = seriesId !== undefined && entries.data !== undefined ? seriesPositionHint(entries.data, workId) : null
  // a series picked from the suggestions fills an empty position once its entries are in; typing the name by hand never does
  const [pickedId, setPickedId] = useState<string | null>(null)
  useEffect(() => {
    if (pickedId === null || pickedId !== seriesId || entries.data === undefined || entries.isFetching) return
    setPickedId(null)
    if (hint !== null && row.position.trim() === '') onPatch({ position: String(hint.next) })
  }, [pickedId, seriesId, entries.data, entries.isFetching, hint, row.position, onPatch])

  return (
    <div className="grid gap-1">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <SuggestInput
            aria-label={`Series name ${n}`}
            placeholder="Series"
            dir="auto"
            options={names}
            newLabel={ready ? 'New series' : undefined}
            value={row.name}
            onChange={(name, picked) => {
              onPatch({ name })
              setPickedId(picked === undefined ? null : (findByName(series, picked)?.id ?? null))
            }}
          />
        </div>
        <Input
          aria-label={`Series position ${n}`}
          placeholder="#"
          className="w-20"
          inputMode="text"
          value={row.position}
          onChange={(e) => onPatch({ position: e.target.value })}
        />
        <Button type="button" variant="ghost" size="icon" aria-label={`Remove series ${n}`} onClick={onRemove}>
          <X className="size-4" />
        </Button>
      </div>
      {hint !== null ? <p className="text-xs text-muted-foreground">{formatSeriesHint(hint)}</p> : null}
    </div>
  )
}
