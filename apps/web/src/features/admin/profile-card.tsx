import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { toast } from 'sonner'
import { UpdateUserInput } from '@mylib/domain'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { trpc, type RouterOutputs } from '@/lib/trpc'

type User = RouterOutputs['admin']['users']['get']

export function ProfileCard({ user }: { user: User }) {
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(user.displayName)
  const [role, setRole] = useState(user.role)
  const update = useMutation(
    trpc.admin.users.update.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.admin.pathKey() })
        toast.success('Saved')
      },
    }),
  )

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const parsed = UpdateUserInput.safeParse({
      displayName: displayName === user.displayName ? undefined : displayName,
      role: role === user.role ? undefined : role,
    })
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Nothing to save')
      return
    }
    update.mutate({ userId: user.id, patch: parsed.data })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Display name" htmlFor="admin-user-name">
            <Input id="admin-user-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="Role" htmlFor="admin-user-role">
            <NativeSelect id="admin-user-role" value={role} onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : 'member')}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </NativeSelect>
          </Field>
          <Button type="submit" className="justify-self-start" disabled={update.isPending}>
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
