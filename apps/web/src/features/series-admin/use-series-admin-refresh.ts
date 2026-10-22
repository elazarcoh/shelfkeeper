import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

/**
 * Refetch after a change to a series or a name. Everything: the Library's series cards and filters, book and series
 * pages, smart sets and the lists here all show series names and ids, so a narrower list would go stale somewhere.
 */
export function useSeriesAdminRefresh(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.invalidateQueries()
  }, [queryClient])
}
