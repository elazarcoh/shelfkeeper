import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { trpc } from '@/lib/trpc'
import { accountStatusLine, pastReadsLine, pushSummary } from './status-line'
import { TokenForm } from './token-form'

const PUSH_LABEL = { waiting: 'Waiting', sent: 'Sent', skipped: 'Skipped' } as const

export function MyHardcoverCard() {
  const queryClient = useQueryClient()
  const mine = useQuery(trpc.hardcover.mine.get.queryOptions())
  const pushes = useQuery(trpc.hardcover.mine.pushes.queryOptions())
  const pushCounts = useQuery(trpc.hardcover.mine.pushCounts.queryOptions())
  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.hardcover.mine.pathKey() })
  const setToken = useMutation(trpc.hardcover.mine.setToken.mutationOptions({ onSuccess: () => (toast.success('Hardcover connected'), refresh()) }))
  const remove = useMutation(trpc.hardcover.mine.remove.mutationOptions({ onSuccess: refresh }))
  const setSend = useMutation(trpc.hardcover.mine.setSend.mutationOptions({ onSuccess: refresh }))
  const canSendPast = mine.data?.account?.status === 'ok' && mine.data.account.sendFinished
  const pastReads = useQuery({ ...trpc.hardcover.mine.pastReads.queryOptions(), enabled: canSendPast })
  const sendPast = useMutation(
    trpc.hardcover.mine.sendPast.mutationOptions({
      onSuccess: ({ queued }) => (toast.success(queued === 1 ? '1 book queued for Hardcover' : `${queued} books queued for Hardcover`), refresh()),
      onError: (e) => toast.error(e.message),
    }),
  )
  const past = pastReads.data ?? { total: 0, matched: 0 }
  const summary = pushSummary(pushCounts.data ?? { waiting: 0, sent: 0, skipped: 0 })
  const account = mine.data?.account ?? null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hardcover</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">Link your own Hardcover account for recommendations from your Hardcover history. Only you see it.</p>
        <p className="text-sm font-medium" role="status">
          {accountStatusLine(account)}
        </p>
        <TokenForm id="hardcover-my-token" saving={setToken.isPending} error={setToken.error?.message} onSave={(token) => setToken.mutateAsync({ token })} />
        {account !== null && (
          <>
            <div className="flex items-start gap-2">
              <Checkbox id="hardcover-send" checked={account.sendFinished} onCheckedChange={(v) => setSend.mutate({ on: v === true })} />
              <Label htmlFor="hardcover-send" className="grid gap-1 font-normal">
                <span>Send books I finish to Hardcover</span>
                <span className="text-sm text-muted-foreground">Marks them Read there with your rating, only if Hardcover doesn’t have them as Read already. Nothing there is changed or deleted.</span>
              </Label>
            </div>
            <div className="flex flex-wrap gap-2">
              {canSendPast && past.total > 0 ? (
                <ConfirmDialog
                  title="Send your past reads to Hardcover?"
                  description={pastReadsLine(past.total, past.matched)}
                  confirmLabel={past.total === 1 ? 'Send 1 book' : `Send ${past.total} books`}
                  onConfirm={() => sendPast.mutate()}
                  trigger={
                    <Button variant="outline" disabled={sendPast.isPending}>
                      Send my past reads…
                    </Button>
                  }
                />
              ) : null}
              <Button variant="outline" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Unlink Hardcover
              </Button>
            </div>
          </>
        )}
        {summary !== null && <p className="text-sm text-muted-foreground">Sends: {summary}</p>}
        {(pushes.data ?? []).length > 0 && (
          <ul className="grid gap-1 text-sm">
            {(pushes.data ?? []).map((p) => (
              <li key={p.workId} className="min-w-0 wrap-anywhere text-match-parent" dir="auto">
                {p.title} — {PUSH_LABEL[p.status]}
                {p.reason ? ` (${p.reason})` : ''}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
