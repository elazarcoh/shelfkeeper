import { useQuery } from '@tanstack/react-query'
import { trpc, type RouterOutputs } from './trpc'

export type Suggestions = RouterOutputs['catalog']['suggestions']

const EMPTY: Suggestions = { series: [], contributors: [], tags: [], languages: [], publishers: [], shelfLocations: [], borrowers: [] }

/**
 * The names forms can suggest; empty while loading or on error, so a form never waits on them. `ready` is true only once
 * the lists have loaded: without it, "is this name new?" would flag every name while the lists are empty.
 */
export function useSuggestions(): Suggestions & { ready: boolean } {
  const query = useQuery(trpc.catalog.suggestions.queryOptions(undefined, { staleTime: 5 * 60_000 }))
  return { ...(query.data ?? EMPTY), ready: query.data !== undefined }
}
