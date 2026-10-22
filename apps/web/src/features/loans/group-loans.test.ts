import { describe, expect, it } from 'vitest'
import { groupByBorrower, type OpenLoan } from './group-loans'

function loan(id: string, over: Partial<OpenLoan>): OpenLoan {
  return { id, workId: `w-${id}`, workTitle: id, borrowerUserId: null, borrowerName: null, borrowerDisplayName: null, lentOn: '2026-01-01', dueOn: null, ...over }
}

describe('groupByBorrower', () => {
  it('puts household members first, then other people, each by name; loans keep their order', () => {
    const groups = groupByBorrower([
      loan('a', { borrowerName: 'Zoe' }),
      loan('b', { borrowerUserId: 'u1', borrowerDisplayName: 'Noa' }),
      loan('c', { borrowerName: 'dana' }),
      loan('d', { borrowerName: 'Zoe' }),
    ])
    expect(groups.map((g) => [g.name, g.household, g.loans.map((l) => l.id)])).toEqual([
      ['Noa', true, ['b']],
      ['dana', false, ['c']],
      ['Zoe', false, ['a', 'd']],
    ])
  })

  it('treats the same typed name with different case or spaces as one person, shown as first typed', () => {
    const groups = groupByBorrower([loan('a', { borrowerName: 'Dana ' }), loan('b', { borrowerName: ' dana' })])
    expect(groups.map((g) => [g.name, g.loans.length])).toEqual([['Dana', 2]])
  })

  it('names a household member whose name is unknown', () => {
    expect(groupByBorrower([loan('a', { borrowerUserId: 'u1' })])[0]?.name).toBe('A household member')
  })
})
