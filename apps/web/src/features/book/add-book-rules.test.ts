import { describe, expect, it } from 'vitest'
import {
  hasOptionalError,
  hiddenOnPhone,
  isOptionalEditionKey,
  isOptionalWorkKey,
  moreMatchesCount,
  optionalPanelHiddenClass,
  PHONE_MATCH_LIMIT,
} from './add-book-rules'

describe('isOptionalWorkKey', () => {
  it('keeps Title, Authors and edition errors out of the work disclosure', () => {
    for (const k of ['title', 'authors', 'authors.0', 'editions.0.format']) expect(isOptionalWorkKey(k)).toBe(false)
  })
  it('treats every other work field as optional', () => {
    for (const k of ['subtitle', 'series', 'series.0.name', 'tags', 'language', 'originalYear', 'description']) expect(isOptionalWorkKey(k)).toBe(true)
  })
  it('does not confuse prefixes', () => expect(isOptionalWorkKey('titleCase')).toBe(true))
})

describe('isOptionalEditionKey', () => {
  it('keeps Format and the holding fields outside', () => {
    for (const k of ['format', 'ownership', 'holdingOn', 'holdingNote']) expect(isOptionalEditionKey(k)).toBe(false)
  })
  it('hides the rest', () => {
    for (const k of ['isbn13', 'title', 'pageCount', 'durationSec', 'narrators.0', 'shelfLocation']) expect(isOptionalEditionKey(k)).toBe(true)
  })
})

describe('hasOptionalError', () => {
  it('is true only when an optional key has an error', () => {
    expect(hasOptionalError({}, isOptionalWorkKey)).toBe(false)
    expect(hasOptionalError({ title: 'Required' }, isOptionalWorkKey)).toBe(false)
    expect(hasOptionalError({ title: 'Required', originalYear: 'bad' }, isOptionalWorkKey)).toBe(true)
  })
})

describe('optionalPanelHiddenClass', () => {
  it('collapses only on phones, only when collapsible and closed', () => {
    expect(optionalPanelHiddenClass(true, false)).toBe('max-sm:hidden')
    expect(optionalPanelHiddenClass(true, true)).toBe('')
    expect(optionalPanelHiddenClass(false, false)).toBe('')
  })
})

describe('catalog matches on phones', () => {
  it('hides matches past the limit until expanded', () => {
    expect(PHONE_MATCH_LIMIT).toBe(2)
    expect(hiddenOnPhone(0, false)).toBe(false)
    expect(hiddenOnPhone(1, false)).toBe(false)
    expect(hiddenOnPhone(2, false)).toBe(true)
    expect(hiddenOnPhone(4, true)).toBe(false)
  })
  it('counts the matches behind "Show N more"', () => {
    expect(moreMatchesCount(2, false)).toBe(0)
    expect(moreMatchesCount(5, false)).toBe(3)
    expect(moreMatchesCount(5, true)).toBe(0)
  })
})
