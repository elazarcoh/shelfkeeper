import { MAX_VOLUME, type ItemVolume } from '@mylib/domain'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type VolumeText = { volume: string; count: string }

export const fieldsFromVolume = (v: { number: number; count: number | null } | null): VolumeText => ({ volume: v === null ? '' : String(v.number), count: v?.count == null ? '' : String(v.count) })

const whole = (s: string): number | null => (/^\d{1,4}$/.test(s) ? Number(s) : null)

/** The person's volume: null when blank ("not a volume"), 'invalid' outside 1..999 or with a count below the volume. */
export function volumeFromFields(v: VolumeText): ItemVolume | null | 'invalid' {
  const volume = v.volume.trim()
  if (volume === '') return null
  const number = whole(volume)
  if (number === null || number < 1 || number > MAX_VOLUME) return 'invalid'
  const count = v.count.trim()
  if (count === '') return { number, count: null }
  const total = whole(count)
  if (total === null || total < number || total > MAX_VOLUME) return 'invalid'
  return { number, count: total }
}

/** Volume and "of" inputs, the edition form's pair; an empty volume means "not a volume". */
export function VolumeFields({ value, onChange, idPrefix }: { value: VolumeText; onChange: (v: VolumeText) => void; idPrefix: string }) {
  const bad = volumeFromFields(value) === 'invalid'
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor={`${idPrefix}-volume`} className="text-sm">
        Volume
      </Label>
      <Input
        id={`${idPrefix}-volume`}
        inputMode="numeric"
        className="w-20 pointer-coarse:min-h-11"
        aria-invalid={bad}
        value={value.volume}
        onChange={(e) => onChange({ ...value, volume: e.target.value })}
      />
      <Label htmlFor={`${idPrefix}-volume-count`} className="text-sm">
        of
      </Label>
      <Input
        id={`${idPrefix}-volume-count`}
        inputMode="numeric"
        className="w-20 pointer-coarse:min-h-11"
        aria-invalid={bad}
        disabled={value.volume.trim() === ''}
        value={value.count}
        onChange={(e) => onChange({ ...value, count: e.target.value })}
      />
    </div>
  )
}
