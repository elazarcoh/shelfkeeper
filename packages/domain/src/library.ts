import { z } from 'zod'
import type { Availability, EditionFormat, ReadingStatus, WorkKind } from './enums'
import { SmartFilter } from './filter'

/** series: by series, then position in it (inside one series, `seriesId`, its order #1, #2, …); books in no series last */
export const LibrarySort = z.enum(['title', 'added', 'author', 'rating', 'series'])
export type LibrarySort = z.infer<typeof LibrarySort>

export const LibraryQuery = z.object({
  /** library = the user's personal library; catalog = every work visible to the user */
  scope: z.enum(['library', 'catalog']).default('library'),
  setId: z.uuid().nullable().default(null),
  /** browse inside one series: only its works, sort 'series' gives its order, and it is never collapsed */
  seriesId: z.uuid().nullable().default(null),
  filter: SmartFilter.nullable().default(null),
  search: z.string().max(200).default(''),
  sort: LibrarySort.default('title'),
  /** one card per series (a work in several, under its first); ignored with search text or inside a series */
  collapseSeries: z.boolean().default(false),
  /** books with no editions (wished for, nobody owns) are hidden unless the filter asks about availability; pickers that must find them opt in */
  includeWanted: z.boolean().default(false),
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(100).default(48),
})
export type LibraryQuery = z.output<typeof LibraryQuery>

/** A collapsed series: only its works that pass the query's scope, filters and visibility. */
export interface SeriesGroupCard {
  id: string
  name: string
  bookCount: number
  /** of those, the ones this user has read */
  readCount: number
  /** up to three, in series order: the first is the front cover */
  covers: { workId: string; title: string; coverAssetId: string | null }[]
}

export type LibraryEntry = { kind: 'work'; work: WorkCard } | { kind: 'series'; series: SeriesGroupCard }

export interface LibraryPage {
  items: LibraryEntry[]
  /** entries (cards) across all pages: what pagination counts */
  total: number
  /** works across all pages: what the "N books" header counts */
  books: number
}

export interface WorkCard {
  id: string
  title: string
  subtitle: string | null
  kind: WorkKind
  authors: string[]
  series: { name: string; position: number | null; positionEnd: number | null } | null
  formats: EditionFormat[]
  availability: Availability
  status: ReadingStatus
  rating: number | null
  inQueue: boolean
  /** everyone in the household who wishes for this book, earliest wish first */
  wishedBy: { userId: string; name: string }[]
  /** a copy's cover, if any has one */
  coverAssetId: string | null
}
