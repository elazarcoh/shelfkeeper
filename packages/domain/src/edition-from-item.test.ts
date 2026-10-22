import { describe, expect, it } from 'vitest'
import { EditionInput } from './catalog'
import { CsvResolution } from './csv'
import { changedEditionFields, editionInputFromItem } from './edition-from-item'
import { InboxResolution } from './proposals'
import { ExternalItem } from './sources'

const shelfBook = ExternalItem.parse({
  externalId: 'row-1',
  format: 'physical',
  title: 'דרך המלכים',
  authors: ['ברנדון סנדרסון'],
  translators: ['דנה'],
  identifiers: { isbn13: '9780306406157' },
  publisher: 'אופוס',
  publishedOn: '2012-05-01',
  pageCount: 512,
  language: 'he',
  volume: { number: 2, count: 3 },
})

const audiobook = ExternalItem.parse({
  externalId: 'li_1',
  format: 'audiobook',
  title: 'The Final Empire',
  authors: ['Brandon Sanderson'],
  narrators: ['Michael Kramer'],
  identifiers: { asin: 'B002UZMLXM' },
  durationSec: 88_000,
})

describe('editionInputFromItem', () => {
  it('maps a physical shelf item with a volume', () => {
    expect(editionInputFromItem(shelfBook)).toEqual({
      format: 'physical',
      title: null,
      subtitle: null,
      isbn13: '9780306406157',
      isbn10: null,
      asin: null,
      publisher: 'אופוס',
      publishedOn: '2012-05-01',
      pageCount: 512,
      wordCount: null,
      durationSec: null,
      language: 'he',
      shelfLocation: null,
      volume: 2,
      volumeCount: 3,
      narrators: [],
      translators: ['דנה'],
      ownership: 'owned',
      holdingOn: null,
      holdingNote: null,
    })
  })

  it('maps an audiobook source item, which has no volume', () => {
    expect(editionInputFromItem(audiobook)).toMatchObject({ format: 'audiobook', asin: 'B002UZMLXM', durationSec: 88_000, narrators: ['Michael Kramer'], volume: null, volumeCount: null })
  })

  it('is a valid EditionInput', () => {
    expect(EditionInput.safeParse(editionInputFromItem(shelfBook)).success).toBe(true)
  })
})

describe('changedEditionFields', () => {
  const base = editionInputFromItem(shelfBook)

  it('is empty when nothing changed', () => {
    expect(changedEditionFields(base, { ...base })).toEqual([])
  })

  it('lists changed and cleared scalars, and a changed format', () => {
    expect(changedEditionFields(base, { ...base, volume: 1, publisher: null, format: 'ebook' }).sort()).toEqual(['format', 'publisher', 'volume'])
  })

  it('counts reordered or edited people as changed', () => {
    const two = { ...base, translators: ['דנה', 'יואב'] }
    expect(changedEditionFields(two, { ...two, translators: ['יואב', 'דנה'] })).toEqual(['translators'])
  })

  it('compares durations at minute precision, as the form shows whole minutes', () => {
    const a = { ...base, durationSec: 88_000 }
    expect(changedEditionFields(a, { ...a, durationSec: 88_020 })).toEqual([])
    expect(changedEditionFields(a, { ...a, durationSec: 91_000 })).toEqual(['durationSec'])
    const none = { ...base, durationSec: null }
    expect(changedEditionFields(none, { ...none, durationSec: 60 })).toEqual(['durationSec'])
    expect(changedEditionFields(none, { ...none })).toEqual([])
  })

  it('ignores the holding keys', () => {
    expect(changedEditionFields(base, { ...base, ownership: 'borrowed', holdingOn: '2026-10-18', holdingNote: 'Dana' })).toEqual([])
  })
})

describe('link_new_edition carries an optional edition', () => {
  const workId = '6f1c2b1e-3d4a-4111-8111-111111111111'
  it('accepts it with and without the form', () => {
    expect(InboxResolution.parse({ action: 'link_new_edition', workId })).toEqual({ action: 'link_new_edition', workId })
    expect(InboxResolution.parse({ action: 'link_new_edition', workId, edition: { format: 'physical', volume: 2, volumeCount: 3 } })).toMatchObject({ edition: { format: 'physical', volume: 2, volumeCount: 3, ownership: 'owned' } })
    expect(CsvResolution.parse({ action: 'link_new_edition', workId, edition: { format: 'ebook' } })).toMatchObject({ edition: { format: 'ebook' } })
  })
  it('refuses a volume above its own count', () => {
    expect(InboxResolution.safeParse({ action: 'link_new_edition', workId, edition: { format: 'physical', volume: 4, volumeCount: 3 } }).success).toBe(false)
  })
})
