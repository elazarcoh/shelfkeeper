import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { toast } from 'sonner'
import { Password, Pin } from '@mylib/domain'
import { Field } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { trpc, type RouterOutputs } from '@/lib/trpc'

type User = RouterOutputs['admin']['users']['get']

export function AccessCard({ user }: { user: User }) {
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.admin.pathKey() })
  const reset = useMutation(
    trpc.admin.users.resetPassword.mutationOptions({
      onSuccess: () => {
        setPassword('')
        toast.success('Password reset — they were signed out everywhere')
      },
    }),
  )
  const setPinMutation = useMutation(
    trpc.admin.users.setPin.mutationOptions({
      onSuccess: (_r, vars) => {
        setPin('')
        refresh()
        toast.success(vars.pin === null ? 'PIN removed' : 'PIN set')
      },
    }),
  )

  function submitPassword(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const parsed = Password.safeParse(password)
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Invalid password')
      return
    }
    reset.mutate({ userId: user.id, password: parsed.data })
  }

  function submitPin(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const parsed = Pin.safeParse(pin)
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Invalid PIN')
      return
    }
    setPinMutation.mutate({ userId: user.id, pin: parsed.data })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign-in</CardTitle>
        <CardDescription>A PIN lets younger readers sign in quickly. After 5 wrong tries, sign-in pauses for 15 minutes.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form onSubmit={submitPassword} className="grid gap-2">
          <Field label="New password" htmlFor="admin-user-password">
            <Input id="admin-user-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="outline" className="justify-self-start" disabled={reset.isPending}>
            Reset password
          </Button>
        </form>
        <Separator />
        <form onSubmit={submitPin} className="grid gap-2">
          <Field label={user.hasPin ? 'New PIN' : 'PIN'} htmlFor="admin-user-pin" hint="4–8 digits">
            <Input id="admin-user-pin" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="outline" disabled={setPinMutation.isPending}>
              Set PIN
            </Button>
            {user.hasPin ? (
              <Button type="button" variant="ghost" onClick={() => setPinMutation.mutate({ userId: user.id, pin: null })}>
                Remove PIN
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
