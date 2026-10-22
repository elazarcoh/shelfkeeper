import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { firstInvalidField } from '@/components/field'
import { Button } from '@/components/ui/button'
import { hasOptionalError, optionalPanelHiddenClass } from '@/features/book/add-book-rules'
import type { FieldErrors } from '@/lib/form'
import { cn } from '@/lib/utils'

/**
 * Optional fields. Below sm they sit behind a "More details" toggle; from sm up everything shows and the toggle is gone.
 * The fields stay mounted either way. A validation error on an optional field (a new `errors` object with a matching key)
 * opens the panel and, when no field above it is invalid, moves focus to the first invalid field (Field marks it aria-invalid
 * and describes it by its message, so it is announced).
 */
export function MoreDetails({
  collapsible,
  errors,
  isOptionalKey,
  children,
}: {
  collapsible: boolean
  errors: FieldErrors
  isOptionalKey: (key: string) => boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const focusedFor = useRef<FieldErrors | null>(null)
  const optionalError = hasOptionalError(errors, isOptionalKey)

  useEffect(() => {
    if (optionalError) setOpen(true)
  }, [errors, optionalError])

  useEffect(() => {
    if (!collapsible || !optionalError || !open || focusedFor.current === errors) return
    focusedFor.current = errors
    const first = firstInvalidField(panel.current?.closest('form'))
    if (first && panel.current?.contains(first)) first.focus()
  }, [collapsible, errors, open, optionalError])

  if (!collapsible) return <>{children}</>
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        // -ms-3: the label lines up with the field labels (the ghost button's padding is invisible)
        className="-ms-3 justify-self-start sm:hidden"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        More details
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </Button>
      <div id={panelId} ref={panel} className={cn('grid gap-4', optionalPanelHiddenClass(collapsible, open))}>
        {children}
      </div>
    </>
  )
}
