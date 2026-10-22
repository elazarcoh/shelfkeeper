import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState, type SubmitEvent } from 'react'
import { SetupInput } from '@mylib/domain'
import { Field } from '@/components/field'
import { AuthCard } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fieldErrors, type FieldErrors } from '@/lib/form'
import { trpc } from '@/lib/trpc'

export const Route = createFileRoute('/setup')({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.query(trpc.auth.status.queryOptions())
    if (!status.needsSetup) throw redirect({ to: '/login' })
  },
  component: SetupPage,
})

function SetupPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ username: '', displayName: '', password: '' })
  const [errors, setErrors] = useState<FieldErrors>({})
  const setup = useMutation(
    trpc.auth.setup.mutationOptions({
      onSuccess: () => {
        queryClient.clear()
        void navigate({ to: '/' })
      },
    }),
  )

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const parsed = SetupInput.safeParse(form)
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error))
      return
    }
    setErrors({})
    setup.mutate(parsed.data)
  }

  return (
    <AuthCard title="Welcome to My Library" description="Create the first admin account for your household.">
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Username" htmlFor="username" error={errors.username}>
          <Input id="username" autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </Field>
        <Field label="Display name" htmlFor="displayName" error={errors.displayName}>
          <Input id="displayName" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password}>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </Field>
        <Button type="submit" disabled={setup.isPending}>
          Create admin account
        </Button>
      </form>
    </AuthCard>
  )
}
