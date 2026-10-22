import { Lock } from 'lucide-react'
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Label } from '@/components/ui/label'
import type { FieldErrors } from '@/lib/form'

interface FieldProps {
  label: string
  htmlFor: string
  error?: string | undefined
  hint?: string | undefined
  locked?: boolean | undefined
  children: ReactNode
}

/**
 * The first control in `root` that a Field marks invalid: where a form moves focus after a failed validation (Add book's
 * More details, the edit dialogs). Field also describes it by its message, so focusing it announces the error.
 */
export function firstInvalidField(root: ParentNode | null | undefined): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? null
}

/** A failed submit in a form with every field showing (the edit dialogs): render the errors now, then focus the first invalid field. */
export function showFieldErrors(form: HTMLFormElement, errors: FieldErrors, setErrors: (errors: FieldErrors) => void): void {
  flushSync(() => setErrors(errors))
  firstInvalidField(form)?.focus()
}

export function Field({ label, htmlFor, error, hint, locked, children }: FieldProps) {
  const noteId = `${htmlFor}-note`
  const hasNote = error !== undefined || hint !== undefined
  // the control gets aria-invalid and aria-describedby, so a screen reader reads the message when the field takes focus;
  // a description the control already has is kept, the note's id joins it
  const own = isValidElement(children) ? (children.props as { id?: string; 'aria-describedby'?: string }) : undefined
  const control =
    isValidElement(children) && own?.id === htmlFor
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          ...(error !== undefined ? { 'aria-invalid': true } : {}),
          ...(hasNote ? { 'aria-describedby': [own['aria-describedby'], noteId].filter((id) => id !== undefined && id !== '').join(' ') } : {}),
        })
      : children
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="flex items-center gap-1.5">
        {label}
        {locked ? (
          <span title="Edited by hand — automatic updates will not overwrite this">
            <Lock className="size-3 text-muted-foreground" aria-label="locked" />
          </span>
        ) : null}
      </Label>
      {control}
      {error !== undefined ? (
        <p id={noteId} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={noteId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
