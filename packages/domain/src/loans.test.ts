import { describe, expect, it } from 'vitest'
import { LoanInput } from './loans'

describe('LoanInput', () => {
  const base = { editionId: '11111111-1111-4111-8111-111111111111', lentOn: '2026-03-01', dueOn: null }

  it('requires exactly one of borrowerUserId or borrowerName', () => {
    expect(LoanInput.safeParse({ ...base, borrowerUserId: null, borrowerName: null }).success).toBe(false)
    expect(
      LoanInput.safeParse({
        ...base,
        borrowerUserId: '22222222-2222-4222-8222-222222222222',
        borrowerName: 'Dana',
      }).success,
    ).toBe(false)
  })
  it('accepts a household borrower or a named borrower', () => {
    expect(
      LoanInput.safeParse({ ...base, borrowerUserId: '22222222-2222-4222-8222-222222222222', borrowerName: null }).success,
    ).toBe(true)
    expect(LoanInput.safeParse({ ...base, borrowerUserId: null, borrowerName: 'Dana' }).success).toBe(true)
  })
})
