import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState, type SubmitEvent } from 'react'
import { Field } from '@/components/field'
import { AuthCard } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { authStatus } from '@/features/offline/auth-status'
import { trpc } from '@/lib/trpc'

export const Route = createFileRoute('/login')({
  beforeLoad: async ({ context }) => {
    const status = await authStatus(context.queryClient, { cached: false })
    if (status === null) throw redirect({ to: '/offline' })
    if (status.needsSetup) throw redirect({ to: '/setup' })
    if (status.user) throw redirect({ to: '/' })
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const onSuccess = () => {
    queryClient.clear()
    void navigate({ to: '/' })
  }
  const login = useMutation(trpc.auth.login.mutationOptions({ onSuccess }))
  const loginPin = useMutation(trpc.auth.loginPin.mutationOptions({ onSuccess }))

  const usernameField = (id: string) => (
    <Field label="Username" htmlFor={id}>
      <Input id={id} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
    </Field>
  )

  return (
    <AuthCard title="Sign in" description="Welcome back to the family library.">
      <Tabs defaultValue="password">
        <TabsList className="mb-4 grid w-full grid-cols-2">
          <TabsTrigger value="password">Password</TabsTrigger>
          <TabsTrigger value="pin">PIN</TabsTrigger>
        </TabsList>
        <TabsContent value="password">
          <form
            className="grid gap-4"
            onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
              e.preventDefault()
              login.mutate({ username, password })
            }}
          >
            {usernameField('username')}
            <Field label="Password" htmlFor="password">
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" disabled={login.isPending}>
              Sign in
            </Button>
          </form>
        </TabsContent>
        <TabsContent value="pin">
          <form
            className="grid gap-4"
            onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
              e.preventDefault()
              loginPin.mutate({ username, pin })
            }}
          >
            {usernameField('pin-username')}
            <Field label="PIN" htmlFor="pin">
              <Input id="pin" inputMode="numeric" autoComplete="one-time-code" value={pin} onChange={(e) => setPin(e.target.value)} />
            </Field>
            <Button type="submit" disabled={loginPin.isPending}>
              Sign in with PIN
            </Button>
          </form>
        </TabsContent>
      </Tabs>
    </AuthCard>
  )
}
