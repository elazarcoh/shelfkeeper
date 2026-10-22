import { sessionModes, type EditionFormat, type ReadingStatus, type SessionMode } from '@mylib/domain'
import { markableModes } from '@/features/book/mark-finished'

export type SetAction = { kind: 'set'; id: string; label: string; setId: string; checked: boolean }

export type QuickAction =
  | { kind: 'loading'; id: 'loading'; label: string }
  | { kind: 'finish'; id: string; label: string; sessionId: string }
  | { kind: 'nextVolume'; id: string; label: string; sessionId: string; editionId: string }
  | { kind: 'setAside'; id: string; label: string; sessionId: string }
  | { kind: 'start'; id: string; label: string; mode: SessionMode }
  | { kind: 'markRead'; id: string; label: string; mode: SessionMode }
  | { kind: 'status'; id: 'status'; label: string; status: 'want_to_read' | 'none' }
  | { kind: 'queue'; id: 'queue'; label: string; add: boolean }
  | { kind: 'clearRating'; id: 'clearRating'; label: string; previous: number }
  | { kind: 'merge'; id: 'merge'; label: string }
  | SetAction

export interface QuickActionInput {
  isAdmin: boolean
  status: ReadingStatus
  inQueue: boolean
  rating: number | null
  formats: readonly EditionFormat[]
  /** the work's in-progress sessions; undefined while they load */
  inProgress:
    | readonly {
        id: string
        mode: SessionMode
        editionId: string | null
        /** the volume the session is on, when its edition is in a volume set */
        volume: { volume: number; size: number; waiting: boolean } | null
      }[]
    | undefined
  sessionsFailed: boolean
  /** sets the user may edit (editableSets); undefined while they load */
  editableSets: readonly { id: string; name: string }[] | undefined
  /** ids of the sets the work is in; undefined while they load */
  memberSetIds: ReadonlySet<string> | undefined
}

export interface QuickActionModel {
  /** session actions (or one loading item), then Want to read */
  reading: QuickAction[]
  queue: QuickAction
  rating: { value: number | null; clear: QuickAction | null }
  /** null: no editable sets, so no Sets group */
  sets: SetAction[] | 'loading' | null
  /** admins only: opens the merge dialog */
  merge: QuickAction | null
}

export const RATING_STEPS: readonly number[] = [5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5]

const ing = (mode: SessionMode) => (mode === 'listen' ? 'listening' : 'reading')

/** The sets a user may add a book to or take it out of: manual ones, global only for an admin (as on the book page). */
export function editableSets<S extends { kind: string; scope: string }>(sets: readonly S[], isAdmin: boolean): S[] {
  return sets.filter((s) => s.kind === 'manual' && (s.scope === 'personal' || isAdmin))
}

function readingActions(input: QuickActionInput): QuickAction[] {
  if (input.inProgress === undefined) {
    // never a "Start" for a book whose open read has not loaded yet
    return [{ kind: 'loading', id: 'loading', label: input.sessionsFailed ? 'Couldn’t load reading' : 'Loading…' }]
  }
  const open = new Map<SessionMode, (typeof input.inProgress)[number]>()
  for (const s of input.inProgress) if (!open.has(s.mode)) open.set(s.mode, s)
  const readable = new Set<SessionMode>(markableModes(input.formats.map((format) => ({ format })), new Set()))
  const actions: QuickAction[] = []
  for (const mode of sessionModes.filter((m) => readable.has(m) || open.has(m))) {
    const session = open.get(mode)
    if (session !== undefined) {
      const sessionId = session.id
      const v = session.volume
      if (v !== null && session.editionId !== null && v.volume < v.size && !v.waiting) {
        actions.push({ kind: 'nextVolume', id: `nextVolume:${mode}`, label: `Finished volume ${v.volume}`, sessionId, editionId: session.editionId })
      }
      actions.push({ kind: 'finish', id: `finish:${mode}`, label: `Finish ${ing(mode)}`, sessionId })
      actions.push({ kind: 'setAside', id: `setAside:${mode}`, label: open.size > 1 ? `Set aside (${ing(mode)})` : 'Set aside', sessionId })
    } else {
      actions.push({ kind: 'start', id: `start:${mode}`, label: `Start ${ing(mode)}`, mode })
      actions.push({ kind: 'markRead', id: `markRead:${mode}`, label: mode === 'listen' ? 'Mark as listened' : 'Mark as read', mode })
    }
  }
  return actions
}

/** What a Library card's quick actions offer, given the card and the work's sessions and sets once they load. */
export function quickActionModel(input: QuickActionInput): QuickActionModel {
  const reading = readingActions(input)
  if (input.status === 'want_to_read') reading.push({ kind: 'status', id: 'status', label: 'Remove from Want to read', status: 'none' })
  else if (input.status !== 'reading') reading.push({ kind: 'status', id: 'status', label: 'Want to read', status: 'want_to_read' })

  let sets: QuickActionModel['sets']
  if (input.editableSets !== undefined && input.editableSets.length === 0) sets = null
  else if (input.editableSets === undefined || input.memberSetIds === undefined) sets = 'loading'
  else {
    const members = input.memberSetIds
    sets = input.editableSets.map((s) => ({ kind: 'set', id: `set:${s.id}`, label: s.name, setId: s.id, checked: members.has(s.id) }))
  }

  return {
    reading,
    queue: input.inQueue
      ? { kind: 'queue', id: 'queue', label: 'Remove from Up next', add: false }
      : { kind: 'queue', id: 'queue', label: 'Add to Up next', add: true },
    rating: {
      value: input.rating,
      clear: input.rating === null ? null : { kind: 'clearRating', id: 'clearRating', label: 'Clear rating', previous: input.rating },
    },
    sets,
    merge: input.isAdmin ? { kind: 'merge', id: 'merge', label: 'Merge into another book…' } : null,
  }
}
