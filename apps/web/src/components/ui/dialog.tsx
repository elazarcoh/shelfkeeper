"use client"

import * as React from "react"
import { cn } from "cn"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { openFocusTarget } from "@/components/dialog-focus"
import { Button } from "@/components/ui/button"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

/** Padding, gap and scrolling for a dialog's plain content. */
// grid-cols-1 (minmax(0,1fr)): an implicit auto column grows to a long unbroken title, scrolling the sheet sideways
const dialogPaddedScroll =
  "grid grid-cols-1 gap-4 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6"

/**
 * Phones: a bottom sheet that lifts above an iOS on-screen keyboard (--keyboard-inset, set by the shell) and,
 * while iOS has the page panned (--keyboard-pan), stays short enough for its title and ✕ to remain visible.
 * From sm: a centred dialog, centred in the part an iOS keyboard leaves visible (iPad).
 * - `scroll: "surface"`: the surface itself is the padded scroller (ConfirmDialog: nothing is pinned).
 * - `scroll: "inner"`: the surface is a non-scrolling flex column and a child scrolls (DialogContent, so its ✕
 *   and DialogPanel's header/footer stay put).
 */
function dialogSurfaceClass(scroll: "surface" | "inner"): string {
  return cn(
    "fixed inset-x-0 bottom-[var(--keyboard-inset,0px)] z-50 w-full max-h-[calc(100dvh-var(--keyboard-inset,0px)-var(--keyboard-pan,0px)-env(safe-area-inset-top)-1.5rem)] rounded-t-2xl border-t bg-background shadow-lg outline-none duration-200",
    "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
    "max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:slide-out-to-bottom",
    // from sm, centred in what the iOS keyboard leaves visible (iPad): the band [pan, 100% - inset] has its middle at
    // 50% + (pan - inset) / 2, and the dialog is no taller than that band
    "sm:inset-x-auto sm:bottom-auto sm:top-[calc(50%_+_(var(--keyboard-pan,0px)_-_var(--keyboard-inset,0px))_/_2)] sm:left-[50%] sm:max-h-[min(90dvh,calc(100dvh_-_var(--keyboard-inset,0px)_-_var(--keyboard-pan,0px)_-_2rem))] sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border",
    "sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:zoom-out-95",
    scroll === "surface" ? dialogPaddedScroll : "flex flex-col overflow-hidden"
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  bare = false,
  onOpenAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /** no padded scrolling body: the children (a DialogPanel) lay out the flex column themselves */
  bare?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(dialogSurfaceClass("inner"), className)}
        onOpenAutoFocus={(e) => {
          onOpenAutoFocus?.(e)
          if (e.defaultPrevented || !(e.currentTarget instanceof HTMLElement)) return
          const content = e.currentTarget
          if (openFocusTarget(window.matchMedia("(pointer: coarse)").matches) === "title") {
            e.preventDefault()
            ;(content.querySelector<HTMLElement>('[data-slot="dialog-title"]') ?? content).focus({ preventScroll: true })
          }
        }}
        {...props}
      >
        {/* `bare`: DialogPanel brings its own pinned header, scrolling body and footer; otherwise wrap in a padded scroller */}
        {bare ? children : <div data-slot="dialog-body" className={cn("min-h-0 flex-1", dialogPaddedScroll)}>{children}</div>}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-2.5 end-2.5 grid size-8 place-items-center rounded-md bg-background text-muted-foreground ring-offset-background transition-colors hover:text-foreground focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none pointer-coarse:top-1.5 pointer-coarse:end-1.5 pointer-coarse:size-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 pe-10 text-start", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      tabIndex={-1}
      className={cn("text-lg leading-none font-semibold outline-none", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  dialogSurfaceClass,
}
