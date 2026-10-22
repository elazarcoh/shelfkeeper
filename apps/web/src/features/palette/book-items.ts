import { tokenize } from '@mylib/domain'
import type { QuickAction, QuickActionModel } from '@/features/library/quick-actions/quick-action-model'
import { matchLabel } from './palette-model'

type ActionItem = { id: string; label: string; action: QuickAction; disabled: boolean }
export type BookItem = { id: 'open'; label: 'Open book' } | ActionItem

const LOADING_SETS: QuickAction = { kind: 'loading', id: 'loading', label: 'Loading sets…' }

/** The palette's Book screen: Open book, then the card menu's actions. No Merge (its own dialog) and no rating steps (a submenu). */
export function bookItems(model: QuickActionModel): BookItem[] {
  const action = (a: QuickAction): ActionItem => ({ id: a.id, label: a.label, action: a, disabled: a.kind === 'loading' })
  const items: BookItem[] = [{ id: 'open', label: 'Open book' }, ...model.reading.map(action), action(model.queue)]
  if (model.rating.clear !== null) items.push(action(model.rating.clear))
  if (model.sets === 'loading') items.push({ id: 'loading-sets', label: LOADING_SETS.label, action: LOADING_SETS, disabled: true })
  else if (model.sets !== null) {
    for (const s of model.sets) items.push({ ...action(s), label: s.checked ? `Remove from set ${s.label}` : `Add to set ${s.label}` })
  }
  return items
}

/** An empty query shows every action; otherwise the label must match it. */
export function matchesQuery(query: string, label: string): boolean {
  return tokenize(query).length === 0 || matchLabel(query, label) !== null
}
