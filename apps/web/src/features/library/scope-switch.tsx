import { useId } from 'react'
import { cn } from '@/lib/utils'

export type LibraryScope = 'library' | 'catalog'

const options: { value: LibraryScope; label: string }[] = [
  { value: 'library', label: 'My library' },
  { value: 'catalog', label: 'Whole catalog' },
]

/**
 * My library | Whole catalog, as a segmented radio group: native radios (arrow keys move and choose), each stretched
 * over its whole segment so the segment is the target (44px tall on a touch screen).
 */
export function ScopeSwitch({ value, onChange, className }: { value: LibraryScope; onChange: (scope: LibraryScope) => void; className?: string | undefined }) {
  const name = useId()
  return (
    <div role="radiogroup" aria-label="Show" className={cn('grid w-full grid-cols-2 rounded-lg bg-muted p-[3px] sm:inline-grid sm:w-auto', className)}>
      {options.map((o) => (
        <label
          key={o.value}
          className="relative flex min-h-9 min-w-0 items-center justify-center rounded-md border border-transparent px-3 text-sm font-medium text-foreground/60 transition-colors hover:text-foreground has-checked:bg-background has-checked:text-foreground has-checked:shadow-sm has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50 pointer-coarse:min-h-11 dark:text-muted-foreground dark:has-checked:border-input dark:has-checked:bg-input/30 dark:has-checked:text-foreground"
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-md opacity-0"
          />
          <span className="truncate">{o.label}</span>
        </label>
      ))}
    </div>
  )
}
