import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { CommandPalette } from '@/features/palette/command-palette'
import { PaletteProvider } from '@/features/palette/palette-context'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { BottomTabs } from './bottom-tabs'
import { Sidebar } from './sidebar'
import { TopAppBar } from './top-app-bar'
import { useHideBottomNav } from './use-hide-bottom-nav'

type User = NonNullable<RouterOutputs['auth']['status']['user']>

export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const inbox = useQuery({ ...trpc.inbox.count.queryOptions(), refetchInterval: 60_000 })
  const hideBottomNav = useHideBottomNav()
  return (
    <PaletteProvider>
      <div data-slot="app-shell" data-bottom-nav={hideBottomNav ? 'hidden' : 'shown'} className="min-h-dvh bg-background lg:flex">
        <Sidebar user={user} inboxCount={inbox.data} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopAppBar />
          <main className="min-w-0 flex-1 pb-(--bottom-offset)">{children}</main>
        </div>
        <BottomTabs inboxCount={inbox.data} hidden={hideBottomNav} />
        <CommandPalette isAdmin={user.role === 'admin'} />
      </div>
    </PaletteProvider>
  )
}
