import { describe, expect, it } from 'vitest'
import { bookLanguages, formatDuration, holdingStateLabel, languageName, seriesLabel, todayLocal, wishedByLabel } from './format'

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(45_000)).toBe('12h 30m')
    expect(formatDuration(1_800)).toBe('30m')
    expect(formatDuration(3_600)).toBe('1h 0m')
  })
  it('bookLanguages: distinct edition languages in edition order, one spelling each (#124)', () => {
    expect(bookLanguages([{ language: 'he' }, { language: 'en' }, { language: ' HE ' }, { language: null }])).toBe('Hebrew, English')
    expect(bookLanguages([{ language: null }])).toBeNull()
    expect(bookLanguages([])).toBeNull()
  })
  it('labels series positions', () => {
    expect(seriesLabel({ name: 'Mistborn', position: 1 })).toBe('Mistborn #1')
    expect(seriesLabel({ name: 'Cosmere', position: null })).toBe('Cosmere')
  })
  it('labels holding states', () => {
    expect(holdingStateLabel({ ownership: 'owned', inPossession: true })).toBeNull()
    expect(holdingStateLabel({ ownership: 'owned', inPossession: false })).toBe('Formerly owned')
    expect(holdingStateLabel({ ownership: 'borrowed', inPossession: true })).toBe('Borrowed')
    expect(holdingStateLabel({ ownership: 'borrowed', inPossession: false })).toBe('Returned')
  })
  it('names language codes and keeps anything else as entered', () => {
    expect(languageName('he')).toBe('Hebrew')
    expect(languageName('en')).toBe('English')
    expect(languageName('Hebrew, English')).toBe('Hebrew, English')
  })
  it('formats today as a local ISO date', () => {
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('names who wishes for a book, me first', () => {
    const me = 'u1'
    expect(wishedByLabel([], me)).toBeNull()
    expect(wishedByLabel([{ userId: 'u2', name: 'Dad' }], me)).toBe('On Dad’s wishlist')
    expect(wishedByLabel([{ userId: 'u2', name: 'Dad' }, { userId: 'u1', name: 'Noa' }], me)).toBe('On your and Dad’s wishlists')
    expect(wishedByLabel([{ userId: 'u2', name: 'Dad' }, { userId: 'u3', name: 'Mom' }], me)).toBe('On Dad’s and Mom’s wishlists')
    expect(wishedByLabel([{ userId: 'u1', name: 'Noa' }], me)).toBe('On your wishlist')
    expect(wishedByLabel([{ userId: 'u2', name: 'Dad' }, { userId: 'u3', name: 'Mom' }, { userId: 'u1', name: 'Noa' }], me)).toBe('On your, Dad’s and Mom’s wishlists')
  })
})

describe('seriesLabel ranges', () => {
  it('names a series with its position or range (#122)', () => {
    expect(seriesLabel({ name: 'Mage Errant', position: null })).toBe('Mage Errant')
    expect(seriesLabel({ name: 'Mage Errant', position: 3 })).toBe('Mage Errant #3')
    expect(seriesLabel({ name: 'Mage Errant', position: 1, positionEnd: 2 })).toBe('Mage Errant #1–2')
  })
})
