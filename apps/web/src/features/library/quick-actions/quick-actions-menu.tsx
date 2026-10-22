import type { ComponentType, ReactNode } from 'react'
import { StarRating } from '@/components/star-rating'
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { RATING_STEPS, type QuickAction, type SetAction } from './quick-action-model'
import type { QuickActions } from './use-quick-actions'
import type { SeriesQuickActions } from './use-series-quick-actions'

interface ItemProps {
  disabled?: boolean
  onSelect?: (e: Event) => void
  children?: ReactNode
}

/** The parts of a Radix menu the quick actions use: the right-click menu and the ⋯ menu render the same items. */
export interface MenuKit {
  Item: ComponentType<ItemProps>
  CheckboxItem: ComponentType<ItemProps & { checked?: boolean }>
  RadioGroup: ComponentType<{ value?: string; onValueChange?: ((value: string) => void); children?: ReactNode }>
  RadioItem: ComponentType<{ value: string; disabled?: boolean; onSelect?: (e: Event) => void; 'aria-label'?: string; children?: ReactNode }>
  Sub: ComponentType<{ children?: ReactNode }>
  SubTrigger: ComponentType<{ children?: ReactNode }>
  SubContent: ComponentType<{ className?: string; children?: ReactNode }>
  Separator: ComponentType<object>
}

export const contextKit: MenuKit = {
  Item: ContextMenuItem,
  CheckboxItem: ContextMenuCheckboxItem,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  Separator: ContextMenuSeparator,
}

export const dropdownKit: MenuKit = {
  Item: DropdownMenuItem,
  CheckboxItem: DropdownMenuCheckboxItem,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  Separator: DropdownMenuSeparator,
}

const starsLabel = (v: number) => `${String(v)} ${v === 1 ? 'star' : 'stars'}`

/** "Add to set": a submenu of checkbox items that stays open, so several sets can be toggled in a row. */
export function SetsSubmenu({
  kit: K,
  sets,
  pending,
  run,
}: {
  kit: MenuKit
  sets: SetAction[] | 'loading' | null
  pending: (id: string) => boolean
  run: (action: SetAction) => void
}) {
  if (sets === null) return null
  return (
    <K.Sub>
      <K.SubTrigger>Add to set</K.SubTrigger>
      <K.SubContent className="max-h-72 max-w-64 overflow-y-auto">
        {sets === 'loading' ? (
          <K.Item disabled>Loading…</K.Item>
        ) : (
          sets.map((a) => (
            <K.CheckboxItem
              key={a.id}
              checked={a.checked}
              disabled={pending(a.id)}
              onSelect={(e) => {
                e.preventDefault()
                run(a)
              }}
            >
              <span className="min-w-0 truncate" dir="auto">
                {a.label}
              </span>
            </K.CheckboxItem>
          ))
        )}
      </K.SubContent>
    </K.Sub>
  )
}

export function QuickActionsMenuItems({ kit: K, actions }: { kit: MenuKit; actions: QuickActions }) {
  const { model, run, rate, pending } = actions
  const item = (a: QuickAction) => (
    <K.Item key={a.id} disabled={a.kind === 'loading' || pending(a.id)} onSelect={() => run(a)}>
      {a.label}
    </K.Item>
  )
  return (
    <>
      {model.reading.map(item)}
      <K.Separator />
      {item(model.queue)}
      {/* a submenu of radio items, not star buttons: a menu's arrow keys only move between items */}
      <K.Sub>
        <K.SubTrigger>Rate</K.SubTrigger>
        <K.SubContent>
          <K.RadioGroup value={model.rating.value === null ? '' : String(model.rating.value)} onValueChange={(v) => rate(Number(v))}>
            {RATING_STEPS.map((v) => (
              <K.RadioItem key={v} value={String(v)} aria-label={starsLabel(v)}
                disabled={pending('rate')}
                // stays open: the value change still fires, the menu just is not closed by it
                onSelect={(e) => e.preventDefault()}
              >
                <span aria-hidden>
                  <StarRating value={v} size="sm" />
                </span>
              </K.RadioItem>
            ))}
          </K.RadioGroup>
          {model.rating.clear !== null ? (
            <>
              <K.Separator />
              {item(model.rating.clear)}
            </>
          ) : null}
        </K.SubContent>
      </K.Sub>
      <SetsSubmenu kit={K} sets={model.sets} pending={pending} run={run} />
      {model.merge !== null ? (
        <>
          <K.Separator />
          {item(model.merge)}
        </>
      ) : null}
    </>
  )
}

/** The menu items of a series card: Up next, Mark all as read, the Series continuation toggle, then the sets. */
export function SeriesMenuItems({ kit: K, actions }: { kit: MenuKit; actions: SeriesQuickActions }) {
  const { model, run, pending } = actions
  return (
    <>
      {model.main.map((a) => (
        <K.Item key={a.id} disabled={a.kind === 'loading' || a.kind === 'info' || pending(a.id)} onSelect={() => run(a)}>
          {a.label}
        </K.Item>
      ))}
      <K.Sub>
        <K.SubTrigger>{model.markAs.label}</K.SubTrigger>
        <K.SubContent>
          {model.markAs.options.map((o) => (
            <K.Item key={o.id} disabled={pending(o.id)} onSelect={() => run(o)}>
              {o.label}
            </K.Item>
          ))}
        </K.SubContent>
      </K.Sub>
      <SetsSubmenu kit={K} sets={model.sets} pending={pending} run={run} />
    </>
  )
}
