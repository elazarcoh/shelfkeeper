import { MoreHorizontal } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { contextKit, dropdownKit, type MenuKit } from './quick-actions-menu'
import { useLongPress } from './use-long-press'

/** Whether a menu or the sheet is open: the card's actions fetch their data only then. */
export function useQuickActionsOpen() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  // the ⋯ button, where a dialog opened from a menu item returns focus (it has no Trigger of its own)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return { menuOpen, setMenuOpen, sheetOpen, setSheetOpen, open: menuOpen || sheetOpen, triggerRef }
}

interface Props {
  /** the card's name: the ⋯ button reads "Actions for <title>" */
  title: string
  layout: 'tile' | 'row'
  state: ReturnType<typeof useQuickActionsOpen>
  /** the menu's items, for the right-click menu and the ⋯ menu alike */
  menu: (kit: MenuKit) => ReactNode
  /** the touch sheet */
  sheet: (open: boolean, onOpenChange: (open: boolean) => void) => ReactNode
  /** the card itself (its <Link>); the ⋯ button is its sibling, never inside the link */
  children: ReactNode
}

/**
 * How a Library card opens its quick actions. Fine pointer: right-click menu, plus a ⋯ button shown on hover / focus.
 * Coarse pointer: long-press opens a sheet. Radix's ContextMenu is not mounted there: it has its own touch
 * long-press that would open the desktop menu instead.
 */
export function QuickActionsShell({ title, layout, state, menu, sheet, children }: Props) {
  const coarse = useMediaQuery('(pointer: coarse)')
  const longPress = useLongPress(() => state.setSheetOpen(true))

  if (coarse) {
    return (
      <>
        <div {...longPress} className="select-none [-webkit-touch-callout:none]">
          {children}
        </div>
        {/* outside the long-press element: React events from the portal would bubble into its handlers */}
        {sheet(state.sheetOpen, state.setSheetOpen)}
      </>
    )
  }

  return (
    <ContextMenu onOpenChange={state.setMenuOpen}>
      <ContextMenuTrigger asChild>
        <div className={cn('group/qa', layout === 'tile' ? 'relative' : 'flex items-center')}>
          {children}
          <DropdownMenu onOpenChange={state.setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                ref={state.triggerRef}
                variant="secondary"
                size="icon"
                aria-label={`Actions for ${title}`}
                className={cn(
                  'size-7 opacity-0 shadow-sm transition-opacity group-hover/qa:opacity-100 group-focus-within/qa:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
                  layout === 'tile' ? 'absolute end-1 top-1' : 'me-2 shrink-0',
                )}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{menu(dropdownKit)}</DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{menu(contextKit)}</ContextMenuContent>
    </ContextMenu>
  )
}
