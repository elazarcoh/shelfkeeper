import { useMutation, useQueryClient } from '@tanstack/react-query'
import { UserPlus } from 'lucide-react'
import { useState, type SubmitEvent } from 'react'
import { toast } from 'sonner'
import { CreateUserInput, userRoles } from '@mylib/domain'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { fieldErrors, type FieldErrors } from '@/lib/form'
import { trpc } from '@/lib/trpc'

const empty = { username: '', displayName: '', password: '', role: 'member' as (typeof userRoles)[number] }

export function CreateUserDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(empty)
  const [errors, setErrors] = useState<FieldErrors>({})
  const create = useMutation(
    trpc.admin.users.create.mutationOptions({
      onSuccess: (user) => {
        void queryClient.invalidateQueries({ queryKey: trpc.admin.pathKey() })
        toast.success(<span dir="auto">{user.displayName} can now sign in</span>)
        setOpen(false)
      },
    }),
  )

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const parsed = CreateUserInput.safeParse(form)
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error))
      return
    }
    create.mutate(parsed.data)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setForm(empty)
          setErrors({})
        }
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus className="size-4" /> New person
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a household member</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Username" htmlFor="new-user-username" error={errors.username}>
            <Input id="new-user-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </Field>
          <Field label="Display name" htmlFor="new-user-name" error={errors.displayName}>
            <Input id="new-user-name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </Field>
          <Field label="Password" htmlFor="new-user-password" error={errors.password}>
            <Input id="new-user-password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <Field label="Role" htmlFor="new-user-role">
            <NativeSelect
              id="new-user-role"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value === 'admin' ? 'admin' : 'member' })}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </NativeSelect>
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create person
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
