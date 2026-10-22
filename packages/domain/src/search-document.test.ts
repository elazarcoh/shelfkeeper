import { describe, expect, it } from 'vitest'
import { acronymsOf, buildSearchDocument } from './search-document'

describe('buildSearchDocument', () => {
  it('normalizes and groups fields', () => {
    const doc = buildSearchDocument({
      title: 'The Final Empire',
      subtitle: null,
      series: [{ name: 'Mistborn', position: 1 }, { name: 'The Cosmere', position: null }],
      authors: ['Brandon Sanderson'],
      narrators: ['Michael Kramer'],
      translators: [],
      tags: ['Epic Fantasy'],
      otherTitles: ['Mistborn: The Final Empire'],
      identifiers: ['9780765311788'],
    })
    expect(doc.titleText).toBe('the final empire mistborn the final empire')
    expect(doc.seriesText).toBe('mistborn 1 the cosmere')
    expect(doc.authorText).toBe('brandon sanderson')
    expect(doc.otherText).toBe('michael kramer epic fantasy 9780765311788')
    expect(doc.document).toBe(
      'the final empire mistborn the final empire mistborn 1 the cosmere brandon sanderson michael kramer epic fantasy 9780765311788',
    )
  })
})

describe('buildSearchDocument series ranges (#122)', () => {
  it('indexes both ends of a range', () => {
    const doc = buildSearchDocument({
      title: 'Publisher’s Pack',
      subtitle: null,
      series: [{ name: 'Mage Errant', position: 1, positionEnd: 2 }],
      authors: [],
      narrators: [],
      translators: [],
      tags: [],
      otherTitles: [],
      identifiers: [],
    })
    expect(doc.seriesText).toBe('mage errant 1 2')
    expect(doc.document).toContain('mage errant 1 2')
  })
})

describe('acronymsOf', () => {
  it('takes the first letter of each word, and again without a leading article', () => {
    expect(acronymsOf('The Wandering Inn')).toEqual(['twi', 'wi'])
    expect(acronymsOf('A Song of Ice and Fire')).toEqual(['asoiaf', 'soiaf'])
    expect(acronymsOf('Dungeon Crawler Carl')).toEqual(['dcc'])
  })

  it('reads punctuation, case and digits the way search normalizes them', () => {
    expect(acronymsOf('George R. R. Martin')).toEqual(['grrm'])
    expect(acronymsOf('Harry Potter, Book 2')).toEqual(['hpb2'])
  })

  it('reads a "Last, First" name in its natural order', () => {
    expect(acronymsOf('Martin, George R. R.', { name: true })).toEqual(['grrm'])
    expect(acronymsOf('Martin, George R. R.')).toEqual(['mgrr'])
  })

  it('works for Hebrew, niqqud ignored', () => {
    expect(acronymsOf('הָארי פוטר')).toEqual(['הפ'])
  })

  it('gives nothing for one word, and keeps "The X" whole', () => {
    expect(acronymsOf('Mistborn')).toEqual([])
    expect(acronymsOf('')).toEqual([])
    expect(acronymsOf('The Hobbit')).toEqual(['th'])
  })
})

describe('buildSearchDocument acronyms', () => {
  it('collects the title, edition title, series and author acronyms once each', () => {
    const doc = buildSearchDocument({
      title: 'Dungeon Crawler Carl',
      subtitle: 'A LitRPG Adventure',
      series: [{ name: 'Dungeon Crawler Carl', position: 1 }, { name: 'The Wandering Inn', position: null }],
      authors: ['Matt Dinniman', 'Plato'],
      narrators: ['Jeff Hays'],
      translators: [],
      tags: ['Litrpg Comedy'],
      otherTitles: ['Dungeon Crawler Carl'],
      identifiers: [],
    })
    expect(doc.acronyms).toBe('dcc twi wi md')
  })

  it('is empty, not missing, when nothing has two words', () => {
    const doc = buildSearchDocument({
      title: 'Mistborn',
      subtitle: null,
      series: [],
      authors: ['Plato'],
      narrators: [],
      translators: [],
      tags: [],
      otherTitles: [],
      identifiers: [],
    })
    expect(doc.acronyms).toBe('')
  })
})
