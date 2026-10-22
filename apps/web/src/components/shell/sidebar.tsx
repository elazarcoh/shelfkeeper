import { Link } from '@tanstack/react-router'
import { BookUser, ChartColumn, Gift, House, Inbox as InboxIcon, Layers, Library, Plus, Search, Shield, UserRound } from 'lucide-react'
import type { ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import { usePalette } from '@/features/palette/palette-context'
import { useLogout } from '@/lib/auth'
import type { RouterOutputs } from '@/lib/trpc'
import { inboxBadge, inboxLabel } from './nav-model'

type User = NonNullable<RouterOutputs['auth']['status']['user']>
type To = '/' | '/library' | '/sets' | '/wishlist' | '/loans' | '/stats' | '/inbox' | '/admin'

const main: { to: To; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/library', label: 'Library', icon: Library },
  { to: '/sets', label: 'Sets', icon: Layers },
  { to: '/wishlist', label: 'Wishlist', icon: Gift },
  { to: '/loans', label: 'Lent out', icon: BookUser },
  { to: '/stats', label: 'Stats', icon: ChartColumn },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon },
]

const itemClass = 'flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground'
const activeClass = 'bg-muted font-medium text-foreground'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

function SearchButton() {
  const { setOpen } = usePalette()
  return (
    <button type="button" className={`${itemClass} mb-2 border`} onClick={() => setOpen(true)}>
      <Search className="size-4" />
      <span dir="auto" className="flex-1 text-start">Search</span>
      <kbd aria-hidden className="rounded border px-1 text-xs">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  )
}

/** Desktop (from lg): the full sidebar. Below lg the top bar and bottom tabs take over. */
export function Sidebar({ user, inboxCount }: { user: User; inboxCount: number | undefined }) {
  const logout = useLogout()
  const links = user.role === 'admin' ? [...main, { to: '/admin' as const, label: 'Admin', icon: Shield }] : main
  const badge = inboxBadge(inboxCount)
  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col gap-1 border-r p-4 lg:flex">
      <div className="mb-4 px-3 text-lg font-semibold">My Library</div>
      <SearchButton />
      {/* the landmark from lg; below lg the bottom tabs are the "Main" nav (only one of the two is ever displayed) */}
      {/* grid-cols-1 (minmax(0,1fr)) here and at the foot: an auto track grows to a long name, so it could not truncate */}
      <nav aria-label="Main" className="grid grid-cols-1 gap-1">
        {links.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: to === '/' }}
            className={itemClass}
            activeProps={{ className: activeClass }}
            {...(to === '/inbox' ? { 'aria-label': inboxLabel(inboxCount) } : {})}
          >
            <Icon className="size-4" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {to === '/inbox' && badge !== null ? (
              <span aria-hidden className="rounded-full bg-primary px-1.5 text-xs leading-5 font-medium text-primary-foreground tabular-nums">
                {badge}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
      <div className="mt-auto grid grid-cols-1 gap-1">
        <Button asChild>
          <Link to="/books/new">
            <Plus className="size-4" />
            Add book
          </Link>
        </Button>
        <Link to="/account" className={itemClass} activeProps={{ className: activeClass }}>
          <UserRound className="size-4" />
          <span className="min-w-0 truncate" dir="auto">
            {user.displayName}
          </span>
        </Link>
        <Button variant="ghost" className="justify-start" onClick={() => logout.mutate()}>
          Sign out
        </Button>
      </div>
    </aside>
  )
}
