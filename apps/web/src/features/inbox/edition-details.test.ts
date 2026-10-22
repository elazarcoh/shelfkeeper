import { describe, expect, it } from 'vitest'
import { ExternalItem } from '@mylib/domain'
import { detailsForm, detailsHolding } from './edition-details'

const item = ExternalItem.parse({ externalId: 'r1', format: 'physical', title: 'Saga', authors: ['X'], language: 'he', pageCount: 300, volume: { number: 2, count: 3 } })

describe('Inbox edition details', () => {
  it('shows "This copy" for owned and borrowed rows, with who it was borrowed from', () => {
    expect(detailsHolding('owned', null)).toEqual({ ownership: 'owned', note: '' })
    expect(detailsHolding('borrowed', 'Dana')).toEqual({ ownership: 'borrowed', note: 'Dana' })
    expect(detailsHolding('borrowed', null)).toEqual({ ownership: 'borrowed', note: '' })
  })
  it('hides it for a read-not-owned row', () => {
    expect(detailsHolding('read_not_owned', null)).toBeNull()
  })
  it('fills the form from the item and the holding', () => {
    expect(detailsForm(item, { ownership: 'borrowed', note: 'Dana' })).toMatchObject({ format: 'physical', language: 'he', pageCount: '300', volume: '2', volumeCount: '3', ownership: 'borrowed', holdingNote: 'Dana', holdingOn: '' })
    expect(detailsForm(item, null)).toMatchObject({ ownership: 'owned', holdingNote: '' })
  })
})
