import { z } from 'zod'
import type { ReadingStatus } from './enums'
import type { FilterNode } from './filter'
import { NameLanguage } from './people'

export interface SeriesEntry {
  workId: string
  position: number | null
  status: ReadingStatus
}

function byPosition(entries: readonly SeriesEntry[]): SeriesEntry[] {
  return [...entries].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))
}

/** The first not-yet-read entry after `currentWorkId`, ordered by position (nulls last). Null past the end. */
export function nextInSeries(entries: readonly SeriesEntry[], currentWorkId: string): string | null {
  const sorted = byPosition(entries)
  const currentIndex = sorted.findIndex((e) => e.workId === currentWorkId)
  const after = currentIndex === -1 ? sorted : sorted.slice(currentIndex + 1)
  return after.find((e) => e.status !== 'read')?.workId ?? null
}

/** The first entry not yet read or being read, with no pivot — for a household-wide "what's next" view. */
export function firstUnreadInSeries(entries: readonly SeriesEntry[]): string | null {
  return byPosition(entries).find((e) => e.status !== 'read' && e.status !== 'reading')?.workId ?? null
}

export const ListSeriesAdminInput = z.object({ q: z.string().trim().max(200).default(''), limit: z.number().int().min(1).max(500).default(100) })
export type ListSeriesAdminInput = z.output<typeof ListSeriesAdminInput>
export const SeriesIdInput = z.object({ seriesId: z.uuid() })
export const SeriesNameIdInput = z.object({ nameId: z.uuid() })

export const AddSeriesNameInput = z.object({ seriesId: z.uuid(), name: z.string().trim().min(1).max(500), language: NameLanguage.default(null) })
export type AddSeriesNameInput = z.output<typeof AddSeriesNameInput>

export const RenameSeriesNameInput = z.object({ nameId: z.uuid(), name: z.string().trim().min(1).max(500) })
export type RenameSeriesNameInput = z.output<typeof RenameSeriesNameInput>

export const SetSeriesNameLanguageInput = z.object({ nameId: z.uuid(), language: NameLanguage })
export type SetSeriesNameLanguageInput = z.output<typeof SetSeriesNameLanguageInput>

export const MergeSeriesInput = z
  .object({
    /** the series the dialog was opened on */
    seriesId: z.uuid(),
    otherId: z.uuid(),
    /** one of either series' names; its series is kept, the other is deleted */
    primaryNameId: z.uuid(),
  })
  .refine((i) => i.seriesId !== i.otherId, 'A series cannot be merged with itself')
export type MergeSeriesInput = z.output<typeof MergeSeriesInput>

export const SplitSeriesNameInput = z.object({
  nameId: z.uuid(),
  /** the books that move to the new series (at least one; at least one must stay) */
  workIds: z.array(z.uuid()).min(1).max(2000),
  /** when the split name is the primary: the remaining name that becomes primary (default: the first other name) */
  primaryNameId: z.uuid().nullable().default(null),
})
export type SplitSeriesNameInput = z.output<typeof SplitSeriesNameInput>

/** The filter with one series' id replaced by another's (a merged-away series' smart sets follow the kept one). */
export function replaceSeriesInFilter(node: FilterNode, fromId: string, toId: string): FilterNode {
  switch (node.op) {
    case 'and':
    case 'or':
      return { op: node.op, nodes: node.nodes.map((n) => replaceSeriesInFilter(n, fromId, toId)) }
    case 'not':
      return { op: 'not', node: replaceSeriesInFilter(node.node, fromId, toId) }
    case 'series':
      return { op: 'series', seriesIds: [...new Set(node.seriesIds.map((id) => (id === fromId ? toId : id)))] }
    default:
      return node
  }
}
