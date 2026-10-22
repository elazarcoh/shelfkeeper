import type { RouterOutputs } from '@/lib/trpc'

export type OpenLoan = Pick<
  RouterOutputs['loans']['open'][number],
  'id' | 'workId' | 'workTitle' | 'borrowerUserId' | 'borrowerName' | 'borrowerDisplayName' | 'lentOn' | 'dueOn'
>

export interface BorrowerGroup<L extends OpenLoan = OpenLoan> {
  key: string
  name: string
  household: boolean
  loans: L[]
}

/** One group per borrower: a household member by id, anyone else by the typed name (ignoring case and spaces). */
export function groupByBorrower<L extends OpenLoan>(loans: readonly L[]): BorrowerGroup<L>[] {
  const groups = new Map<string, BorrowerGroup<L>>()
  for (const l of loans) {
    const household = l.borrowerUserId !== null
    const name = household ? (l.borrowerDisplayName ?? 'A household member') : (l.borrowerName ?? '').trim()
    const key = household ? `user:${l.borrowerUserId}` : `name:${name.toLocaleLowerCase()}`
    const group = groups.get(key)
    if (group) group.loans.push(l)
    else groups.set(key, { key, name, household, loans: [l] })
  }
  return [...groups.values()].sort((a, b) => Number(b.household) - Number(a.household) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}
