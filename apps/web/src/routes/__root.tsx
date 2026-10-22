import type { QueryClient } from '@tanstack/react-query'
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { Toaster } from '@/components/ui/sonner'

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <>
      <Outlet />
      {/* below the phone top bar (--top-offset is 0 from lg, where there is none), never over its Back and ＋ (#9) */}
      <Toaster
        richColors
        position="top-center"
        offset={{ top: 'calc(var(--top-offset) + 16px)' }}
        mobileOffset={{ top: 'calc(var(--top-offset) + 8px)' }}
      />
    </>
  ),
})
