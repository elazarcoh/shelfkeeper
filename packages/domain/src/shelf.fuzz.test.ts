import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseShelfAnswer } from './shelf'

describe('parseShelfAnswer never throws', () => {
  it('on any text', () => {
    fc.assert(fc.property(fc.string({ maxLength: 2000 }), (s) => { expect(() => parseShelfAnswer(s)).not.toThrow() }))
  })
  it('on any JSON value', () => {
    fc.assert(fc.property(fc.json(), (s) => { expect(() => parseShelfAnswer(s)).not.toThrow() }))
  })
})
