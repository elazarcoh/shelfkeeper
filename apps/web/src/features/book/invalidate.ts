import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { trpc } from '@/lib/trpc'

/** Refetch everything that shows book data after a change. */
export function useInvalidateBook(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: trpc.catalog.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.library.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.sets.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.sessions.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.series.pathKey() })
    // removing a session takes its points (and Home's bar) with it
    void queryClient.invalidateQueries({ queryKey: trpc.progress.pathKey() })
  }, [queryClient])
}
