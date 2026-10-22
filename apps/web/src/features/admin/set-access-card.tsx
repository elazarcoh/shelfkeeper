import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { trpc } from '@/lib/trpc'

export function SetAccessCard({ userId }: { userId: string }) {
  const queryClient = useQueryClient()
  const rows = useQuery(trpc.admin.users.setAssignments.queryOptions({ userId }))
  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.admin.pathKey() })
  const assign = useMutation(trpc.admin.users.assignSet.mutationOptions({ onSuccess: refresh }))
  const hide = useMutation(trpc.admin.users.hideSet.mutationOptions({ onSuccess: refresh }))
  const unhide = useMutation(trpc.admin.users.unhideSet.mutationOptions({ onSuccess: refresh }))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Household sets</CardTitle>
        <CardDescription>
          “In library by default” switches a set on for them (they can switch it off). “Hidden” removes every book in the set from everything they
          see.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.data && rows.data.length > 0 ? (
          // below sm each set is a name row plus a row of its two checkboxes (side by side they crushed the name)
          // grid-cols-1 (minmax(0,1fr)): an auto track grows to a long set name instead of letting it wrap
          <ul className="grid grid-cols-1 gap-3 max-sm:divide-y">
            {rows.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 max-sm:pt-3 max-sm:first:pt-0 sm:gap-4">
                <span className="flex min-w-0 basis-full flex-wrap items-center gap-2 font-medium sm:flex-1 sm:basis-0">
                  <span className="min-w-0 break-words" dir="auto">
                    {r.name}
                  </span>
                  {r.active ? <Badge variant="secondary">On</Badge> : null}
                </span>
                <div className="flex min-h-11 items-center gap-2">
                  <Checkbox
                    id={`assign-${r.id}`}
                    checked={r.assignedByAdmin}
                    disabled={assign.isPending}
                    onCheckedChange={(v) => assign.mutate({ userId, setId: r.id, assigned: v === true })}
                  />
                  <Label htmlFor={`assign-${r.id}`}>In library by default</Label>
                </div>
                <div className="flex min-h-11 items-center gap-2">
                  <Checkbox
                    id={`hide-${r.id}`}
                    checked={r.hidden}
                    disabled={hide.isPending || unhide.isPending}
                    onCheckedChange={(v) => (v === true ? hide.mutate({ userId, setId: r.id }) : unhide.mutate({ userId, setId: r.id }))}
                  />
                  <Label htmlFor={`hide-${r.id}`}>Hidden</Label>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No household sets yet — create them under “Household sets”.</p>
        )}
      </CardContent>
    </Card>
  )
}
