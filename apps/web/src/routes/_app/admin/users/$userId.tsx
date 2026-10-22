import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { EmptyState } from '@/components/page'
import { Skeleton } from '@/components/ui/skeleton'
import { AccessCard } from '@/features/admin/access-card'
import { HiddenBooksCard } from '@/features/admin/hidden-books-card'
import { ProfileCard } from '@/features/admin/profile-card'
import { SetAccessCard } from '@/features/admin/set-access-card'
import { trpc } from '@/lib/trpc'

export const Route = createFileRoute('/_app/admin/users/$userId')({ component: PersonPage })

function PersonPage() {
  const { userId } = Route.useParams()
  const user = useQuery(trpc.admin.users.get.queryOptions({ userId }))
  if (user.isPending) return <Skeleton className="h-64 w-full" />
  if (user.isError) return <EmptyState title="Person not found" />
  return (
    // grid-cols-1 (minmax(0,1fr)): an auto track grows to a long set or book name inside a card
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <h2 className="text-xl font-semibold lg:col-span-2">{user.data.displayName}</h2>
      <ProfileCard key={`profile-${user.data.id}`} user={user.data} />
      <AccessCard user={user.data} />
      <SetAccessCard userId={userId} />
      <HiddenBooksCard userId={userId} name={user.data.displayName} />
    </div>
  )
}
