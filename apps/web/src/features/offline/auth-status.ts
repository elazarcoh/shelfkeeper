import type { QueryClient } from '@tanstack/react-query'
import { errorCode, trpc } from '@/lib/trpc'

/**
 * Who is signed in, for the routes' beforeLoad; null when the server can't be reached at all (no network, or the Pi is
 * down), and the route then opens the offline copy instead (#62). An answer from the server, even an error, is passed on.
 */
export async function authStatus(queryClient: QueryClient, { cached = true } = {}) {
  if (!navigator.onLine) return null
  try {
    // networkMode 'always': with the default, a query waits for the network to come back instead of failing
    return await queryClient.query({ ...trpc.auth.status.queryOptions(), networkMode: 'always', retry: 1, ...(cached ? { staleTime: 'static' as const } : {}) })
  } catch (e) {
    if (errorCode(e) === undefined) return null
    throw e
  }
}
