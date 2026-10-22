import { describe, expect, it } from 'vitest'
import { AddNameInput, MergePeopleInput, defaultPrimaryName, prefillNameLanguage, replacePersonInFilter } from './people'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'

describe('defaultPrimaryName', () => {
  it('picks the primary name of the person with more books, the opened person on a tie', () => {
    expect(defaultPrimaryName({ primaryNameId: 'a', bookCount: 1 }, { primaryNameId: 'b', bookCount: 3 })).toBe('b')
    expect(defaultPrimaryName({ primaryNameId: 'a', bookCount: 3 }, { primaryNameId: 'b', bookCount: 1 })).toBe('a')
    expect(defaultPrimaryName({ primaryNameId: 'a', bookCount: 2 }, { primaryNameId: 'b', bookCount: 2 })).toBe('a')
  })
})

describe('prefillNameLanguage', () => {
  it("keeps a name's own language", () => {
    expect(prefillNameLanguage('en', ['he', 'he'])).toBe('en')
  })
  it("takes the books' language when they all share one, ignoring unknown ones", () => {
    expect(prefillNameLanguage(null, ['he', null, ' he '])).toBe('he')
  })
  it('stays empty for mixed or no known languages', () => {
    expect(prefillNameLanguage(null, ['he', 'en'])).toBeNull()
    expect(prefillNameLanguage(null, [null])).toBeNull()
    expect(prefillNameLanguage(null, [])).toBeNull()
  })
})

describe('replacePersonInFilter', () => {
  it('rewrites author and narrator ids anywhere in the tree, without duplicates', () => {
    expect(
      replacePersonInFilter(
        {
          op: 'and',
          nodes: [
            { op: 'author', contributorIds: [A, B] },
            { op: 'not', node: { op: 'narrator', contributorIds: [A] } },
            { op: 'or', nodes: [{ op: 'format', formats: ['ebook'] }, { op: 'author', contributorIds: [C] }] },
          ],
        },
        A,
        B,
      ),
    ).toEqual({
      op: 'and',
      nodes: [
        { op: 'author', contributorIds: [B] },
        { op: 'not', node: { op: 'narrator', contributorIds: [B] } },
        { op: 'or', nodes: [{ op: 'format', formats: ['ebook'] }, { op: 'author', contributorIds: [C] }] },
      ],
    })
  })
})

describe('inputs', () => {
  it('a merge needs two different people', () => {
    expect(MergePeopleInput.safeParse({ personId: A, otherId: A, primaryNameId: C }).success).toBe(false)
    expect(MergePeopleInput.parse({ personId: A, otherId: B, primaryNameId: C }).languages).toEqual([])
  })
  it('a blank language is no language', () => {
    expect(AddNameInput.parse({ personId: A, name: ' ברנדון סנדרסון ', language: ' ' })).toEqual({ personId: A, name: 'ברנדון סנדרסון', language: null })
  })
})
