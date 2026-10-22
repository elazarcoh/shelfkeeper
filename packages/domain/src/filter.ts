import { z } from 'zod'
import { Availability, EditionFormat, ReadingStatus, WorkKind } from './enums'
import { RatingValue } from './tracking'

export type FilterNode =
  | { op: 'and'; nodes: FilterNode[] }
  | { op: 'or'; nodes: FilterNode[] }
  | { op: 'not'; node: FilterNode }
  | { op: 'format'; formats: EditionFormat[] }
  | { op: 'author'; contributorIds: string[] }
  | { op: 'narrator'; contributorIds: string[] }
  | { op: 'series'; seriesIds: string[] }
  | { op: 'tag'; tagIds: string[] }
  | { op: 'language'; languages: string[] }
  | { op: 'status'; statuses: ReadingStatus[] }
  | { op: 'rating'; min: number; max: number }
  | { op: 'availability'; values: Availability[] }
  | { op: 'addedAt'; from: string | null; to: string | null }
  | { op: 'kind'; kinds: WorkKind[] }

const ids = z.array(z.uuid()).min(1).max(200)

export const FilterNode: z.ZodType<FilterNode> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('and'), nodes: z.array(FilterNode).min(1).max(50) }),
    z.object({ op: z.literal('or'), nodes: z.array(FilterNode).min(1).max(50) }),
    z.object({ op: z.literal('not'), node: FilterNode }),
    z.object({ op: z.literal('format'), formats: z.array(EditionFormat).min(1) }),
    z.object({ op: z.literal('author'), contributorIds: ids }),
    z.object({ op: z.literal('narrator'), contributorIds: ids }),
    z.object({ op: z.literal('series'), seriesIds: ids }),
    z.object({ op: z.literal('tag'), tagIds: ids }),
    z.object({ op: z.literal('language'), languages: z.array(z.string().trim().min(1).max(35)).min(1).max(50) }),
    z.object({ op: z.literal('status'), statuses: z.array(ReadingStatus).min(1) }),
    z
      .object({ op: z.literal('rating'), min: RatingValue, max: RatingValue })
      .refine((r) => r.min <= r.max, 'min must be <= max'),
    z.object({ op: z.literal('availability'), values: z.array(Availability).min(1) }),
    z.object({ op: z.literal('addedAt'), from: z.iso.date().nullable(), to: z.iso.date().nullable() }),
    z.object({ op: z.literal('kind'), kinds: z.array(WorkKind).min(1) }),
  ]),
)

export function filterDepth(node: FilterNode): number {
  switch (node.op) {
    case 'and':
    case 'or':
      return 1 + Math.max(0, ...node.nodes.map(filterDepth))
    case 'not':
      return 1 + filterDepth(node.node)
    default:
      return 1
  }
}

export const MAX_FILTER_DEPTH = 8
export const SmartFilter = FilterNode.refine((n) => filterDepth(n) <= MAX_FILTER_DEPTH, 'Filter is nested too deeply')

/** The simple facet selections the library UI offers; combined with AND. */
export interface FilterFacets {
  formats?: EditionFormat[] | undefined
  statuses?: ReadingStatus[] | undefined
  minRating?: number | undefined
  authorIds?: string[] | undefined
  seriesIds?: string[] | undefined
  tagIds?: string[] | undefined
  availability?: Availability[] | undefined
  kinds?: WorkKind[] | undefined
}

export function filterFromFacets(f: FilterFacets): FilterNode | null {
  const nodes: FilterNode[] = []
  if (f.availability?.length) nodes.push({ op: 'availability', values: f.availability })
  if (f.formats?.length) nodes.push({ op: 'format', formats: f.formats })
  if (f.statuses?.length) nodes.push({ op: 'status', statuses: f.statuses })
  if (f.authorIds?.length) nodes.push({ op: 'author', contributorIds: f.authorIds })
  if (f.seriesIds?.length) nodes.push({ op: 'series', seriesIds: f.seriesIds })
  if (f.tagIds?.length) nodes.push({ op: 'tag', tagIds: f.tagIds })
  if (f.kinds?.length) nodes.push({ op: 'kind', kinds: f.kinds })
  if (f.minRating !== undefined) nodes.push({ op: 'rating', min: f.minRating, max: 5 })
  const [only] = nodes
  if (only === undefined) return null
  return nodes.length === 1 ? only : { op: 'and', nodes }
}

/** Whether the filter says anything about availability (then the Library shows wanted books as asked). */
export function mentionsAvailability(node: FilterNode | null): boolean {
  if (node === null) return false
  switch (node.op) {
    case 'and':
    case 'or':
      return node.nodes.some(mentionsAvailability)
    case 'not':
      return mentionsAvailability(node.node)
    case 'availability':
      return true
    default:
      return false
  }
}
