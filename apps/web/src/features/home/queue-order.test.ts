import { describe, expect, it } from 'vitest'
import { inOrder } from './queue-order'

const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('inOrder', () => {
  it('puts the cards in the requested order', () => {
    expect(inOrder(cards, ['c', 'a', 'b']).map((c) => c.id)).toEqual(['c', 'a', 'b'])
  })
  it('drops ids whose card is gone (removed meanwhile)', () => {
    expect(inOrder(cards.slice(0, 2), ['c', 'b', 'a']).map((c) => c.id)).toEqual(['b', 'a'])
  })
  it('keeps a card the order does not know at the end', () => {
    expect(inOrder(cards, ['b', 'a']).map((c) => c.id)).toEqual(['b', 'a', 'c'])
  })
})
