import type { ReadingStatus } from '@mylib/domain'

/** #84: "Started anything new?" offers the first book in Up next that is not already being read, or nothing. */
export function upNextSuggestion<T extends { status: ReadingStatus }>(queue: readonly T[]): T | null {
  return queue.find((c) => c.status !== 'reading') ?? null
}
