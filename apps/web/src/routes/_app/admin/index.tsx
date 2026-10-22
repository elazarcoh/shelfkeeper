import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { CreateUserDialog } from '@/features/admin/create-user-dialog'
import { trpc } from '@/lib/trpc'

export const Route = createFileRoute('/_app/admin/')({ component: PeoplePage })

function PeoplePage() {
  const users = useQuery(trpc.admin.users.list.queryOptions())
  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <CreateUserDialog />
      </div>
      <ul className="divide-y rounded-lg border">
        {users.data?.map((u) => (
          <li key={u.id}>
            <Link to="/admin/users/$userId" params={{ userId: u.id }} className="flex items-center gap-3 p-4 hover:bg-muted/50">
              <div className="flex-1">
                <p className="font-medium">{u.displayName}</p>
                <p className="text-sm text-muted-foreground">@{u.username}</p>
              </div>
              {u.role === 'admin' ? <Badge>Admin</Badge> : null}
              {u.hasPin ? <Badge variant="outline">PIN</Badge> : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
