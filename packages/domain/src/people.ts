import { z } from 'zod'
import type { FilterNode } from './filter'
import { normalizeLanguage } from './languages'

/** A name's language, e.g. `he` or `en`; blank means unknown. */
export const NameLanguage = z
  .string()
  .trim()
  .max(35)
  .nullable()
  .transform(normalizeLanguage)

export const ListPeopleInput = z.object({ q: z.string().trim().max(200).default(''), limit: z.number().int().min(1).max(500).default(100) })
export type ListPeopleInput = z.output<typeof ListPeopleInput>
export const PersonIdInput = z.object({ personId: z.uuid() })
export const NameIdInput = z.object({ nameId: z.uuid() })

export const MergePeopleInput = z
  .object({
    /** the person the dialog was opened on */
    personId: z.uuid(),
    otherId: z.uuid(),
    /** one of either person's names; its person is kept, the other is deleted */
    primaryNameId: z.uuid(),
    languages: z.array(z.object({ nameId: z.uuid(), language: NameLanguage })).max(200).default([]),
  })
  .refine((i) => i.personId !== i.otherId, 'A person cannot be merged with themselves')
export type MergePeopleInput = z.output<typeof MergePeopleInput>

export const SplitOffNameInput = z.object({
  nameId: z.uuid(),
  /** when the split name is the primary: the remaining name that becomes primary (default: the first other name) */
  primaryNameId: z.uuid().nullable().default(null),
})
export type SplitOffNameInput = z.output<typeof SplitOffNameInput>

export const AddNameInput = z.object({ personId: z.uuid(), name: z.string().trim().min(1).max(500), language: NameLanguage.default(null) })
export type AddNameInput = z.output<typeof AddNameInput>

export const SetNameLanguageInput = z.object({ nameId: z.uuid(), language: NameLanguage })
export type SetNameLanguageInput = z.output<typeof SetNameLanguageInput>

export interface MergeSide {
  primaryNameId: string
  bookCount: number
}

/** The merge dialog's default primary name: that of the person with more books, the opened person on a tie. */
export function defaultPrimaryName(opened: MergeSide, other: MergeSide): string {
  return other.bookCount > opened.bookCount ? other.primaryNameId : opened.primaryNameId
}

/** A name's language as the merge dialog prefills it: its own, else the one language all its books share, else none. */
export function prefillNameLanguage(current: string | null, bookLanguages: readonly (string | null)[]): string | null {
  if (current !== null) return current
  const known = new Set(bookLanguages.flatMap((l) => (l === null || l.trim() === '' ? [] : [l.trim()])))
  const [only] = known
  return known.size === 1 && only !== undefined ? only : null
}

/** The filter with one person's id replaced by another's (a merged-away person's smart sets follow the kept one). */
export function replacePersonInFilter(node: FilterNode, fromId: string, toId: string): FilterNode {
  switch (node.op) {
    case 'and':
    case 'or':
      return { op: node.op, nodes: node.nodes.map((n) => replacePersonInFilter(n, fromId, toId)) }
    case 'not':
      return { op: 'not', node: replacePersonInFilter(node.node, fromId, toId) }
    case 'author':
    case 'narrator':
      return { op: node.op, contributorIds: [...new Set(node.contributorIds.map((id) => (id === fromId ? toId : id)))] }
    default:
      return node
  }
}
