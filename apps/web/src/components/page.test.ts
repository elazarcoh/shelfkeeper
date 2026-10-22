import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PageHeader } from './page'

async function renderAt(path: string, title: string, description?: string): Promise<string> {
  const root = createRootRoute()
  const route = createRoute({
    getParentRoute: () => root,
    path: '$',
    component: () => createElement(PageHeader, { title, description }),
  })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  return renderToString(createElement(RouterProvider, { router }))
}

describe('PageHeader', () => {
  it('keeps the h1 visible when the top bar shows a different title', async () => {
    const html = await renderAt('/', 'Hi, Maya', 'Your reading at a glance.')
    expect(html).toMatch(/<h1 class="(?![^"]*max-lg:sr-only)[^"]*"/)
  })

  it('hides the h1 below lg (screen readers keep it) when it repeats the top bar title', async () => {
    const html = await renderAt('/account', 'Account', 'Signed in as @maya')
    expect(html).toMatch(/<h1 class="[^"]*max-lg:sr-only/)
  })

  it('drops the header gap too when nothing else is shown', async () => {
    expect(await renderAt('/library', 'Library')).toContain('max-lg:mb-0')
    expect(await renderAt('/library', 'Library', 'Your books')).not.toContain('max-lg:mb-0')
  })
})
