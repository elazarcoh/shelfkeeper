import { describe, expect, it } from 'vitest'
import { HardcoverToken, hardcoverEditionIdFromUrl, hardcoverSlugFromUrl, sameTitleAndAuthor, tagsFromCached, titleAuthorIndex } from './hardcover'

describe('HardcoverToken', () => {
  it('trims and drops a pasted Bearer prefix', () => {
    expect(HardcoverToken.parse('  Bearer abcdefghijklmnopqrstuvwxyz ')).toBe('abcdefghijklmnopqrstuvwxyz')
    expect(HardcoverToken.safeParse('short').success).toBe(false)
  })
})

describe('hardcoverSlugFromUrl', () => {
  it('reads a book link and nothing else', () => {
    expect(hardcoverSlugFromUrl('https://hardcover.app/books/the-final-empire')).toBe('the-final-empire')
    expect(hardcoverSlugFromUrl('https://hardcover.app/books/the-final-empire/editions/123?x=1')).toBe('the-final-empire')
    expect(hardcoverSlugFromUrl('hardcover.app/books/dune')).toBe('dune')
    expect(hardcoverSlugFromUrl('https://example.com/books/dune')).toBeNull()
    expect(hardcoverSlugFromUrl('https://hardcover.app/authors/frank-herbert')).toBeNull()
  })
})

describe('sameTitleAndAuthor', () => {
  it('needs the normalized title and one author to agree', () => {
    expect(sameTitleAndAuthor({ title: 'The Final Empire', authors: ['Brandon Sanderson'] }, { title: 'the final  empire', authors: ['Brandon Sanderson'] })).toBe(true)
    expect(sameTitleAndAuthor({ title: 'The Final Empire', authors: ['Brandon Sanderson'] }, { title: 'The Final Empire (Mistborn #1)', authors: ['Brandon Sanderson'] })).toBe(false)
    expect(sameTitleAndAuthor({ title: 'Dune', authors: ['Frank Herbert'] }, { title: 'Dune', authors: ['Brian Herbert'] })).toBe(false)
  })

  it('accepts a "<series>: <title>" name when the prefix is one of the series names', () => {
    const ours = { title: 'The Final Empire', authors: ['Brandon Sanderson'] }
    const theirs = { title: 'Mistborn: The Final Empire', authors: ['Brandon Sanderson'] }
    expect(sameTitleAndAuthor(ours, { ...theirs, series: ['Mistborn'] })).toBe(true)
    expect(sameTitleAndAuthor({ ...ours, series: ['Mistborn'] }, { ...theirs, series: [] })).toBe(true)
    expect(sameTitleAndAuthor({ ...ours, series: ['Other'] }, { ...theirs, series: ['Cosmere'] })).toBe(false)
    expect(sameTitleAndAuthor(ours, theirs)).toBe(false)
  })

  it('compares only the prefix to the series, and keeps the author rule', () => {
    expect(sameTitleAndAuthor({ title: 'Dune', authors: ['Frank Herbert'], series: ['Dune'] }, { title: 'Chapterhouse: Dune', authors: ['Frank Herbert'], series: ['Dune'] })).toBe(false)
    expect(sameTitleAndAuthor({ title: 'The Final Empire', authors: ['Brandon Sanderson'] }, { title: 'Mistborn: The Final Empire', authors: ['Someone Else'], series: ['Mistborn'] })).toBe(false)
  })
})

describe('titleAuthorIndex', () => {
  const ours = [
    { id: 'a', titles: ['The Final Empire', 'Mistborn 1'], authors: ['Brandon Sanderson'], series: [] as string[] },
    { id: 'b', titles: ['the final empire'], authors: ['Brandon Sanderson'], series: ['Mistborn'] },
    { id: 'c', titles: ['Dune'], authors: ['Frank Herbert'], series: ['Dune'] },
  ]
  const find = titleAuthorIndex(ours)

  it('finds the same works as sameTitleAndAuthor, in order', () => {
    const theirs = [
      { title: 'The Final Empire', authors: ['Brandon Sanderson'] },
      { title: 'Mistborn: The Final Empire', authors: ['Brandon Sanderson'], series: ['Mistborn'] },
      { title: 'Mistborn: The Final Empire', authors: ['Brandon Sanderson'], series: [] as string[] },
      { title: 'Mistborn: The Final Empire', authors: ['Someone Else'], series: ['Mistborn'] },
      { title: 'Chapterhouse: Dune', authors: ['Frank Herbert'], series: ['Dune'] },
      { title: 'Dune', authors: ['Brian Herbert'] },
      { title: 'Dune', authors: ['frank  herbert'] },
    ]
    for (const t of theirs) {
      const expected = ours.filter((o) => o.titles.some((title) => sameTitleAndAuthor({ title, authors: o.authors, series: o.series }, t)))
      expect(find(t)).toEqual(expected)
    }
    expect(find({ title: 'Mistborn: The Final Empire', authors: ['Brandon Sanderson'], series: ['Mistborn'] }).map((o) => o.id)).toEqual(['a', 'b'])
    expect(find({ title: 'Mistborn: The Final Empire', authors: ['Brandon Sanderson'], series: [] }).map((o) => o.id)).toEqual(['b'])
  })
})

describe('tagsFromCached', () => {
  it('takes genre and mood tag names, most used first, and tolerates junk', () => {
    const cached = { Genre: [{ tag: 'Fantasy', count: 9 }, { tag: 'Epic', count: 12 }], Mood: [{ tag: 'adventurous', count: 3 }], Tag: [{ tag: 'x' }] }
    expect(tagsFromCached(cached)).toEqual({ genre: ['Epic', 'Fantasy'], mood: ['adventurous'] })
    expect(tagsFromCached(null)).toEqual({ genre: [], mood: [] })
    expect(tagsFromCached({ Genre: 'nope' })).toEqual({ genre: [], mood: [] })
  })
})

describe('hardcoverEditionIdFromUrl', () => {
  it('reads the edition id of an edition page', () => {
    expect(hardcoverEditionIdFromUrl('https://hardcover.app/books/worm-parahumans/editions/30395760')).toBe(30395760)
    expect(hardcoverEditionIdFromUrl('https://hardcover.app/books/worm-parahumans')).toBeNull()
  })
})
