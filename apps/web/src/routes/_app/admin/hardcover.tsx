import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { accountStatusLine } from '@/features/hardcover/status-line'
import { TokenForm } from '@/features/hardcover/token-form'
import { trpc } from '@/lib/trpc'

export const Route = createFileRoute('/_app/admin/hardcover')({ component: HardcoverAdminPage })

function HardcoverAdminPage() {
  const queryClient = useQueryClient()
  const state = useQuery({ ...trpc.hardcover.admin.get.queryOptions(), refetchInterval: 10_000 })
  const refreshState = () => void queryClient.invalidateQueries({ queryKey: trpc.hardcover.pathKey() })
  const setToken = useMutation(trpc.hardcover.admin.setToken.mutationOptions({ onSuccess: () => (toast.success('Hardcover connected'), refreshState()) }))
  const test = useMutation(trpc.hardcover.admin.test.mutationOptions({ onSuccess: refreshState }))
  const remove = useMutation(trpc.hardcover.admin.remove.mutationOptions({ onSuccess: refreshState }))
  const refreshNow = useMutation(trpc.hardcover.admin.refreshNow.mutationOptions({ onSuccess: () => toast.success('Refresh started') }))
  const account = state.data?.account ?? null
  const last = state.data?.lastRefresh ?? null
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Hardcover</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            The household token matches your books on Hardcover for its ratings, tags and similar books. Each person can link their own account in My account.
          </p>
          <p className="text-sm font-medium" role="status">
            {accountStatusLine(account)}
          </p>
          <TokenForm id="hardcover-household-token" saving={setToken.isPending} error={setToken.error?.message} onSave={(token) => setToken.mutateAsync({ token })} />
          {account !== null && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
                Test
              </Button>
              <Button variant="outline" onClick={() => refreshNow.mutate()} disabled={refreshNow.isPending}>
                Refresh now
              </Button>
              <Button variant="outline" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Remove token
              </Button>
            </div>
          )}
          {last !== null && (
            <p className="text-sm text-muted-foreground">
              Last refresh: {last.status}
              {last.stats
                ? ` — ${Object.entries(last.stats)
                    .map(([k, v]) => `${v} ${k}`)
                    .join(', ')}`
                : ''}
              {last.error ? ` (${last.error})` : ''}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
