import { whatNextFormats, whatNextMoods, type WhatNextFormat, type WhatNextMood } from '@mylib/domain'
import { Button } from '@/components/ui/button'

const MOOD_LABEL: Record<WhatNextMood, string> = { keep_going: 'Keep going', light: 'Something light', surprise: 'Surprise me' }
const FORMAT_LABEL: Record<WhatNextFormat, string> = { audio: 'Audiobook', any: 'Any format' }

function Chips<T extends string>({ label, values, text, value, onChange }: { label: string; values: readonly T[]; text: Record<T, string>; value: T; onChange: (next: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {values.map((v) => (
        <Button key={v} type="button" size="sm" variant={value === v ? 'default' : 'outline'} aria-pressed={value === v} className="pointer-coarse:min-h-11" onClick={() => onChange(v)}>
          {text[v]}
        </Button>
      ))}
    </div>
  )
}

export function MoodChips({ mood, format, onMood, onFormat }: { mood: WhatNextMood; format: WhatNextFormat; onMood: (m: WhatNextMood) => void; onFormat: (f: WhatNextFormat) => void }) {
  return (
    <div className="grid gap-3">
      <Chips label="Mood" values={whatNextMoods} text={MOOD_LABEL} value={mood} onChange={onMood} />
      <Chips label="Format" values={whatNextFormats} text={FORMAT_LABEL} value={format} onChange={onFormat} />
    </div>
  )
}
