import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

/**
 * Refetch after a change to a person or a name. Everything: the Library's cards and filters, book and series pages,
 * the inbox and the loans list all show author ids and names, so a narrower list would go stale somewhere.
 */
export function usePeopleRefresh(): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.invalidateQueries()
  }, [queryClient])
}
