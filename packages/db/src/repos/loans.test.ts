import { describe, expect, it } from 'vitest'
import { LoanInput } from '@mylib/domain'
import { userHiddenWorks } from '../schema'
import { seedUser, useTestDb, workInput } from '../testing'
import { createWork, getWorkDetail } from './catalog'
import { createLoan, listLoansForEdition, listOpenLoans, returnLoan } from './loans'
import { loadUserScope } from './scope'

describe('loans repository', () => {
  const t = useTestDb()

  async function setupOwnedEdition() {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const workId = await createWork(t.db, workInput({ title: 'A', series: [], editions: [{ format: 'physical' }] }))
    const editionId = (await getWorkDetail(t.db, scope, workId)).editions[0]?.id ?? ''
    return { user, scope, workId, editionId }
  }

  it('lends an owned, in-possession copy and lists it while active', async () => {
    const { scope, editionId } = await setupOwnedEdition()
    const id = await createLoan(
      t.db,
      scope,
      LoanInput.parse({ editionId, borrowerUserId: null, borrowerName: 'Dana', lentOn: '2026-03-01', dueOn: null }),
    )
    const [loan] = await listLoansForEdition(t.db, scope, editionId)
    expect(loan).toMatchObject({ id, borrowerName: 'Dana', returnedOn: null })
  })

  it('rejects lending the same copy twice while active, but allows it again after return', async () => {
    const { scope, editionId } = await setupOwnedEdition()
    const id = await createLoan(
      t.db,
      scope,
      LoanInput.parse({ editionId, borrowerUserId: null, borrowerName: 'Dana', lentOn: '2026-03-01', dueOn: null }),
    )
    await expect(
      createLoan(t.db, scope, LoanInput.parse({ editionId, borrowerUserId: null, borrowerName: 'Sam', lentOn: '2026-03-02', dueOn: null })),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await returnLoan(t.db, scope, id, '2026-03-04')
    await expect(
      createLoan(t.db, scope, LoanInput.parse({ editionId, borrowerUserId: null, borrowerName: 'Sam', lentOn: '2026-03-05', dueOn: null })),
    ).resolves.toEqual(expect.any(String))
  })

  it('rejects lending a copy that is not currently owned and in possession', async () => {
    const user = await seedUser(t.db)
    const scope = await loadUserScope(t.db, user)
    const workId = await createWork(t.db, workInput({ title: 'A', series: [], editions: [{ format: 'physical', ownership: 'borrowed' }] }))
    const editionId = (await getWorkDetail(t.db, scope, workId)).editions[0]?.id ?? ''
    await expect(
      createLoan(t.db, scope, LoanInput.parse({ editionId, borrowerUserId: null, borrowerName: 'Dana', lentOn: '2026-03-01', dueOn: null })),
    ).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('treats a hidden work as missing for returning a loan', async () => {
    const { user, scope, workId, editionId } = await setupOwnedEdition()
    const id = await createLoan(
      t.db,
      scope,
      LoanInput.parse({ editionId, borrowerUserId: null, borrowerName: 'Dana', lentOn: '2026-03-01', dueOn: null }),
    )
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId })
    const hiddenScope = await loadUserScope(t.db, user)
    await expect(returnLoan(t.db, hiddenScope, id, '2026-03-04')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('stamps the client-supplied return date and rejects returning a loan twice', async () => {
    const { scope, editionId } = await setupOwnedEdition()
    const id = await createLoan(
      t.db,
      scope,
      LoanInput.parse({ editionId, borrowerUserId: null, borrowerName: 'Dana', lentOn: '2026-03-01', dueOn: null }),
    )
    await returnLoan(t.db, scope, id, '2026-03-04')
    expect((await listLoansForEdition(t.db, scope, editionId))[0]?.returnedOn).toBe('2026-03-04')
    await expect(returnLoan(t.db, scope, id, '2026-03-09')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await listLoansForEdition(t.db, scope, editionId))[0]?.returnedOn).toBe('2026-03-04')
  })

  it('lists open loans of the books this person can see, oldest first, with a household borrower named', async () => {
    const { user, scope, workId, editionId } = await setupOwnedEdition()
    const member = await seedUser(t.db, { username: 'noa' })
    const otherWork = await createWork(t.db, workInput({ title: 'B', series: [], editions: [{ format: 'physical' }] }))
    const otherEdition = (await getWorkDetail(t.db, scope, otherWork)).editions[0]?.id ?? ''
    const returned = await createLoan(t.db, scope, LoanInput.parse({ editionId, borrowerName: 'Sam', lentOn: '2026-01-01' }))
    await returnLoan(t.db, scope, returned, '2026-01-05')
    await createLoan(t.db, scope, LoanInput.parse({ editionId, borrowerName: 'Dana', lentOn: '2026-03-01' }))
    await createLoan(t.db, scope, LoanInput.parse({ editionId: otherEdition, borrowerUserId: member.id, lentOn: '2026-02-01' }))

    const open = await listOpenLoans(t.db, scope)
    expect(open.map((l) => [l.workTitle, l.borrowerName, l.borrowerUserId, l.borrowerDisplayName])).toEqual([
      ['B', null, member.id, 'noa'],
      ['A', 'Dana', null, null],
    ])

    // a hidden book's loan is not this person's to see
    await t.db.insert(userHiddenWorks).values({ userId: user.id, workId })
    expect((await listOpenLoans(t.db, await loadUserScope(t.db, user))).map((l) => l.workTitle)).toEqual(['B'])
  })
})
