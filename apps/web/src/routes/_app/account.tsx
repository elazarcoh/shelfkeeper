import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Shield } from 'lucide-react'
import { useState, type SubmitEvent } from 'react'
import { toast } from 'sonner'
import { DisplayName, Password } from '@mylib/domain'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { PageBody, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { GoalsCard } from '@/features/goals/goal-form'
import { MyHardcoverCard } from '@/features/hardcover/my-hardcover-card'
import { OfflineCopyCard } from '@/features/offline/offline-copy-card'
import { useLogout } from '@/lib/auth'
import { trpc } from '@/lib/trpc'

const TITLE_ORDERS = [
  { value: 'en,he', label: 'English first, then Hebrew' },
  { value: 'he,en', label: 'Hebrew first, then English' },
] as const

/** The option that matches a stored order; anything else shows the one that starts with the same language. */
const orderOption = (languages: readonly string[]) => (languages[0] === 'he' ? 'he,en' : 'en,he')

export const Route = createFileRoute('/_app/account')({ component: AccountPage })

function AccountPage() {
  const { user } = Route.useRouteContext()
  const router = useRouter()
  const queryClient = useQueryClient()
  const logout = useLogout()
  const [displayName, setDisplayName] = useState(user.displayName)
  const [shareActivity, setShareActivity] = useState(user.shareActivity)
  const [titleOrder, setTitleOrder] = useState(orderOption(user.titleLanguages))
  const [passwords, setPasswords] = useState({ current: '', next: '' })
  const [error, setError] = useState<string | undefined>()

  const updateMe = useMutation(
    trpc.auth.updateMe.mutationOptions({
      onSuccess: async (_saved, vars) => {
        queryClient.removeQueries({ queryKey: trpc.auth.status.queryKey() })
        // a new language order changes every title and name on screen, so no cached page may keep the old one
        if (vars.titleLanguages) await queryClient.invalidateQueries()
        await router.invalidate()
        toast.success('Saved')
      },
    }),
  )
  const changePassword = useMutation(
    trpc.auth.changePassword.mutationOptions({
      onSuccess: () => {
        setPasswords({ current: '', next: '' })
        toast.success('Password changed')
      },
    }),
  )

  function saveProfile(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const name = DisplayName.safeParse(displayName)
    if (!name.success) {
      toast.error('Display name is required')
      return
    }
    updateMe.mutate({ displayName: name.data, shareActivity, titleLanguages: titleOrder.split(',') })
  }

  function savePassword(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const next = Password.safeParse(passwords.next)
    if (!next.success) {
      setError(next.error.issues[0]?.message)
      return
    }
    setError(undefined)
    changePassword.mutate({ current: passwords.current, next: next.data })
  }

  return (
    <PageBody width="narrow">
      <PageHeader title="Account" description={`Signed in as @${user.username}`} />
      <div className="grid grid-cols-1 gap-6">
        <GoalsCard />
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveProfile} className="grid gap-4">
              <Field label="Display name" htmlFor="account-name">
                <Input id="account-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </Field>
              <Field label="Titles and names" htmlFor="account-title-order">
                <NativeSelect id="account-title-order" value={titleOrder} onChange={(e) => setTitleOrder(e.target.value)}>
                  {TITLE_ORDERS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="flex min-h-11 items-center gap-2">
                <Checkbox id="account-share" checked={shareActivity} onCheckedChange={(v) => setShareActivity(v === true)} />
                <Label htmlFor="account-share">Share my reading activity with the household</Label>
              </div>
              <Button type="submit" className="justify-self-start" disabled={updateMe.isPending}>
                Save profile
              </Button>
            </form>
          </CardContent>
        </Card>
        <MyHardcoverCard />
        <OfflineCopyCard user={user} />
        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={savePassword} className="grid gap-4">
              <Field label="Current password" htmlFor="account-current">
                <Input
                  id="account-current"
                  type="password"
                  autoComplete="current-password"
                  value={passwords.current}
                  onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                />
              </Field>
              <Field label="New password" htmlFor="account-next" error={error}>
                <Input
                  id="account-next"
                  type="password"
                  autoComplete="new-password"
                  value={passwords.next}
                  onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
                />
              </Field>
              <Button type="submit" className="justify-self-start" disabled={changePassword.isPending}>
                Change password
              </Button>
            </form>
          </CardContent>
        </Card>
        <div className="grid gap-2 lg:hidden">
          {user.role === 'admin' ? (
            <Button asChild variant="outline" className="justify-start">
              <Link to="/admin">
                <Shield className="size-4" /> Admin
              </Link>
            </Button>
          ) : null}
          <Button variant="outline" className="justify-start" onClick={() => logout.mutate()}>
            Sign out
          </Button>
        </div>
      </div>
    </PageBody>
  )
}
