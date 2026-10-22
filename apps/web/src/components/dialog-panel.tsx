import type { ReactNode, SubmitEvent } from 'react'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface DialogPanelProps {
  title: ReactNode
  description?: ReactNode
  /** pinned at the bottom while the body scrolls (Save, Show results…) */
  footer: ReactNode
  /** given: the panel is a <form> and the footer's type="submit" button submits it */
  onSubmit?: ((e: SubmitEvent<HTMLFormElement>) => void) | undefined
  children: ReactNode
}

/** For `<DialogContent bare>`: the title stays at the top and the footer at the bottom while long content scrolls between. */
export function DialogPanel({ title, description, footer, onSubmit, children }: DialogPanelProps) {
  const body = (
    <>
      {/* pe-14 keeps the title clear of DialogContent's ✕ (44px under a coarse pointer) */}
      <DialogHeader className="shrink-0 border-b py-3 ps-4 pe-14 sm:py-4 sm:ps-6 pointer-coarse:min-h-14 pointer-coarse:justify-center">
        <DialogTitle>{title}</DialogTitle>
        {description !== undefined ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">{children}</div>
      <DialogFooter className="shrink-0 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">{footer}</DialogFooter>
    </>
  )
  return onSubmit !== undefined ? (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
      {body}
    </form>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">{body}</div>
  )
}
