import { volumeLabel, type SessionMode } from '@mylib/domain'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { formatLabel } from '@/lib/format'
import type { RouterOutputs } from '@/lib/trpc'
import { editionsForMode, resolveStartEdition, singleVolumeSet } from './start-edition'

type Edition = RouterOutputs['catalog']['get']['editions'][number]

function editionLabel(e: Edition): string {
  return [formatLabel[e.format], e.title, e.publisher, e.isbn13 ?? e.asin, volumeLabel(e.volume, e.volumeCount)].filter((part) => part !== null && part !== '').join(' · ')
}

/** Spec §7: "+ edition if several of that format". Renders nothing when zero or one edition matches the mode. */
export function EditionPicker({
  id,
  editions,
  mode,
  value,
  onChange,
}: {
  id: string
  editions: readonly Edition[]
  mode: SessionMode
  value: string | null
  onChange: (editionId: string | null) => void
}) {
  const matching = editionsForMode(editions, mode)
  if (matching.length <= 1) return null
  return (
    <Field label={mode === 'listen' ? 'Which audiobook?' : 'Which edition?'} htmlFor={id}>
      <NativeSelect id={id} dir="auto" value={resolveStartEdition(editions, mode, value) ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
        {/* in one volume set "Not sure" would be overridden by volume 1, so it is not offered */}
        {singleVolumeSet(matching) === undefined ? <option value="">Not sure</option> : null}
        {matching.map((e) => (
          <option key={e.id} value={e.id} dir="auto">
            {editionLabel(e)}
          </option>
        ))}
      </NativeSelect>
    </Field>
  )
}
