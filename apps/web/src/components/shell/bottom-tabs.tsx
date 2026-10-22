import { Link, useRouterState } from '@tanstack/react-router'
import { ChartColumn, House, Inbox as InboxIcon, Library, UserRound } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { inboxBadge, inboxLabel, tabForPath, TABS, type TabId } from './nav-model'

const icons: Record<TabId, ComponentType<{ className?: string }>> = { home: House, library: Library, stats: ChartColumn, inbox: InboxIcon, me: UserRound }

/** Phones and tablets (below lg). Hidden while the keyboard is up (AppShell decides). */
export function BottomTabs({ inboxCount, hidden }: { inboxCount: number | undefined; hidden: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active = tabForPath(pathname)
  const badge = inboxBadge(inboxCount)
  return (
    <nav
      aria-label="Main"
      data-slot="bottom-nav"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] backdrop-blur lg:hidden',
        hidden && 'hidden',
      )}
    >
      {/* the bar, border included, is exactly --bottom-nav-h tall (plus the safe area), so pb-(--bottom-offset) clears it */}
      <ul className="mx-auto grid h-[calc(var(--bottom-nav-h)-1px)] max-w-xl grid-cols-5">
        {TABS.map((tab) => {
          const Icon = icons[tab.id]
          const isActive = active === tab.id
          return (
            <li key={tab.id} className="min-w-0">
              <Link
                to={tab.to}
                activeOptions={{ exact: tab.to === '/' }}
                data-active={isActive}
                // nested pages (/sets, /books/…, /admin/…) belong to a tab the router would not call active
                {...(isActive ? { 'aria-current': 'page' as const } : {})}
                {...(tab.id === 'inbox' ? { 'aria-label': inboxLabel(inboxCount) } : {})}
                className="relative flex h-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground data-[active=true]:font-medium data-[active=true]:text-foreground"
              >
                {/* the active tab is marked by shape too, not only colour */}
                {isActive ? <span aria-hidden className="absolute inset-x-1/4 top-0 h-0.5 rounded-b-full bg-foreground" /> : null}
                <span className="relative">
                  <Icon className="size-6" />
                  {tab.id === 'inbox' && badge !== null ? (
                    <span aria-hidden className="absolute -end-3 -top-1.5 min-w-5 rounded-full bg-primary px-1 text-center text-xs leading-5 font-medium text-primary-foreground tabular-nums">
                      {badge}
                    </span>
                  ) : null}
                </span>
                <span className="max-w-full truncate px-1">{tab.label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
