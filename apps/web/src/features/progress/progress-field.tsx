import { volumeLabel, type ProgressKind, type SessionProgressInfo } from '@mylib/domain'
import { Field } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { lengthPrompt, lowerThanLatestNote, offeredKinds, readDraft, type DraftErrors, type ProgressDraft } from './progress-draft'

const LABEL: Record<ProgressKind, string> = { page: 'Page', seconds: 'Time (h:mm:ss)', percent: 'Percent' }
const TOGGLE: Record<ProgressKind, string> = { page: 'Page', seconds: 'Time', percent: '%' }
const PLACEHOLDER: Record<ProgressKind, string> = { page: 'e.g. 120', seconds: 'e.g. 5:30', percent: 'e.g. 45' }

interface ProgressFieldProps {
  /** ids: `${id}-value`, `${id}-length` (focus targets after a failed save) */
  id: string
  info: SessionProgressInfo
  draft: ProgressDraft
  onChange: (draft: ProgressDraft) => void
  errors: DraftErrors
  /** the check-in labels it "(optional)" */
  optional?: boolean | undefined
  /** false when editing an existing point: no length prompt */
  askLength?: boolean | undefined
  /** a muted line under the value (the check-in's "last: p. 180, Tue"), after the soft "of N pages" */
  note?: string | undefined
  /** editing: the point's own kind stays on offer even if its edition changed or is gone (RP11) */
  ownKind?: ProgressKind | undefined
}

/**
 * A soft "of 400 pages" when the edition's page count is known: it catches a typo like 5600 without blocking it. In a
 * volume set (#66) it says which volume the number is in: "Vol 2 of 2 · of 600 pages".
 */
export function lengthNote(kind: ProgressKind, info: SessionProgressInfo): string | undefined {
  const pages = kind === 'page' && info.pageCount !== null && info.pageCount > 0 ? `of ${info.pageCount} pages` : undefined
  const volume = info.volume === null ? null : volumeLabel(info.volume.volume, info.volume.size)
  return [volume, pages].filter((part) => part !== null && part !== undefined).join(' · ') || undefined
}

/** Where the reader is, in the unit the edition allows (spec §5): a page, a time, or (ebooks) a page / % toggle. */
export function ProgressField({ id, info, draft, onChange, errors, optional = false, askLength = true, note, ownKind }: ProgressFieldProps) {
  const allowed = offeredKinds(info.editionFormat, ownKind)
  const prompt = askLength && draft.value.trim() !== '' ? lengthPrompt(draft, info) : null
  // adding only: an edited point is often an older one, naturally below the latest
  const lower = askLength ? (lowerThanLatestNote(readDraft(draft, info), info) ?? undefined) : undefined
  const hint = [lengthNote(draft.kind, info), note, lower].filter((part) => part !== undefined).join(' · ')
  return (
    <div className="grid grid-cols-1 gap-3">
      {allowed.length > 1 ? (
        <div role="group" aria-label="Progress as" className="flex flex-wrap gap-2">
          {allowed.map((kind) => (
            <Button
              key={kind}
              type="button"
              size="sm"
              className="pointer-coarse:min-w-11"
              variant={draft.kind === kind ? 'default' : 'outline'}
              aria-pressed={draft.kind === kind}
              {...(kind === 'percent' ? { 'aria-label': 'Percent' } : {})}
              onClick={() => onChange({ ...draft, kind, value: '' })}
            >
              {TOGGLE[kind]}
            </Button>
          ))}
        </div>
      ) : null}
      <Field label={`${LABEL[draft.kind]}${optional ? ' (optional)' : ''}`} htmlFor={`${id}-value`} error={errors.value} hint={hint === '' ? undefined : hint}>
        <Input
          id={`${id}-value`}
          inputMode={draft.kind === 'page' ? 'numeric' : draft.kind === 'percent' ? 'decimal' : 'text'}
          autoComplete="off"
          placeholder={PLACEHOLDER[draft.kind]}
          value={draft.value}
          onChange={(e) => onChange({ ...draft, value: e.target.value })}
        />
      </Field>
      {prompt !== null ? (
        <Field
          label={prompt === 'pageCount' ? 'Of how many pages?' : 'How long is it? (h:mm)'}
          htmlFor={`${id}-length`}
          error={errors.length}
          hint="Saved to this edition, so this update counts in your stats. You can skip it."
        >
          <Input
            id={`${id}-length`}
            inputMode={prompt === 'pageCount' ? 'numeric' : 'text'}
            autoComplete="off"
            value={draft.length}
            onChange={(e) => onChange({ ...draft, length: e.target.value })}
          />
        </Field>
      ) : null}
    </div>
  )
}
