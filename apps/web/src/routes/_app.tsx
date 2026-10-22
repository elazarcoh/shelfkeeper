import { Link, Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { AdminBanners } from '@/components/admin-banners'
import { AppShell } from '@/components/shell/app-shell'
import { useOfflineCopy, useOnline } from '@/features/offline/use-offline-copy'
import { authStatus } from '@/features/offline/auth-status'

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context }) => {
    const status = await authStatus(context.queryClient)
    if (status === null) throw redirect({ to: '/offline' })
    if (status.needsSetup) throw redirect({ to: '/setup' })
    if (!status.user) throw redirect({ to: '/login' })
    return { user: status.user }
  },
  component: AppLayout,
})

function AppLayout() {
  const { user } = Route.useRouteContext()
  const online = useOnline()
  useOfflineCopy(user)
  return (
    <AppShell user={user}>
      {online ? null : (
        <p role="status" className="border-b bg-muted px-4 py-2 text-sm">
          No connection.{' '}
          <Link to="/offline" className="underline">
            Search the offline copy
          </Link>
        </p>
      )}
      {user.role === 'admin' ? <AdminBanners /> : null}
      <Outlet />
    </AppShell>
  )
}
