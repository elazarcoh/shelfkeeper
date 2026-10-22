import { firstUnreadInSeries, workKinds, workKindLabel, type EditionFormat, type ReadingStatus, type SessionMode, type WorkKind } from '@mylib/domain'
import { markableModes } from '@/features/book/mark-finished'
import type { SetAction } from './quick-action-model'

/** The parts of a series entry (a `SeriesEntryView`) the series quick actions read. */
export interface SeriesEntryLike {
  id: string
  title: string
  position: number | null
  status: ReadingStatus
  inQueue: boolean
  formats: readonly EditionFormat[]
}

export interface MarkTarget {
  workId: string
  mode: SessionMode
  previous: ReadingStatus
}

export type SeriesAction =
  | { kind: 'loading'; id: 'loading'; label: string }
  /** a disabled note in place of an action: already queued, nothing unread, all read, still loading */
  | { kind: 'info'; id: 'queue' | 'markAll' | 'continuation'; label: string }
  | { kind: 'queue'; id: 'queue'; label: string; workId: string }
  | { kind: 'markAll'; id: 'markAll'; label: string; targets: MarkTarget[] }
  /** hide the series from Series continuation on Home (`hidden: true`), or show it there again */
  | { kind: 'continuation'; id: 'continuation'; label: string; hidden: boolean }

/** One choice of "Mark series as…". */
export interface KindAction {
  kind: 'markKind'
  id: `markKind:${WorkKind}`
  label: string
  workKind: WorkKind
}

export interface SeriesActionInput {
  /** the series' books in series order; undefined while they load */
  entries: readonly SeriesEntryLike[] | undefined
  entriesFailed: boolean
  /**
   * ids of the series' books for the sets' checkmarks. Unlike `entries`, kept while a refetch runs: set toggles keep
   * the menu open, and a loading flash would drop focus mid-toggle.
   */
  entryIds: readonly string[] | undefined
  /** sets the user may edit (editableSets); undefined while they load */
  editableSets: readonly { id: string; name: string }[] | undefined
  /** which of the series' books are in which sets; undefined while it loads */
  membership: readonly { setId: string; workId: string }[] | undefined
  /** whether the user hid this series from Series continuation; undefined while it loads */
  continuationHidden: boolean | undefined
}

export interface SeriesActionModel {
  /** Up next, Mark all as read and the Series continuation toggle, or one loading item */
  main: SeriesAction[]
  /** "Mark series as…" and its choices; any signed-in member may use it */
  markAs: { label: string; options: KindAction[] }
  /** null: no editable sets, so no Sets group */
  sets: SetAction[] | 'loading' | null
}

const quote = (title: string) => `“${title}”`

export const MARK_SERIES_AS = 'Mark series as…'

const markAs: SeriesActionModel['markAs'] = {
  label: MARK_SERIES_AS,
  options: workKinds.map((k) => ({ kind: 'markKind', id: `markKind:${k}`, label: workKindLabel[k], workKind: k })),
}

export const HIDE_CONTINUATION = 'Hide from Series continuation'
export const SHOW_CONTINUATION = 'Show in Series continuation'

function continuationAction(hidden: boolean | undefined): SeriesAction {
  if (hidden === undefined) return { kind: 'info', id: 'continuation', label: 'Loading…' }
  return hidden
    ? { kind: 'continuation', id: 'continuation', label: SHOW_CONTINUATION, hidden: false }
    : { kind: 'continuation', id: 'continuation', label: HIDE_CONTINUATION, hidden: true }
}

function mainActions(entries: readonly SeriesEntryLike[] | undefined, failed: boolean, hidden: boolean | undefined): SeriesAction[] {
  if (entries === undefined) return [{ kind: 'loading', id: 'loading', label: failed ? 'Couldn’t load series' : 'Loading…' }]

  const nextId = firstUnreadInSeries(entries.map((e) => ({ workId: e.id, position: e.position, status: e.status })))
  const next = entries.find((e) => e.id === nextId)
  let queue: SeriesAction
  if (next === undefined) queue = { kind: 'info', id: 'queue', label: 'Nothing unread' }
  else if (next.inQueue) queue = { kind: 'info', id: 'queue', label: `${quote(next.title)} is in Up next` }
  else queue = { kind: 'queue', id: 'queue', label: `Add ${quote(next.title)} to Up next`, workId: next.id }

  // books in progress are left alone: their open session is the reader's to finish
  const targets: MarkTarget[] = entries
    .filter((e) => e.status !== 'read' && e.status !== 'reading')
    .map((e) => ({
      workId: e.id,
      mode: markableModes(e.formats.map((format) => ({ format })), new Set())[0] ?? 'read',
      previous: e.status,
    }))
  const markAll: SeriesAction =
    targets.length === 0
      ? { kind: 'info', id: 'markAll', label: 'All read' }
      : { kind: 'markAll', id: 'markAll', label: `Mark all as read (${String(targets.length)})`, targets }
  return [queue, markAll, continuationAction(hidden)]
}

/** What a Library series card's quick actions offer, given its books and the user's sets once they load. */
export function seriesActionModel(input: SeriesActionInput): SeriesActionModel {
  let sets: SeriesActionModel['sets']
  if (input.editableSets !== undefined && input.editableSets.length === 0) sets = null
  else if (input.editableSets === undefined || input.membership === undefined || input.entryIds === undefined) sets = 'loading'
  else {
    const { entryIds, membership } = input
    sets = input.editableSets.map((s) => {
      const inSet = new Set(membership.filter((m) => m.setId === s.id).map((m) => m.workId))
      return { kind: 'set', id: `set:${s.id}`, label: s.name, setId: s.id, checked: entryIds.length > 0 && entryIds.every((id) => inSet.has(id)) }
    })
  }
  return { main: mainActions(input.entries, input.entriesFailed, input.continuationHidden), markAs, sets }
}
