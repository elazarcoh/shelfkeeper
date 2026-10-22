import { describe, expect, it } from 'vitest'
import { rankCandidates, type CandidateEdition, type CandidateWork } from './matching'
import { ExternalItem } from './sources'

const W1 = '11111111-1111-4111-8111-111111111111'
const W2 = '22222222-2222-4222-8222-222222222222'
const E1 = '33333333-3333-4333-8333-333333333333'
const E2 = '44444444-4444-4444-8444-444444444444'

const item = ExternalItem.parse({
  externalId: 'li_1',
  format: 'audiobook',
  title: 'The Final Empire',
  authors: ['Brandon Sanderson'],
  identifiers: { asin: 'B002UZMLXM' },
})

const edition = (over: Partial<CandidateEdition> = {}): CandidateEdition => ({
  editionId: E1,
  format: 'physical',
  isbn13: null,
  isbn10: null,
  asin: null,
  ownership: 'owned',
  inPossession: true,
  formerlyFromSource: false,
  language: 'he',
  volume: null,
  volumeCount: null,
  ...over,
})
const work = (over: Partial<CandidateWork> = {}): CandidateWork => ({
  workId: W1,
  authors: [{ names: ['Brandon Sanderson'] }],
  titleSimilarity: 0.9,
  editions: [edition()],
  sharedIds: [],
  ...over,
})

describe('rankCandidates', () => {
  it('scores an identifier match as exact and names the matched copy', () => {
    const [top] = rankCandidates(item, [work({ editions: [edition({ editionId: E2, format: 'audiobook', asin: 'B002UZMLXM' })] })])
    expect(top).toMatchObject({ workId: W1, editionId: E2, score: 1, basis: 'identifier' })
    expect(top?.reasons).toContain('Same ASIN')
  })

  it('scores by title similarity and author overlap otherwise', () => {
    const [top] = rankCandidates(item, [work()])
    expect(top).toMatchObject({ workId: W1, editionId: null, basis: 'title_author' })
    expect(top?.score).toBeCloseTo(0.7 * 0.9 + 0.3 * 1)
    expect(top?.reasons).toEqual(['Title 90% similar', 'Same author'])
  })

  it('drops weak fuzzy matches', () => {
    expect(rankCandidates(item, [work({ titleSimilarity: 0.2, authors: [{ names: ['Someone Else'] }] })])).toEqual([])
  })

  it('ranks a formerly owned copy of the same format from this source first', () => {
    const ranked = rankCandidates(item, [
      work({ workId: W2, titleSimilarity: 1 }),
      work({ workId: W1, titleSimilarity: 0.7, editions: [edition({ editionId: E1, format: 'audiobook', inPossession: false, formerlyFromSource: true })] }),
    ])
    expect(ranked.map((c) => c.workId)).toEqual([W1, W2])
    expect(ranked[0]).toMatchObject({ basis: 'restore', editionId: E1 })
    expect(ranked[0]?.reasons[0]).toBe('Formerly owned copy from this source — restore it?')
  })

  it('treats an item without authors as neutral on the author part', () => {
    const noAuthor = ExternalItem.parse({ externalId: 'x', format: 'audiobook', title: 'The Final Empire' })
    const [top] = rankCandidates(noAuthor, [work()])
    expect(top?.score).toBeCloseTo(0.7 * 0.9 + 0.3 * 0.5)
  })

  it('an author matches a person by any of their names', () => {
    const item = ExternalItem.parse({ externalId: 'r', format: 'physical', title: 'דרך המלכים', authors: ['ברנדון סנדרסון'] })
    const [top] = rankCandidates(item, [work({ titleSimilarity: 0.9, authors: [{ names: ['Brandon Sanderson', 'ברנדון סנדרסון'] }] })])
    expect(top?.reasons).toContain('Same author')
  })

  it('two spellings of one person in the item count once', () => {
    const item = ExternalItem.parse({ externalId: 'r', format: 'physical', title: 'The Way of Kings', authors: ['Brandon Sanderson', 'ברנדון סנדרסון'] })
    const [top] = rankCandidates(item, [work({ titleSimilarity: 0.9, authors: [{ names: ['Brandon Sanderson', 'ברנדון סנדרסון'] }] })])
    expect(top?.reasons).toContain('Same author')
  })

  it('one of two people matching is some authors', () => {
    const item = ExternalItem.parse({ externalId: 'r', format: 'physical', title: 'X', authors: ['Brandon Sanderson'] })
    const [top] = rankCandidates(item, [work({ titleSimilarity: 0.9, authors: [{ names: ['Brandon Sanderson'] }, { names: ['Dan Wells'] }] })])
    expect(top?.reasons).toContain('Some authors match')
  })

  it('keeps at most `limit` candidates', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      work({ workId: `5555555${i}-5555-4555-8555-555555555555`, titleSimilarity: 0.9 - i * 0.01 }),
    )
    expect(rankCandidates(item, many, 5)).toHaveLength(5)
  })
})

