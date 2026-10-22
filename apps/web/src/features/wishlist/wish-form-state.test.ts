import { describe, expect, it } from 'vitest'
import { criteriaLabel, draftFromFields, emptyDraft, fieldsFromDraft, seedDraft, toggleFormat } from './wish-form-state'

describe('wish form', () => {
  it('starts with no format (any) and the page language', () => {
    expect(emptyDraft({ language: 'he' })).toEqual({ formats: [], language: 'he', note: '' })
    expect(emptyDraft()).toEqual({ formats: [], language: '', note: '' })
  })
  it('toggles formats and keeps them in catalog order', () => {
    const d = toggleFormat(toggleFormat(emptyDraft(), 'audiobook'), 'physical')
    expect(d.formats).toEqual(['physical', 'audiobook'])
    expect(toggleFormat(d, 'physical').formats).toEqual(['audiobook'])
  })
  it('sends blanks as null', () => {
    expect(fieldsFromDraft({ formats: [], language: ' ', note: '' })).toEqual({ formats: [], language: null, note: null })
    expect(draftFromFields({ formats: ['ebook'], language: null, note: 'x' })).toEqual({ formats: ['ebook'], language: '', note: 'x' })
  })
  it('says what the wish asks for', () => {
    expect(criteriaLabel({ formats: [], language: null })).toBe('Any format')
    expect(criteriaLabel({ formats: ['physical', 'audiobook'], language: 'he' })).toBe('Physical or audiobook · Hebrew')
  })
})

describe('seedDraft', () => {
  const wish = { formats: ['ebook' as const], language: null, note: 'x' }
  it('waits while the wish is loading, so a blank form is never saved over it', () => {
    expect(seedDraft(null, undefined)).toBeNull()
  })
  it('shows the existing wish, or a blank one when there is none', () => {
    expect(seedDraft(null, wish)).toEqual({ formats: ['ebook'], language: '', note: 'x' })
    expect(seedDraft(null, null)).toEqual(emptyDraft())
  })
  it('keeps the person edits over the wish', () => {
    const edits = { formats: [], language: 'he', note: '' }
    expect(seedDraft(edits, wish)).toBe(edits)
  })
})
