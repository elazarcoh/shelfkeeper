import { Search } from 'lucide-react'
import { useEffect, useId, useState, type CSSProperties } from 'react'
import { SearchInput } from '@/components/ui/search-input'
import { useDebounced } from '@/lib/use-debounced'

/** Controlled by the URL value; reports changes only once typing settles, but clearing (× or Esc, #98) reports at
 *  once. `count` ("12 books") shows at the field's end below lg, where the search row is sticky and the page header
 *  with the count has scrolled away (#12); while there's text it sits just before the clear button. */
export function SearchBox({ value, onChange, label, count }: { value: string; onChange: (v: string) => void; label: string; count?: string | undefined }) {
  const [text, setText] = useState(value)
  const settled = useDebounced(text, 250)
  const countId = useId()

  useEffect(() => {
    setText(value)
  }, [value])

  useEffect(() => {
    if (settled === text && settled !== value) onChange(settled)
  }, [settled, text, value, onChange])

  return (
    <div className="relative">
      {/* centred, so it stays level with the text when a coarse pointer makes the field 44px */}
      <Search className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
      <SearchInput
        aria-label={label}
        aria-describedby={count !== undefined ? countId : undefined}
        placeholder="Search title, author, series, narrator…"
        // the typed text and the placeholder stop short of the count and the clear button (1ch of the field's text is
        // wider than one of its xs digits)
        className={
          count !== undefined
            ? text !== ''
              ? 'pl-8 text-ellipsis max-lg:pr-[calc(var(--count-ch)*1ch+2.75rem)] max-lg:pointer-coarse:pr-[calc(var(--count-ch)*1ch+3.25rem)]'
              : 'pl-8 text-ellipsis max-lg:pr-[calc(var(--count-ch)*1ch+1rem)]'
            : 'pl-8'
        }
        style={count !== undefined ? ({ '--count-ch': count.length } as CSSProperties) : undefined}
        value={text}
        onValueChange={(v) => {
          setText(v)
          if (v === '') onChange('')
        }}
        trailing={
          count !== undefined ? (
            <span id={countId} className={`text-xs whitespace-nowrap text-muted-foreground lg:hidden ${text === '' ? 'pe-2.5' : ''}`}>
              {count}
            </span>
          ) : null
        }
      />
    </div>
  )
}
