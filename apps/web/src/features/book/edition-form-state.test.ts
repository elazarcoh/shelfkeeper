import { describe, expect, it } from 'vitest'
import { durationToSeconds, editionFormFromDetail, editionFormFromInput, editionFormToInput, emptyEditionForm } from './edition-form-state'

describe('edition form state', () => {
  it('converts hours and minutes', () => {
    expect(durationToSeconds('12', '30')).toBe(45_000)
    expect(durationToSeconds('', '45')).toBe(2_700)
    expect(durationToSeconds(' ', '')).toBeNull()
  })
  it('clears fields that do not apply to the format', () => {
    const form = { ...emptyEditionForm('audiobook'), shelfLocation: 'Hall', pageCount: '300', narrators: 'Michael Kramer', hours: '24' }
    expect(editionFormToInput(form)).toMatchObject({
      format: 'audiobook',
      shelfLocation: null,
      pageCount: null,
      durationSec: 86_400,
      narrators: ['Michael Kramer'],
    })
    expect(editionFormToInput({ ...form, format: 'physical' })).toMatchObject({ shelfLocation: 'Hall', pageCount: 300, durationSec: null, narrators: [] })
  })
  it('carries the initial holding for new editions', () => {
    const form = { ...emptyEditionForm('physical'), ownership: 'borrowed' as const, holdingOn: '2026-03-01', holdingNote: 'City library' }
    expect(editionFormToInput(form)).toMatchObject({ ownership: 'borrowed', holdingOn: '2026-03-01', holdingNote: 'City library' })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(editionFormToInput(emptyEditionForm())).toMatchObject({ ownership: 'owned', holdingOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), holdingNote: null })
  })
  it('reads a stored edition back into the form', () => {
    const form = editionFormFromDetail({
      id: 'e',
      format: 'audiobook',
      title: null,
      subtitle: 'Book One',
      displayTitle: 'T',
      displaySubtitle: null,
      isbn13: null,
      isbn10: null,
      asin: 'B002UZMLXM',
      publisher: 'Macmillan Audio',
      publishedOn: '2009-01-01',
      pageCount: null,
      wordCount: null,
      durationSec: 45_000,
      language: null,
      shelfLocation: null,
      volume: null,
      volumeCount: null,
      ownership: 'owned',
      inPossession: true,
      provenance: {},
      coverAssetId: null,
      narrators: [{ id: 'n', name: 'Michael Kramer' }],
      translators: [],
      history: [],
      sources: [],
    })
    expect(form).toMatchObject({ hours: '12', minutes: '30', asin: 'B002UZMLXM', narrators: 'Michael Kramer', subtitle: 'Book One' })
    expect(editionFormToInput(form).subtitle).toBe('Book One')
    expect(editionFormToInput(emptyEditionForm()).subtitle).toBeNull()
  })
})

describe('edition volume fields', () => {
  it('round-trips volume and count', () => {
    const form = { ...emptyEditionForm(), volume: '1', volumeCount: '2' }
    expect(editionFormToInput(form)).toMatchObject({ volume: 1, volumeCount: 2 })
    expect(editionFormToInput(emptyEditionForm())).toMatchObject({ volume: null, volumeCount: null })
  })
})

describe('editionFormFromInput', () => {
  it('round-trips through editionFormToInput', () => {
    const form = editionFormFromInput({
      format: 'audiobook', title: null, subtitle: 'Vol. 2', isbn13: null, isbn10: null, asin: 'B002UZMLXM', publisher: 'Macmillan', publishedOn: '2006-07-17',
      pageCount: null, wordCount: null, durationSec: 88_200, language: 'en', shelfLocation: null, volume: 2, volumeCount: 3,
      narrators: ['Michael Kramer'], translators: [], ownership: 'owned', holdingOn: null, holdingNote: null,
    })
    expect(form).toMatchObject({ subtitle: 'Vol. 2', format: 'audiobook', asin: 'B002UZMLXM', hours: '24', minutes: '30', volume: '2', volumeCount: '3', narrators: 'Michael Kramer', holdingOn: '' })
    expect(editionFormToInput(form)).toMatchObject({ durationSec: 88_200, volume: 2, volumeCount: 3, narrators: ['Michael Kramer'] })
  })
})