describe('shared source ids', () => {
  const item = ExternalItem.parse({ externalId: 'book:11:ebook', format: 'ebook', title: 'Project Hail Mary', identifiers: { others: { readarrBookId: '11' } } })

  it('ranks a book sharing a source id as an exact match, pointing at a same-format copy when there is one', () => {
    const wantedBook = { workId: 'a1111111-1111-4111-8111-111111111111', authors: [], titleSimilarity: 0, editions: [], sharedIds: [{ key: 'readarrBookId', editionId: null, format: null }] }
    expect(rankCandidates(item, [wantedBook])).toEqual([
      { workId: wantedBook.workId, editionId: null, volume: null, score: 1, basis: 'identifier', reasons: ['Same Readarr book'] },
    ])
    const withCopy = { ...wantedBook, sharedIds: [{ key: 'goodreads', editionId: 'b2222222-2222-4222-8222-222222222222', format: 'ebook' as const }] }
    expect(rankCandidates(item, [withCopy])[0]).toMatchObject({ editionId: 'b2222222-2222-4222-8222-222222222222', reasons: ['Same Goodreads id'] })
    const otherFormat = { ...wantedBook, sharedIds: [{ key: 'audiobookshelfId', editionId: 'b2222222-2222-4222-8222-222222222222', format: 'audiobook' as const }] }
    expect(rankCandidates(item, [otherFormat])[0]).toMatchObject({ editionId: null, reasons: ['Same Audiobookshelf book'] })
  })
})

describe('new volumes', () => {
  const ed = (over: Partial<CandidateEdition>): CandidateEdition => ({ editionId: crypto.randomUUID(), format: 'physical', isbn13: null, isbn10: null, asin: null, ownership: 'owned', inPossession: true, formerlyFromSource: false, language: 'he', volume: null, volumeCount: null, ...over })
  const wk = (editions: CandidateEdition[]): CandidateWork => ({ workId: crypto.randomUUID(), authors: [{ names: ['ברנדון סנדרסון'] }], titleSimilarity: 1, editions, sharedIds: [] })
  const it2 = (volume: { number: number; count: number | null } | null, over = {}) => ExternalItem.parse({ externalId: 'row:2', format: 'physical', title: 'דרך המלכים', authors: ['ברנדון סנדרסון'], language: 'he', volume, ...over })

  it('a set without the item volume makes the candidate a new volume, with no copy to link', () => {
    const [c] = rankCandidates(it2({ number: 2, count: null }), [wk([ed({ volume: 1, volumeCount: 2 })])])
    expect(c).toMatchObject({ editionId: null, volume: { number: 2, have: [1], size: 2 } })
    expect(c?.reasons).toContain('New volume: you have vol 1')
  })
  it('the same volume, no set, another format, or no item volume: not a new volume', () => {
    expect(rankCandidates(it2({ number: 1, count: null }), [wk([ed({ volume: 1 })])])[0]?.volume).toBeNull()
    expect(rankCandidates(it2({ number: 2, count: null }), [wk([ed({})])])[0]?.volume).toBeNull()
    expect(rankCandidates(it2({ number: 2, count: null }), [wk([ed({ format: 'ebook', volume: 1 })])])[0]?.volume).toBeNull()
    expect(rankCandidates(it2(null), [wk([ed({ volume: 1 })])])[0]?.volume).toBeNull()
  })
  it('an item without a language joins the set of its format', () => {
    expect(rankCandidates(it2({ number: 2, count: null }, { language: null }), [wk([ed({ volume: 1 })])])[0]?.volume).toMatchObject({ number: 2 })
  })
  it('a formerly owned copy of another volume is never offered for restore', () => {
    const [c] = rankCandidates(it2({ number: 2, count: null }), [wk([ed({ volume: 1, formerlyFromSource: true, inPossession: false })])])
    expect(c?.basis).not.toBe('restore')
    expect(c?.editionId).toBeNull()
  })
})
