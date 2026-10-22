import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { bannersFor } from '@/features/backups/backup-view'
import { trpc } from '@/lib/trpc'

/** Spec §4 (no successful backup in 48 h) and §3 (under 2 GB free): admins only. */
export function AdminBanners() {
  const status = useQuery({ ...trpc.system.status.queryOptions(), refetchInterval: 5 * 60_000 })
  if (!status.data) return null
  const banners = bannersFor(status.data)
  if (banners.length === 0) return null
  return (
    <div role="status" className="flex flex-col gap-1 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      {banners.map((banner) => (
        <p key={banner.id} className="min-w-0 break-words">
          {banner.text}{' '}
          <Link to="/admin/backups" className="underline">
            Admin → Backups
          </Link>
        </p>
      ))}
    </div>
  )
}
