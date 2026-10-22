import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { groupByBorrower } from '@/features/loans/group-loans'
import { todayLocal } from '@/lib/format'
import { trpc, type RouterOutputs } from '@/lib/trpc'

export const Route = createFileRoute('/_app/loans')({ component: LoansPage })

type Loan = RouterOutputs['loans']['open'][number]

function LoansPage() {
  const loans = useQuery(trpc.loans.open.queryOptions())
  const count = loans.data?.length
  return (
    <PageBody width="narrow">
      <PageHeader title="Who has my books" description={count ? `${count} ${count === 1 ? 'book' : 'books'} lent out` : undefined} />
      {loans.isPending ? <Skeleton className="h-40 w-full" /> : null}
      {loans.error ? (
        <p role="alert" className="text-sm text-destructive" dir="auto">
          Could not load the loans: {loans.error.message} — reload the page to try again
        </p>
      ) : null}
      {loans.data && loans.data.length === 0 ? <EmptyState title="Nothing is lent out" hint="Lend a copy from its book page." /> : null}
      {loans.data && loans.data.length > 0 ? <LoanGroups loans={loans.data} /> : null}
    </PageBody>
  )
}

function LoanGroups({ loans }: { loans: Loan[] }) {
  const queryClient = useQueryClient()
  const returnLoan = useMutation(
    trpc.loans.return.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.loans.pathKey() })
        toast.success('Marked as returned')
      },
    }),
  )
  const today = todayLocal()
  return (
    <div className="grid grid-cols-1 gap-8">
      {groupByBorrower(loans).map((group, i) => (
        <section key={group.key} aria-labelledby={`borrower-${i}`} className="min-w-0">
          <h2 id={`borrower-${i}`} className="mb-3 flex flex-wrap items-baseline gap-x-2 text-lg font-semibold">
            <bdi className="min-w-0 break-words">{group.name}</bdi>
            <span className="text-sm font-normal text-muted-foreground">
              {group.household ? 'household · ' : ''}
              {group.loans.length} {group.loans.length === 1 ? 'book' : 'books'}
            </span>
          </h2>
          <ul className="divide-y rounded-lg border">
            {group.loans.map((l) => {
              const overdue = l.dueOn !== null && l.dueOn < today
              return (
                <li key={l.id} className="flex min-h-11 items-center gap-3 p-3 text-sm">
                  <span className="grid min-w-0 flex-1 grid-cols-1 gap-0.5">
                    <Link to="/books/$workId" params={{ workId: l.workId }} className="font-medium break-words text-match-parent hover:underline" dir="auto">
                      {l.workTitle}
                    </Link>
                    {/* dates never break at their hyphens */}
                    <span className="text-muted-foreground">
                      since <span className="whitespace-nowrap tabular-nums">{l.lentOn}</span>
                      {l.dueOn !== null ? (
                        <>
                          {' · '}
                          <span className={overdue ? 'font-medium whitespace-nowrap text-destructive' : 'whitespace-nowrap'}>
                            {overdue ? 'overdue since' : 'due'} <span className="tabular-nums">{l.dueOn}</span>
                          </span>
                        </>
                      ) : null}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 pointer-coarse:min-h-11"
                    disabled={returnLoan.isPending && returnLoan.variables.loanId === l.id}
                    aria-label={`Returned: ${l.workTitle}`}
                    onClick={() => returnLoan.mutate({ loanId: l.id, on: todayLocal() })}
                  >
                    Returned
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
