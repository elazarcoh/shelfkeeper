import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { NotFoundPage, RouteErrorPage } from './components/route-fallbacks'
import { routerBasepath } from './lib/base-path'
import { queryClient, setUnauthorizedHandler } from './lib/trpc'
import { routeTree } from './routeTree.gen'
import './index.css'

const router = createRouter({
  routeTree,
  basepath: routerBasepath(import.meta.env.BASE_URL),
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
  defaultNotFoundComponent: NotFoundPage,
  defaultErrorComponent: RouteErrorPage,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

setUnauthorizedHandler(() => {
  queryClient.clear()
  void router.navigate({ to: '/login' })
})

const scheme = window.matchMedia('(prefers-color-scheme: dark)')
const applyScheme = () => document.documentElement.classList.toggle('dark', scheme.matches)
applyScheme()
scheme.addEventListener('change', applyScheme)

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing')
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
