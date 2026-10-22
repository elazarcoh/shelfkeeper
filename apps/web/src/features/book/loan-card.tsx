import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { toast } from 'sonner'
import { Field } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { SuggestInput } from '@/components/suggest-input'
import { Input } from '@/components/ui/input'
import { emptyToNull } from '@/lib/form'
import { todayLocal } from '@/lib/format'
import { useSuggestions } from '@/lib/suggestions'
import { trpc } from '@/lib/trpc'

export function LoanCard({ editionId }: { editionId: string }) {
  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.loans.pathKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.catalog.suggestions.queryKey() })
  }
  const loans = useQuery(trpc.loans.forEdition.queryOptions({ editionId }))
  const returnLoan = useMutation(trpc.loans.return.mutationOptions({ onSuccess: refresh }))
  const active = (loans.data ?? []).find((l) => l.returnedOn === null)

  if (active) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 break-words text-muted-foreground" dir="auto">
          Lent to {active.borrowerName ?? active.borrowerDisplayName ?? 'a household member'}
          {active.dueOn ? ` · due ${active.dueOn}` : ''}
        </span>
        <Button size="sm" variant="outline" disabled={returnLoan.isPending} onClick={() => returnLoan.mutate({ loanId: active.id, on: todayLocal() })}>
          Mark returned
        </Button>
      </div>
    )
  }
  return <LendDialog editionId={editionId} onLent={refresh} />
}

function LendDialog({ editionId, onLent }: { editionId: string; onLent: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [dueOn, setDueOn] = useState('')
  const suggestions = useSuggestions()
  const create = useMutation(
    trpc.loans.create.mutationOptions({
      onSuccess: () => {
        onLent()
        setOpen(false)
        toast.success('Marked as lent out')
      },
    }),
  )

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    create.mutate({ editionId, borrowerUserId: null, borrowerName: name.trim(), lentOn: todayLocal(), dueOn: emptyToNull(dueOn) })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName('')
          setDueOn('')
        }
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Lend it out
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Lend this copy</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Borrower's name" htmlFor={`loan-name-${editionId}`}>
            <SuggestInput id={`loan-name-${editionId}`} dir="auto" options={suggestions.borrowers} value={name} onChange={(v) => setName(v)} required />
          </Field>
          <Field label="Due back (optional)" htmlFor={`loan-due-${editionId}`}>
            <Input id={`loan-due-${editionId}`} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={name.trim() === '' || create.isPending}>
              Lend
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
