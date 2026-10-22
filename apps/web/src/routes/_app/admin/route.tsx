import { Link, Outlet, createFileRoute, redirect, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { PageBody, PageHeader } from '@/components/page'

export const Route = createFileRoute('/_app/admin')({
  beforeLoad: ({ context }) => {
    if (context.user.role !== 'admin') throw redirect({ to: '/' })
  },
  component: AdminLayout,
})

const tab = 'inline-flex shrink-0 items-center rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted pointer-coarse:min-h-11'
const active = 'bg-muted font-medium text-foreground'

function AdminLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const nav = useRef<HTMLElement>(null)
  // below lg the tabs are one row that scrolls sideways: bring the current one into view (System, Backups… start off screen)
  useEffect(() => {
    const el = nav.current
    const current = el?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!el || !current || el.scrollWidth <= el.clientWidth) return
    el.scrollLeft = current.offsetLeft - (el.clientWidth - current.offsetWidth) / 2
  }, [pathname])
  return (
    <PageBody>
      <PageHeader title="Admin" description="People, what they can see, household sets, authors, series, volumes, catalog health, sources, backups and the system." />
      {/* below lg: one row bleeding to the screen edges that scrolls sideways (two wrapped rows of tabs read as a block of
          buttons); from lg the row wraps inside the page */}
      <nav
        ref={nav}
        aria-label="Admin sections"
        className="relative -mx-4 mb-6 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:-mx-6 md:px-6 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0"
      >
        {/* a person's page (/admin/users/…) belongs to People too */}
        <Link
          to="/admin"
          activeOptions={{ exact: true }}
          className={pathname.startsWith('/admin/users/') ? `${tab} ${active}` : tab}
          activeProps={{ className: active }}
          {...(pathname.startsWith('/admin/users/') ? { 'aria-current': 'page' as const } : {})}
        >
          People
        </Link>
        <Link to="/admin/sets" className={tab} activeProps={{ className: active }}>
          Household sets
        </Link>
        <Link to="/admin/authors" className={tab} activeProps={{ className: active }}>
          Authors
        </Link>
        <Link to="/admin/series" className={tab} activeProps={{ className: active }}>
          Series
        </Link>
        <Link to="/admin/volumes" className={tab} activeProps={{ className: active }}>
          Volumes
        </Link>
        <Link to="/admin/health" className={tab} activeProps={{ className: active }}>
          Health
        </Link>
        <Link to="/admin/sources" className={tab} activeProps={{ className: active }}>
          Sources
        </Link>
        <Link to="/admin/hardcover" className={tab} activeProps={{ className: active }}>
          Hardcover
        </Link>
        <Link to="/admin/jobs" className={tab} activeProps={{ className: active }}>
          Jobs
        </Link>
        <Link to="/admin/backups" className={tab} activeProps={{ className: active }}>
          Backups
        </Link>
        <Link to="/admin/system" className={tab} activeProps={{ className: active }}>
          System
        </Link>
      </nav>
      <Outlet />
    </PageBody>
  )
}
