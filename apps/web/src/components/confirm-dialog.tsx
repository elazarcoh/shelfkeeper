import { AlertDialog } from 'radix-ui'
import type { ReactNode, RefObject } from 'react'
import { returnFocusProps } from '@/components/dialog-focus'
import { Button } from '@/components/ui/button'
import { dialogSurfaceClass } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

interface ConfirmDialogProps {
  title: string
  description?: ReactNode
  confirmLabel: string
  cancelLabel?: string | undefined
  destructive?: boolean | undefined
  onConfirm: () => void
  /** uncontrolled: the element that opens it */
  trigger?: ReactNode
  /** controlled: e.g. opened from a menu item */
  open?: boolean | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
  /** controlled: where focus goes on close (Radix returns it only to its own Trigger), e.g. the menu's button */
  returnFocusRef?: RefObject<HTMLElement | null> | undefined
}

/** Replaces window.confirm: a bottom sheet on phones, a centred dialog from sm. */
export function ConfirmDialog({ title, description, confirmLabel, cancelLabel = 'Cancel', destructive = false, onConfirm, trigger, open, onOpenChange, returnFocusRef }: ConfirmDialogProps) {
  return (
    <AlertDialog.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange !== undefined ? { onOpenChange } : {})}>
      {trigger !== undefined ? <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger> : null}
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <AlertDialog.Content
          className={cn(dialogSurfaceClass('surface'), 'sm:max-w-md')}
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          {...returnFocusProps(returnFocusRef)}
        >
          <div className="grid grid-cols-1 gap-2 text-start">
            <AlertDialog.Title className="text-lg font-semibold break-words text-match-parent" dir="auto">
              {title}
            </AlertDialog.Title>
            {description !== undefined ? (
              <AlertDialog.Description className="text-sm text-muted-foreground break-words text-match-parent" dir="auto">
                {description}
              </AlertDialog.Description>
            ) : null}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button variant="outline">{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
