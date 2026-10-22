import { editionFormats } from '@mylib/domain'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { formatLabel } from '@/lib/format'
import { toggleFormat, type WishDraft } from './wish-form-state'

/** The wish's criteria: which formats would do (none = any), a language, a note. Controlled. */
export function WishFieldsEditor({ draft, onChange }: { draft: WishDraft; onChange: (next: WishDraft) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="grid gap-1.5">
        <div role="group" aria-label="Formats" className="flex flex-wrap gap-2">
          {editionFormats.map((f) => (
            <Button
              key={f}
              type="button"
              variant={draft.formats.includes(f) ? 'default' : 'outline'}
              aria-pressed={draft.formats.includes(f)}
              className="pointer-coarse:min-h-11"
              onClick={() => onChange(toggleFormat(draft, f))}
            >
              {formatLabel[f]}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">None picked = any format</p>
      </div>
      <Input aria-label="Language (optional)" placeholder="Language (optional)" dir="auto" maxLength={35} value={draft.language} onChange={(e) => onChange({ ...draft, language: e.target.value })} />
      <Textarea aria-label="Note (optional)" placeholder="Note (optional)" dir="auto" maxLength={500} rows={2} value={draft.note} onChange={(e) => onChange({ ...draft, note: e.target.value })} />
    </div>
  )
}
