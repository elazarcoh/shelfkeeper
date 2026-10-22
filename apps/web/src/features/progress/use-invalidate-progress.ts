import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { trpc } from '@/lib/trpc'

/**
 * A point changes the session's latest progress, Home's bar, stats and goals; a length answer changes the edition.
 * Resolves once the progress queries (the points lists, Home's bar) have refetched; the others refresh on their own.
 */
export function invalidateProgressQueries(queryClient: QueryClient): Promise<void> {
  for (const key of [trpc.sessions.pathKey(), trpc.stats.pathKey(), trpc.goals.pathKey(), trpc.catalog.pathKey()]) {
    void queryClient.invalidateQueries({ queryKey: key })
  }
  return queryClient.invalidateQueries({ queryKey: trpc.progress.pathKey() })
}

export function useInvalidateProgress(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    void invalidateProgressQueries(queryClient)
  }, [queryClient])
}
