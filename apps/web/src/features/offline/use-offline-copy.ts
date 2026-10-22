import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { trpcClient } from '@/lib/trpc'
import { loadCopy, needsRefresh, saveCopy } from './offline-store'

export const OFFLINE_COPY_KEY = ['offline-copy'] as const
/** how often an open app checks whether its copy is due */
const CHECK_MS = 15 * 60_000

/** The saved copy, for the pages that show it; refreshed by useOfflineCopy. */
export function useSavedCopy() {
  return useQuery({ queryKey: OFFLINE_COPY_KEY, queryFn: loadCopy, networkMode: 'always', staleTime: Infinity })
}

/** Fetches a new copy and saves it; throws when the server or the storage fails. */
export function useUpdateCopy(user: { id: string; displayName: string }) {
  const queryClient = useQueryClient()
  return useCallback(async () => {
    const snapshot = await trpcClient.library.snapshot.query()
    await saveCopy({ userId: user.id, name: user.displayName, snapshot })
    await queryClient.invalidateQueries({ queryKey: OFFLINE_COPY_KEY })
  }, [queryClient, user.id, user.displayName])
}

/** #62: keeps this phone's offline copy of the catalog fresh while the app is open and online. */
export function useOfflineCopy(user: { id: string; displayName: string }) {
  const update = useUpdateCopy(user)
  useEffect(() => {
    let busy = false
    const check = async () => {
      if (busy || !navigator.onLine) return
      busy = true
      try {
        if (needsRefresh(await loadCopy(), user.id)) await update()
      } catch {
        // offline after all, or no storage: the next check tries again
      } finally {
        busy = false
      }
    }
    const onOnline = () => void check()
    onOnline()
    const timer = setInterval(onOnline, CHECK_MS)
    window.addEventListener('online', onOnline)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [update, user.id])
}

const subscribe = (onChange: () => void) => {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/** Whether the browser says it has a network connection. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine)
}
