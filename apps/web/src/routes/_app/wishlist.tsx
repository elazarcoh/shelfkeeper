import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { PageBody, PageHeader } from '@/components/page'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WishList } from '@/features/wishlist/wish-list'
import { trpc } from '@/lib/trpc'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const Route = createFileRoute('/_app/wishlist')({
  validateSearch: (raw: Record<string, unknown>): { who?: string } => (typeof raw['who'] === 'string' && UUID.test(raw['who']) ? { who: raw['who'] } : {}),
  component: WishlistPage,
})

function WishlistPage() {
  const { user } = Route.useRouteContext()
  const { who } = Route.useSearch()
  const navigate = Route.useNavigate()
  const members = useQuery(trpc.wishlist.members.queryOptions())
  const shown = who ?? user.id
  const wishes = useQuery(trpc.wishlist.list.queryOptions({ userId: shown }))
  const mine = shown === user.id
  const name = members.data?.find((m) => m.userId === shown)?.name
  return (
    <PageBody width="narrow">
      <PageHeader title="Wishlist" />
      {members.data && members.data.length > 1 ? (
        <Tabs value={shown} onValueChange={(v) => void navigate({ search: v === user.id ? {} : { who: v } })} className="mb-4">
          <TabsList className="h-auto flex-wrap">
            {members.data.map((m) => (
              <TabsTrigger key={m.userId} value={m.userId} className="pointer-coarse:min-h-11" dir="auto">
                <span dir="auto">{m.userId === user.id ? 'Me' : m.name}</span> <span>({m.count})</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : null}
      {wishes.isPending ? <Skeleton className="h-40 w-full" /> : null}
      {wishes.error ? (
        <p role="alert" className="text-sm text-destructive" dir="auto">
          Could not load the wishlist: {wishes.error.message} — reload the page to try again
        </p>
      ) : null}
      {wishes.data ? <WishList rows={wishes.data} mine={mine} userId={user.id} {...(name !== undefined ? { name } : {})} /> : null}
    </PageBody>
  )
}
