import { useRef } from 'react'

/**
 * Focus after a removal (the one pattern for every list on the site): the next row's matching control, else the
 * section's heading (tabIndex -1, with a focus ring), picked when the removal is confirmed — both outlive the row.
 * - Behind a ConfirmDialog or a menu: `useRemovalFocus` (wire it as its doc says).
 * - An ✕ that removes at once: `focusAfterRemoval(e.currentTarget, selector, headingId)` in its click handler.
 */
export function firstFollowing<T>(candidates: readonly T[], follows: (candidate: T) => boolean, shown: (candidate: T) => boolean = () => true): T | null {
  return candidates.find((c) => follows(c) && shown(c)) ?? null
}

/** Not display:none, itself or through an ancestor: a row can carry a phone-only and a desktop-only copy of its control. */
const rendered = (el: HTMLElement) => el.getClientRects().length > 0

/** The first rendered `selector` match after `trigger` in document order (the next row's control), else the element `fallbackId` (a tabIndex -1 heading). */
export function focusTargetAfterRemoval(trigger: HTMLElement | null, selector: string, fallbackId: string): HTMLElement | null {
  const next =
    trigger === null
      ? null
      : firstFollowing(
          [...document.querySelectorAll<HTMLElement>(selector)],
          (c) => (trigger.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          rendered,
        )
  return next ?? document.getElementById(fallbackId)
}

/**
 * Undoes the move when the removal fails and the row stays: focus goes back to its trigger, but only if focus is
 * still where the removal put it (or nowhere), so someone who has moved on is not pulled back.
 */
function restoreFocus(trigger: HTMLElement | null, movedTo: HTMLElement | null): void {
  if (!trigger?.isConnected) return
  const active = document.activeElement
  if (active === movedTo || active === null || active === document.body) trigger.focus()
}

/**
 * For a control that removes its own row at once (no dialog): move focus on now, before the row unmounts. Returns
 * `restore`, for the removal's onError.
 */
export function focusAfterRemoval(trigger: HTMLElement, selector: string, fallbackId: string): () => void {
  const target = focusTargetAfterRemoval(trigger, selector, fallbackId)
  target?.focus()
  return () => {
    restoreFocus(trigger, target)
  }
}

/**
 * Close focus for a ConfirmDialog or menu whose action removes its own row (and trigger): the trigger on Cancel, else
 * a target picked at confirm time that outlives the row. Wire `triggerRef` to the trigger button (a dialog's, or the
 * ⋯ of the menu it opens from), and pass `closeFocus` as the ConfirmDialog's `returnFocusRef` (or spread
 * `returnFocusProps(closeFocus)` onto a DropdownMenuContent) and `onOpenChange` to the ConfirmDialog or DropdownMenu.
 * Call `retarget` when the removal is confirmed, and `restore` from the removal's onError (the row stayed).
 */
export function useRemovalFocus() {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeFocus = useRef<HTMLElement | null>(null)
  return {
    triggerRef,
    closeFocus,
    onOpenChange: (open: boolean) => {
      if (open) closeFocus.current = triggerRef.current
    },
    retarget: (selector: string, fallbackId: string) => {
      closeFocus.current = focusTargetAfterRemoval(triggerRef.current, selector, fallbackId)
    },
    restore: () => {
      const movedTo = closeFocus.current
      // a fast failure can beat the menu's or dialog's close (which reads closeFocus then): point it back too
      closeFocus.current = triggerRef.current
      restoreFocus(triggerRef.current, movedTo)
    },
  }
}
