/**
 * On a touch screen a dialog that opens on a text field pops the on-screen keyboard up over the sheet, and
 * focusing a button first gains nothing on touch: always start on the title and let the reader tap a field.
 * With a mouse or keyboard, keep Radix's default (the first control).
 */
interface FocusTarget {
  focus: () => void
}

/**
 * Radix returns focus on close only to the dialog's own Trigger, so a dialog opened from a menu item (no Trigger)
 * would drop focus on <body>. Given a ref, close focus goes there instead; the ref is read at close time, so the
 * caller can repoint it (e.g. to the next row after a delete). Spread onto DialogContent / AlertDialog.Content.
 */
export function returnFocusProps(ref: { readonly current: FocusTarget | null } | undefined): { onCloseAutoFocus?: (e: Event) => void } {
  if (ref === undefined) return {}
  return {
    onCloseAutoFocus: (e) => {
      e.preventDefault()
      ref.current?.focus()
    },
  }
}

export function openFocusTarget(coarsePointer: boolean): 'title' | 'default' {
  return coarsePointer ? 'title' : 'default'
}
