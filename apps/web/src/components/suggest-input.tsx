import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ComponentProps, type KeyboardEvent, type SyntheticEvent } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { applyPick, currentSegment, indexOptions, matchOptions, newItems, newNote, otherItems, type SuggestMode } from './suggest-logic'

type Passthrough = Pick<
  ComponentProps<'input'>,
  'id' | 'dir' | 'placeholder' | 'className' | 'inputMode' | 'required' | 'aria-label' | 'aria-invalid' | 'aria-describedby'
>

export interface SuggestInputProps extends Passthrough {
  value: string
  /** `picked` is the chosen name when the change came from a suggestion */
  onChange: (value: string, picked?: string) => void
  options: readonly string[]
  mode?: SuggestMode
  /** a textarea (for one-per-line fields) */
  multiline?: boolean
  rows?: number
  /** e.g. "New series": shown when the field holds a name that is not in `options` */
  newLabel?: string | undefined
}

type TextControl = HTMLInputElement | HTMLTextAreaElement

/**
 * A text field that offers existing names as you type (ARIA combobox). Free text is always allowed; a suggestion
 * replaces only the item under the caret (the line, or the comma-separated entry).
 */
export function SuggestInput({ value, onChange, options, mode = 'single', multiline = false, rows, newLabel, ...rest }: SuggestInputProps) {
  const listId = useId()
  const noteId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const [caret, setCaret] = useState(value.length)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const index = useMemo(() => indexOptions(options), [options])
  const matches = useMemo(
    () => matchOptions(currentSegment(value, caret, mode).text, index, otherItems(value, caret, mode)),
    [value, caret, mode, index],
  )
  const shown = open && matches.length > 0
  const fresh = useMemo(() => (newLabel === undefined ? [] : newItems(value, mode, index)), [newLabel, value, mode, index])
  const note = newLabel !== undefined && fresh.length > 0 ? newNote(newLabel, fresh, mode) : ''

  // after a pick, put the caret right after the inserted name
  useEffect(() => {
    const at = pendingCaret.current
    const el = inputRef.current ?? areaRef.current
    if (at === null || el === null) return
    pendingCaret.current = null
    el.setSelectionRange(at, at)
  }, [value])

  // Esc closes the list, not the dialog around it: Radix listens for Escape on the document, so stop it at the window
  useEffect(() => {
    if (!shown) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target !== inputRef.current && e.target !== areaRef.current)) return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [shown])

  // a list opened near the bottom of a scrolling dialog must not extend the scroll area out of view
  useEffect(() => {
    if (shown) listRef.current?.scrollIntoView({ block: 'nearest' })
  }, [shown])

  const track = (el: TextControl) => setCaret(el.selectionStart ?? el.value.length)

  function pick(name: string) {
    const next = applyPick(value, currentSegment(value, caret, mode), name, mode)
    pendingCaret.current = next.caret
    setCaret(next.caret)
    setOpen(false)
    setActive(-1)
    onChange(next.value, name)
  }

  function handleChange(e: ChangeEvent<TextControl>) {
    track(e.target)
    setOpen(true)
    setActive(-1)
    onChange(e.target.value)
  }

  function handleKeyDown(e: KeyboardEvent<TextControl>) {
    if (!shown || e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % matches.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i <= 0 ? matches.length - 1 : i - 1))
    } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0 && active < matches.length) {
      e.preventDefault()
      const chosen = matches[active]
      if (chosen !== undefined) pick(chosen)
    }
  }

  const describedBy = [rest['aria-describedby'], note === '' ? undefined : noteId].filter((v) => v !== undefined && v !== '').join(' ')
  const control = {
    ...rest,
    value,
    role: 'combobox' as const,
    autoComplete: 'off',
    'aria-autocomplete': 'list' as const,
    'aria-expanded': shown,
    'aria-controls': shown ? listId : undefined,
    'aria-activedescendant': shown && active >= 0 ? `${listId}-${active}` : undefined,
    'aria-describedby': describedBy === '' ? undefined : describedBy,
    onChange: handleChange,
    onKeyDown: handleKeyDown,
    onSelect: (e: SyntheticEvent<TextControl>) => track(e.currentTarget),
    onBlur: () => setOpen(false),
  }

  return (
    <div className="grid min-w-0 gap-1">
      <div className="relative">
        {multiline ? <Textarea ref={areaRef} rows={rows} {...control} /> : <Input ref={inputRef} {...control} />}
        {shown ? (
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Suggestions"
            // keep focus in the field (so a pick lands at the caret, and grabbing the scrollbar does not close the list)
            onMouseDown={(e) => e.preventDefault()}
            className="absolute top-full right-0 left-0 z-50 mt-1 max-h-60 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {matches.map((name, i) => (
              <li
                key={name}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                dir="auto"
                className={cn(
                  'flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm break-words pointer-coarse:min-h-11',
                  i === active && 'bg-accent text-accent-foreground',
                )}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(name)}
              >
                {name}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <p id={noteId} aria-live="polite" className={cn('text-xs text-muted-foreground', note === '' && 'sr-only')} dir="auto">
        {note}
      </p>
    </div>
  )
}
