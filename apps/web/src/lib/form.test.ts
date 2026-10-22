import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { changedFields, fieldErrors, firstError, parseCommaList, parseLines, scopedErrors, toNumberOrNull } from './form'

describe('form helpers', () => {
  it('maps zod issues to dotted paths, first message wins', () => {
    const schema = z.object({ title: z.string().min(1, 'Required'), editions: z.array(z.object({ isbn13: z.string().length(13, 'Bad ISBN') })) })
    const r = schema.safeParse({ title: '', editions: [{ isbn13: '1' }] })
    expect(r.success).toBe(false)
    if (r.success) return
    const errors = fieldErrors(r.error)
    expect(errors).toEqual({ title: 'Required', 'editions.0.isbn13': 'Bad ISBN' })
    expect(firstError(errors, 'editions')).toBe('Bad ISBN')
    expect(scopedErrors(errors, 'editions.0.')).toEqual({ isbn13: 'Bad ISBN' })
  })
  it('parses lists and numbers', () => {
    expect(parseLines(' A \n\n B ')).toEqual(['A', 'B'])
    expect(parseCommaList('fantasy, , epic ')).toEqual(['fantasy', 'epic'])
    expect(toNumberOrNull(' ')).toBeNull()
    expect(toNumberOrNull('2.5')).toBe(2.5)
  })
})

describe('changedFields', () => {
  it('counts unreadable number text (NaN) as a change, so validation sees it (#122)', () => {
    expect(changedFields({ year: null, series: [{ position: null }] }, { year: Number.NaN, series: [{ position: Number.NaN }] })).toEqual({
      year: Number.NaN,
      series: [{ position: Number.NaN }],
    })
  })
  it('returns only keys whose values differ (deep)', () => {
    expect(changedFields({ a: 1, list: ['x'], same: null }, { a: 2, list: ['x'], same: null })).toEqual({ a: 2 })
    expect(changedFields({ list: ['x'] }, { list: ['x', 'y'] })).toEqual({ list: ['x', 'y'] })
  })
})
