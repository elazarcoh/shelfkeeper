import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useSavedCopy, useUpdateCopy } from './use-offline-copy'

/** #62 on the Account page: what the offline copy holds, and a way to save it now (before leaving the house). */
export function OfflineCopyCard({ user }: { user: { id: string; displayName: string } }) {
  const copy = useSavedCopy()
  const update = useMutation({ mutationFn: useUpdateCopy(user) })
  const saved = copy.data !== undefined && copy.data !== null && copy.data.userId === user.id ? copy.data : null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Offline copy</CardTitle>
        <CardDescription>
          This device keeps a copy of the catalog, so with no signal you can still check whether you own a book or have read it. It updates by itself every few hours while the app is open.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3 text-sm">
        <p role="status" className="min-w-0 flex-1">
          {saved === null
            ? 'Not saved yet'
            : `${saved.snapshot.works.length} books, saved ${new Date(saved.snapshot.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`}
        </p>
        <Button variant="outline" size="sm" disabled={update.isPending} onClick={() => update.mutate()}>
          {update.isPending ? 'Saving…' : 'Update now'}
        </Button>
        <Link to="/offline" className="underline">
          Open it
        </Link>
      </CardContent>
    </Card>
  )
}
