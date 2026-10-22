import { editionFormats, isLocked, type Provenance } from '@mylib/domain'
import { Field } from '@/components/field'
import { MoreDetails } from '@/components/more-details'
import { NativeSelect } from '@/components/native-select'
import { SuggestInput } from '@/components/suggest-input'
import { Input } from '@/components/ui/input'
import { firstError, type FieldErrors } from '@/lib/form'
import { formatLabel } from '@/lib/format'
import { useSuggestions } from '@/lib/suggestions'
import { isOptionalEditionKey } from './add-book-rules'
import { showsField, type EditionFormState } from './edition-form-state'

interface EditionFieldsProps {
  value: EditionFormState
  onChange: (value: EditionFormState) => void
  errors: FieldErrors
  provenance?: Provenance | undefined
  idPrefix?: string
  /** show "I own it / Borrowed" + date + note (new editions only) */
  showHolding?: boolean
  /** below sm, tuck everything but "This copy" and Format behind "More details" */
  collapseOptional?: boolean
}

export function EditionFields({
  value,
  onChange,
  errors,
  provenance,
  idPrefix = 'edition',
  showHolding = false,
  collapseOptional = false,
}: EditionFieldsProps) {
  const set = <K extends keyof EditionFormState>(key: K, v: EditionFormState[K]) => onChange({ ...value, [key]: v })
  const locked = (field: string) => provenance !== undefined && isLocked(provenance, field)
  const id = (field: string) => `${idPrefix}-${field}`
  const f = value.format
  const suggestions = useSuggestions()
  type TextKey = 'title' | 'subtitle' | 'isbn13' | 'isbn10' | 'asin' | 'publisher' | 'language' | 'shelfLocation'
  const text = (field: TextKey, label: string, hint?: string, options?: readonly string[]) => (
    <Field label={label} htmlFor={id(field)} error={errors[field]} hint={hint} locked={locked(field)}>
      {options ? (
        <SuggestInput id={id(field)} dir="auto" options={options} value={value[field]} onChange={(v) => set(field, v)} />
      ) : (
        <Input id={id(field)} dir="auto" value={value[field]} onChange={(e) => set(field, e.target.value)} />
      )}
    </Field>
  )

  return (
    <div className="grid gap-4">
      {showHolding ? (
        <div className="grid gap-4 sm:rounded-md sm:border sm:p-3">
          <Field label="This copy" htmlFor={id('ownership')}>
            <NativeSelect
              id={id('ownership')}
              value={value.ownership}
              onChange={(e) => set('ownership', e.target.value === 'borrowed' ? 'borrowed' : 'owned')}
            >
              <option value="owned">I own it</option>
              <option value="borrowed">Borrowed (library, friend, app)</option>
            </NativeSelect>
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-start">
            <Field label={value.ownership === 'borrowed' ? 'Borrowed on' : 'Got it on'} htmlFor={id('holdingOn')} hint="Blank = today" error={errors.holdingOn}>
              <Input id={id('holdingOn')} type="date" value={value.holdingOn} onChange={(e) => set('holdingOn', e.target.value)} />
            </Field>
            <Field
              label={value.ownership === 'borrowed' ? 'Borrowed from' : 'Where from'}
              htmlFor={id('holdingNote')}
              hint={value.ownership === 'borrowed' ? 'e.g. City library, Dana' : 'Optional'}
              error={errors.holdingNote}
            >
              <Input id={id('holdingNote')} dir="auto" value={value.holdingNote} onChange={(e) => set('holdingNote', e.target.value)} />
            </Field>
          </div>
        </div>
      ) : null}
      <Field label="Format" htmlFor={id('format')} locked={locked('format')}>
        <NativeSelect
          id={id('format')}
          value={f}
          onChange={(e) => {
            const next = editionFormats.find((x) => x === e.target.value)
            if (next) set('format', next)
          }}
        >
          {editionFormats.map((x) => (
            <option key={x} value={x}>
              {formatLabel[x]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <MoreDetails collapsible={collapseOptional} errors={errors} isOptionalKey={isOptionalEditionKey}>
        {text('title', 'Edition title', 'Only if it differs from the book title')}
        {text('subtitle', 'Edition subtitle', 'Shown with the edition title; only if it differs from the book subtitle')}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-start">
          {text('isbn13', 'ISBN-13')}
          {text('isbn10', 'ISBN-10')}
        </div>
        {showsField.asin(f) ? text('asin', 'ASIN') : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-start">
          {text('publisher', 'Publisher', undefined, suggestions.publishers)}
          <Field label="Published on" htmlFor={id('publishedOn')} error={errors.publishedOn} locked={locked('publishedOn')}>
            <Input id={id('publishedOn')} type="date" value={value.publishedOn} onChange={(e) => set('publishedOn', e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:items-start">
          <Field label="Volume" htmlFor={id('volume')} hint="For a book printed in parts" error={errors.volume} locked={locked('volume')}>
            <Input id={id('volume')} inputMode="numeric" value={value.volume} onChange={(e) => set('volume', e.target.value)} />
          </Field>
          <Field label="Of" htmlFor={id('volumeCount')} hint="Number of volumes" error={errors.volumeCount} locked={locked('volumeCount')}>
            <Input
              id={id('volumeCount')}
              inputMode="numeric"
              value={value.volumeCount}
              disabled={value.volume.trim() === ''}
              onChange={(e) => set('volumeCount', e.target.value)}
            />
          </Field>
        </div>
        {showsField.pages(f) ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-start">
            <Field label="Pages" htmlFor={id('pageCount')} error={errors.pageCount} locked={locked('pageCount')}>
              <Input id={id('pageCount')} inputMode="numeric" value={value.pageCount} onChange={(e) => set('pageCount', e.target.value)} />
            </Field>
            <Field label="Word count" htmlFor={id('wordCount')} hint="Used for reading stats" error={errors.wordCount} locked={locked('wordCount')}>
              <Input id={id('wordCount')} inputMode="numeric" value={value.wordCount} onChange={(e) => set('wordCount', e.target.value)} />
            </Field>
          </div>
        ) : null}
        {showsField.duration(f) ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-start">
            <Field label="Hours" htmlFor={id('hours')} error={errors.durationSec} locked={locked('durationSec')}>
              <Input id={id('hours')} inputMode="numeric" value={value.hours} onChange={(e) => set('hours', e.target.value)} />
            </Field>
            <Field label="Minutes" htmlFor={id('minutes')}>
              <Input id={id('minutes')} inputMode="numeric" value={value.minutes} onChange={(e) => set('minutes', e.target.value)} />
            </Field>
          </div>
        ) : null}
        {showsField.narrators(f) ? (
          <Field label="Narrators (one per line)" htmlFor={id('narrators')} error={firstError(errors, 'narrators')} locked={locked('narrators')}>
            <SuggestInput
              id={id('narrators')}
              dir="auto"
              multiline
              rows={2}
              mode="lines"
              options={suggestions.contributors}
              newLabel={suggestions.ready ? 'New person' : undefined}
              value={value.narrators}
              onChange={(v) => set('narrators', v)}
            />
          </Field>
        ) : null}
        <Field label="Translators (one per line)" htmlFor={id('translators')} error={firstError(errors, 'translators')} locked={locked('translators')}>
          <SuggestInput
            id={id('translators')}
            dir="auto"
            multiline
            rows={1}
            mode="lines"
            options={suggestions.contributors}
            newLabel={suggestions.ready ? 'New person' : undefined}
            value={value.translators}
            onChange={(v) => set('translators', v)}
          />
        </Field>
        {text('language', 'Edition language', undefined, suggestions.languages)}
        {showsField.shelfLocation(f) ? text('shelfLocation', 'Shelf location', 'e.g. Living room, top shelf', suggestions.shelfLocations) : null}
      </MoreDetails>
    </div>
  )
}
