import { useState, type ReactNode } from 'react'
import type { SeriesGroupCard, WorkCard } from '@mylib/domain'
import { MergeWorkDialog } from '@/features/book/merge-work-dialog'
import { QuickActionsMenuItems, SeriesMenuItems } from './quick-actions-menu'
import { QuickActionsShell, useQuickActionsOpen } from './quick-actions-shell'
import { QuickActionsSheet, SeriesQuickActionsSheet } from './quick-actions-sheet'
import { useQuickActions } from './use-quick-actions'
import { useSeriesQuickActions } from './use-series-quick-actions'

interface Props<C> {
  card: C
  isAdmin: boolean
  layout: 'tile' | 'row'
  /** the card itself (its <Link>); the ⋯ button is its sibling, never inside the link */
  children: ReactNode
}

/** A Library work card's quick actions: right-click and ⋯ menus on a fine pointer, a long-press sheet on touch. */
export function QuickActions({ card, isAdmin, layout, children }: Props<WorkCard>) {
  const state = useQuickActionsOpen()
  const [merging, setMerging] = useState(false)
  const actions = useQuickActions(card, isAdmin, state.open, () => setMerging(true))
  return (
    <>
      <QuickActionsShell
        title={card.title}
        layout={layout}
        state={state}
        menu={(kit) => <QuickActionsMenuItems kit={kit} actions={actions} />}
        sheet={(open, onOpenChange) => <QuickActionsSheet title={card.title} open={open} onOpenChange={onOpenChange} actions={actions} />}
      >
        {children}
      </QuickActionsShell>
      {/* outside the shell: it must outlive the menu or sheet that opened it */}
      {isAdmin ? <MergeWorkDialog open={merging} onOpenChange={setMerging} source={{ id: card.id, title: card.title }} returnFocusRef={state.triggerRef} /> : null}
    </>
  )
}

/** A Library series card's quick actions: Up next, Mark all as read, the Series continuation toggle, and the sets, on the same triggers. */
export function SeriesQuickActions({ card: group, isAdmin, layout, children }: Props<SeriesGroupCard>) {
  const state = useQuickActionsOpen()
  const actions = useSeriesQuickActions(group, isAdmin, state.open)
  return (
    <QuickActionsShell
      title={group.name}
      layout={layout}
      state={state}
      menu={(kit) => <SeriesMenuItems kit={kit} actions={actions} />}
      sheet={(open, onOpenChange) => <SeriesQuickActionsSheet title={group.name} open={open} onOpenChange={onOpenChange} actions={actions} />}
    >
      {children}
    </QuickActionsShell>
  )
}
