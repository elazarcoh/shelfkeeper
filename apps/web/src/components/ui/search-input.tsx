import { X } from 'lucide-react'
import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react'
import { cn } from 'cn'
import { Input } from './input'

type Props = Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'ref'> & {
  value: string
  onValueChange: (value: string) => void
  /** Sits before the clear button at the field's end, e.g. the Library's "12 books"; the caller pads the text for it. */
  trailing?: ReactNode
  wrapperClassName?: string
}

/** An Input with a clear (×) button at its end while it has text (#98). Esc clears it too; when it's empty Esc is
 *  left alone (a dialog around it closes as before). */
export function SearchInput({ value, onValueChange, trailing, wrapperClassName, className, ...props }: Props) {
  const ref = useRef<HTMLInputElement>(null)
  const hasText = value !== ''
  const latest = useRef({ hasText, onValueChange })
  latest.current = { hasText, onValueChange }

  // Radix dialogs listen for Esc on the document in the capture phase, before React's handlers; a window capture
  // listener runs first, so a non-empty field can clear itself and keep the dialog open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target !== ref.current || !latest.current.hasText) return
      e.preventDefault()
      e.stopPropagation()
      latest.current.onValueChange('')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className={cn('relative w-full', wrapperClassName)}>
      <Input ref={ref} {...props} value={value} onChange={(e) => onValueChange(e.target.value)} className={cn(hasText && 'pr-9 pointer-coarse:pr-11', className)} />
      {/* right, not end: the UI is left-to-right, while a dir="auto" field holding Hebrew turns its own end to the left */}
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center">
        {trailing}
        {hasText ? (
          <button
            type="button"
            aria-label="Clear search"
            className="pointer-events-auto flex size-9 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-11"
            onClick={() => {
              onValueChange('')
              ref.current?.focus()
            }}
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  )
}
