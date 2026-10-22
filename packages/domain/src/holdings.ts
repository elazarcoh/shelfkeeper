import { z } from 'zod'
import { editionFormats, type Availability, type EditionFormat, type EditionOwnership, type HoldingEventType } from './enums'
import { boundedText } from './strings'

export interface HoldingState {
  ownership: EditionOwnership
  inPossession: boolean
}

export const holdingActions = ['no_longer_have', 'got_back', 'returned', 'borrowed_again', 'bought'] as const
export const HoldingAction = z.enum(holdingActions)
export type HoldingAction = z.infer<typeof HoldingAction>

export const HoldingChange = z.object({
  action: HoldingAction,
  on: z.iso.date(),
  note: boundedText(200).nullable().default(null),
})
export type HoldingChange = z.output<typeof HoldingChange>

/** Valid transitions of an edition's holding state, and the history event each one records. */
export function applyHoldingAction(
  state: HoldingState,
  action: HoldingAction,
): { next: HoldingState; event: HoldingEventType } | null {
  const { ownership, inPossession } = state
  switch (action) {
    case 'no_longer_have':
      return ownership === 'owned' && inPossession ? { next: { ownership, inPossession: false }, event: 'removed' } : null
    case 'got_back':
      return ownership === 'owned' && !inPossession ? { next: { ownership, inPossession: true }, event: 'restored' } : null
    case 'returned':
      return ownership === 'borrowed' && inPossession ? { next: { ownership, inPossession: false }, event: 'returned' } : null
    case 'borrowed_again':
      return ownership === 'borrowed' && !inPossession ? { next: { ownership, inPossession: true }, event: 'borrowed' } : null
    case 'bought':
      return ownership === 'borrowed' ? { next: { ownership: 'owned', inPossession: true }, event: 'acquired' } : null
  }
}

export function availableHoldingActions(state: HoldingState): HoldingAction[] {
  return holdingActions.filter((a) => applyHoldingAction(state, a) !== null)
}

export const initialHoldingEvent = (ownership: EditionOwnership): HoldingEventType =>
  ownership === 'owned' ? 'acquired' : 'borrowed'

/** Work availability from its editions, in precedence order. Mirrors the SQL in compileFilter. */
export function deriveAvailability(editions: readonly HoldingState[]): Availability {
  if (editions.length === 0) return 'wanted'
  if (editions.some((e) => e.ownership === 'owned' && e.inPossession)) return 'owned'
  if (editions.some((e) => e.ownership === 'borrowed' && e.inPossession)) return 'borrowed'
  if (editions.some((e) => e.ownership === 'owned')) return 'formerly_owned'
  return 'not_owned'
}

export interface CoverCandidate {
  format: EditionFormat
  coverAssetId: string | null
  createdAt: Date
  id: string
}

/**
 * The one cover shown for a book, picked the same way everywhere (R19): the earliest-format,
 * then oldest, then lowest-id edition that has one. Deterministic regardless of row order.
 */
export function pickCoverAssetId(editions: readonly CoverCandidate[]): string | null {
  const rank = (f: EditionFormat) => editionFormats.indexOf(f)
  let best: CoverCandidate | null = null
  for (const e of editions) {
    if (e.coverAssetId === null) continue
    if (
      best === null ||
      rank(e.format) < rank(best.format) ||
      (rank(e.format) === rank(best.format) &&
        (e.createdAt.getTime() < best.createdAt.getTime() || (e.createdAt.getTime() === best.createdAt.getTime() && e.id < best.id)))
    ) {
      best = e
    }
  }
  return best?.coverAssetId ?? null
}
