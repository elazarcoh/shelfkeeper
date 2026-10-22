import { describe, expect, it } from 'vitest'
import { normalizeText, sortName, sortTitle, tokenize } from './text'

describe('normalizeText', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeText('Les Misérables')).toBe('les miserables')
  })
  it('collapses punctuation to single spaces', () => {
    expect(normalizeText('The Way of Kings: Book 1!')).toBe('the way of kings book 1')
  })
  it('drops apostrophes instead of splitting words', () => {
    expect(normalizeText("Ender's Game")).toBe('enders game')
    expect(normalizeText('Ender’s Game')).toBe('enders game')
  })
  it('keeps Hebrew letters and strips niqqud', () => {
    expect(normalizeText('שָׁלוֹם עוֹלָם')).toBe('שלום עולם')
  })
  it('returns an empty string for punctuation only', () => {
    expect(normalizeText(' !!! ')).toBe('')
  })
})

describe('tokenize', () => {
  it('splits normalized text into words', () => {
    expect(tokenize('  Brandon   EMPIRE ')).toEqual(['brandon', 'empire'])
  })
  it('returns no tokens for blank input', () => {
    expect(tokenize('   ')).toEqual([])
  })
})

describe('sortTitle', () => {
  it('drops a leading article', () => {
    expect(sortTitle('The Final Empire')).toBe('final empire')
    expect(sortTitle('A Game of Thrones')).toBe('game of thrones')
    expect(sortTitle('An Echo of Things to Come')).toBe('echo of things to come')
  })
  it('keeps words that merely start with an article', () => {
    expect(sortTitle('Theory of Everything')).toBe('theory of everything')
  })
})

describe('sortName', () => {
  it('puts the last name first', () => {
    expect(sortName('Brandon Sanderson')).toBe('sanderson brandon')
  })
  it('keeps names already written "Last, First"', () => {
    expect(sortName('Le Guin, Ursula K.')).toBe('le guin ursula k')
  })
  it('handles single names', () => {
    expect(sortName('Plato')).toBe('plato')
  })
})
