import { describe, expect, it } from 'vitest'
import { mergeDraft, peopleSummary, filterOptionLabel } from './people-state'

const person = (id: string, names: { id: string; name: string; language: string | null }[], books: { nameId: string | null; language: string | null }[], bookCount = books.length) => ({
  id,
  names: names.map((n, i) => ({ ...n, primary: i === 0 })),
  books: books.map((b, i) => ({ workId: `${id}-${String(i)}`, title: 'x', role: 'author' as const, ...b })),
  bookCount,
})

describe('mergeDraft', () => {
  it('defaults the primary to the person with more books and prefills each name’s language from its books', () => {
    const opened = person('a', [{ id: 'he', name: 'ברנדון סנדרסון', language: null }], [{ nameId: 'he', language: 'he' }])
    const other = person('b', [{ id: 'en', name: 'Brandon Sanderson', language: null }], [{ nameId: 'en', language: 'en' }, { nameId: 'en', language: 'en' }])
    expect(mergeDraft(opened, other)).toEqual({ primaryNameId: 'en', languages: { he: 'he', en: 'en' } })
  })
})

describe('peopleSummary', () => {
  it('names each role a person has books in, or says No books', () => {
    expect(peopleSummary({ authorOf: 2, translatorOf: 0, narratorOf: 1, illustratorOf: 0 })).toBe('Author of 2 · Narrator of 1')
    expect(peopleSummary({ authorOf: 0, translatorOf: 0, narratorOf: 0, illustratorOf: 3 })).toBe('Illustrator of 3')
    expect(peopleSummary({ authorOf: 0, translatorOf: 0, narratorOf: 0, illustratorOf: 0 })).toBe('No books')
  })
})

describe('filterOptionLabel', () => {
  it('adds the other names in parentheses', () => {
    expect(filterOptionLabel({ name: 'Brandon Sanderson', otherNames: ['ברנדון סנדרסון'] })).toBe('Brandon Sanderson (ברנדון סנדרסון)')
    expect(filterOptionLabel({ name: 'Isaac Stewart', otherNames: [] })).toBe('Isaac Stewart')
  })
})
