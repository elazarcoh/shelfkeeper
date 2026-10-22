import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { DomainError, notFound, type LoanInput } from '@mylib/domain'
import type { Db } from '../client'
import { editions, loans, users, works } from '../schema'
import type { UserScope } from './scope'
import { shownTitleField } from './titles'

export interface LoanView {
  id: string
  editionId: string
  workId: string
  workTitle: string
  borrowerUserId: string | null
  borrowerName: string | null
  /** the household member's display name when the borrower is one */
  borrowerDisplayName: string | null
  lentOn: string
  dueOn: string | null
  returnedOn: string | null
}

const loanColumns = (scope: UserScope) => ({
  id: loans.id,
  editionId: loans.editionId,
  workId: editions.workId,
  workTitle: shownTitleField(works.id, scope.languages, 'title'),
  borrowerUserId: loans.borrowerUserId,
  borrowerName: loans.borrowerName,
  borrowerDisplayName: users.displayName,
  lentOn: loans.lentOn,
  dueOn: loans.dueOn,
  returnedOn: loans.returnedOn,
})

export async function createLoan(db: Db, scope: UserScope, input: LoanInput): Promise<string> {
  return db.transaction(async (tx) => {
    const [edition] = await tx
      .select({ id: editions.id, ownership: editions.ownership, inPossession: editions.inPossession })
      .from(editions)
      .innerJoin(works, eq(works.id, editions.workId))
      .where(and(eq(editions.id, input.editionId), scope.visible))
      // lock the edition so two concurrent lends can't both pass the "already lent out" check
      .for('update', { of: editions })
    if (!edition) throw notFound('Edition')
    if (edition.ownership !== 'owned' || !edition.inPossession) {
      throw new DomainError('INVALID', 'You can only lend a copy you currently own and have')
    }
    const [active] = await tx
      .select({ id: loans.id })
      .from(loans)
      .where(and(eq(loans.editionId, input.editionId), isNull(loans.returnedOn)))
    if (active) throw new DomainError('CONFLICT', 'This copy is already lent out')

    const [row] = await tx
      .insert(loans)
      .values({
        editionId: input.editionId,
        lentByUserId: scope.userId,
        borrowerUserId: input.borrowerUserId,
        borrowerName: input.borrowerName,
        lentOn: input.lentOn,
        dueOn: input.dueOn,
      })
      .returning({ id: loans.id })
    if (!row) throw new Error('loan insert failed')
    return row.id
  })
}

/** `on` is the client's local date. Only an active loan can be returned; check and update share one transaction. */
export async function returnLoan(db: Db, scope: UserScope, loanId: string, on: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: loans.id })
      .from(loans)
      .innerJoin(editions, eq(editions.id, loans.editionId))
      .innerJoin(works, eq(works.id, editions.workId))
      .where(and(eq(loans.id, loanId), scope.visible))
      .for('update', { of: loans })
    if (!row) throw notFound('Loan')
    const updated = await tx
      .update(loans)
      .set({ returnedOn: on })
      .where(and(eq(loans.id, loanId), isNull(loans.returnedOn)))
      .returning({ id: loans.id })
    if (updated.length === 0) throw new DomainError('CONFLICT', 'This loan was already returned')
  })
}

export async function listLoansForEdition(db: Db, scope: UserScope, editionId: string): Promise<LoanView[]> {
  return db
    .select(loanColumns(scope))
    .from(loans)
    .innerJoin(editions, eq(editions.id, loans.editionId))
    .innerJoin(works, eq(works.id, editions.workId))
    .leftJoin(users, eq(users.id, loans.borrowerUserId))
    .where(and(eq(loans.editionId, editionId), scope.visible))
    .orderBy(desc(loans.lentOn))
}

/** "Who has my books": every open loan of a book this person can see, longest out first. */
export async function listOpenLoans(db: Db, scope: UserScope): Promise<LoanView[]> {
  return db
    .select(loanColumns(scope))
    .from(loans)
    .innerJoin(editions, eq(editions.id, loans.editionId))
    .innerJoin(works, eq(works.id, editions.workId))
    .leftJoin(users, eq(users.id, loans.borrowerUserId))
    .where(and(isNull(loans.returnedOn), scope.visible))
    .orderBy(asc(loans.lentOn), asc(shownTitleField(works.id, scope.languages, 'title')), asc(loans.id))
}
