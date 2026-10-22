import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { TRPCClientError, createTRPCClient, httpBatchLink } from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import type { inferRouterOutputs } from '@trpc/server'
import { toast } from 'sonner'
import superjson from 'superjson'
import type { AppRouter } from '@mylib/server/router'
import { maintenanceUrl } from '@/features/backups/backup-view'
import { withBase } from '@/lib/base-path'

export type RouterOutputs = inferRouterOutputs<AppRouter>

export function errorCode(err: unknown): string | undefined {
  if (!(err instanceof TRPCClientError)) return undefined
  const typed = err as TRPCClientError<AppRouter>
  return typed.data?.code
}

let onUnauthorized: () => void = () => undefined
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err) => {
      if (errorCode(err) === 'UNAUTHORIZED') onUnauthorized()
    },
  }),
  mutationCache: new MutationCache({
    onError: (err, _variables, _context, mutation) => {
      // a mutation that shows its own error next to the field it concerns (meta: { inlineError: true }) is not toasted twice
      if (mutation.meta?.inlineError === true) return
      toast.error(err.message)
    },
  }),
  defaultOptions: {
    // tRPC errors (4xx) are final; only network failures are retried
    queries: { staleTime: 30_000, retry: (count, err) => count < 2 && errorCode(err) === undefined },
  },
})

export const trpcClient = createTRPCClient<AppRouter>({
  // maxItems must not exceed the server's MAX_BATCH_SIZE (apps/server/src/app.ts)
  links: [
    httpBatchLink({
      url: withBase('/trpc'),
      transformer: superjson,
      maxItems: 20,
      async fetch(url, options) {
        const response = await fetch(url, options as RequestInit)
        // a restore or an upgrade is under way: show the server's maintenance page, which returns here afterwards
        if (response.status === 503 && response.headers.get('x-mylib-maintenance') === '1') {
          window.location.assign(maintenanceUrl(window.location.pathname + window.location.search))
        }
        return response
      },
    }),
  ],
})

export const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient })
