import { describe, expect, it } from 'vitest'
import { normalizeText } from '@mylib/domain'
import { applyPick, currentSegment, findByName, indexOptions, isNew, matchOptions, newItems, newNote, otherItems, splitItems } from './suggest-logic'

describe('currentSegment', () => {
  it('is the whole value in single mode', () => {
    expect(currentSegment('  Mistborn ', 3, 'single')).toEqual({ start: 0, end: 11, text: 'Mistborn' })
  })

  it('is the line holding the caret in lines mode', () => {
    const value = 'Brandon Sanderson\nMich\nAnn'
    expect(currentSegment(value, 22, 'lines')).toEqual({ start: 18, end: 22, text: 'Mich' })
    expect(currentSegment(value, 0, 'lines')).toEqual({ start: 0, end: 17, text: 'Brandon Sanderson' })
    expect(currentSegment(value, value.length, 'lines')).toEqual({ start: 23, end: 26, text: 'Ann' })
  })

  it('treats a caret right after a separator as the start of the next item, and an empty line as empty', () => {
    expect(currentSegment('a\n\nb', 2, 'lines')).toEqual({ start: 2, end: 2, text: '' })
    expect(currentSegment('\nb', 0, 'lines')).toEqual({ start: 0, end: 0, text: '' })
  })

  it('is the text between the commas around the caret in comma mode', () => {
    expect(currentSegment('Fantasy, Epi, Cosmere', 12, 'comma')).toEqual({ start: 8, end: 12, text: 'Epi' })
  })

  it('clamps a caret beyond the value', () => {
    expect(currentSegment('ab', 99, 'single').text).toBe('ab')
  })
})

describe('splitItems and otherItems', () => {
  it('splits by mode and drops blanks', () => {
    expect(splitItems('a\n\n b \n', 'lines')).toEqual(['a', 'b'])
    expect(splitItems('a, ,b,', 'comma')).toEqual(['a', 'b'])
    expect(splitItems('  x ', 'single')).toEqual(['x'])
    expect(splitItems('   ', 'single')).toEqual([])
  })

  it('lists the field\'s items other than the one under the caret', () => {
    expect(otherItems('Fantasy, Epi, Cosmere', 12, 'comma')).toEqual(['Fantasy', 'Cosmere'])
    expect(otherItems('Mistborn', 3, 'single')).toEqual([])
  })
})

describe('matchOptions', () => {
  const options = ['The Stormlight Archive', 'Mistborn', 'Mistborn: Wax and Wayne', 'Wax', 'Dune']

  it('ranks whole-name prefix, then word prefix, then substring, keeping list order within a rank', () => {
    expect(matchOptions('wa', options)).toEqual(['Wax', 'Mistborn: Wax and Wayne'])
    expect(matchOptions('st', ['Mistborn', 'Stormlight', 'The Stormlight Archive'])).toEqual(['Stormlight', 'The Stormlight Archive', 'Mistborn'])
  })

  it('ignores case, accents, niqqud and punctuation', () => {
    expect(matchOptions('BRONTE', ['Charlotte Brontë'])).toEqual(['Charlotte Brontë'])
    expect(matchOptions('הנסיך', ['הַנָּסִיךְ הַקָּטָן'])).toEqual(['הַנָּסִיךְ הַקָּטָן'])
    expect(matchOptions('mistborn wax', options)).toEqual(['Mistborn: Wax and Wayne'])
  })

  it('suggests nothing for an empty query, leaves out an exact match and items already in the field', () => {
    expect(matchOptions('  ', options)).toEqual([])
    expect(matchOptions('mistborn', options)).toEqual(['Mistborn: Wax and Wayne'])
    expect(matchOptions('mist', options, ['MISTBORN'])).toEqual(['Mistborn: Wax and Wayne'])
  })

  it('returns at most the limit', () => {
    expect(matchOptions('a', ['a1', 'a2', 'a3'], [], 2)).toEqual(['a1', 'a2'])
  })
})

describe('applyPick', () => {
  it('replaces the whole value in single mode', () => {
    expect(applyPick(' mist', currentSegment(' mist', 5, 'single'), 'Mistborn', 'single')).toEqual({ value: 'Mistborn', caret: 8 })
  })

  it('replaces only the caret line in lines mode, keeping the other lines', () => {
    const value = 'Brandon Sanderson\nmich\nAnn Leckie'
    const r = applyPick(value, currentSegment(value, 22, 'lines'), 'Michael Kramer', 'lines')
    expect(r).toEqual({ value: 'Brandon Sanderson\nMichael Kramer\nAnn Leckie', caret: 32 })
  })

  it('in comma mode, keeps one space after the comma and adds ", " after the last item', () => {
    const value = 'Fantasy,  epi'
    expect(applyPick(value, currentSegment(value, value.length, 'comma'), 'Epic', 'comma')).toEqual({ value: 'Fantasy, Epic, ', caret: 15 })
    const middle = 'Fantasy, epi, Cosmere'
    expect(applyPick(middle, currentSegment(middle, 12, 'comma'), 'Epic', 'comma')).toEqual({ value: 'Fantasy, Epic, Cosmere', caret: 13 })
    expect(applyPick('fan', currentSegment('fan', 3, 'comma'), 'Fantasy', 'comma')).toEqual({ value: 'Fantasy, ', caret: 9 })
  })
})

describe('isNew, newItems, newNote', () => {
  const options = ['Mistborn', 'Brandon Sanderson']

  it('is new only when nothing normalizes the same', () => {
    expect(isNew('mistborn', options)).toBe(false)
    expect(isNew('Mistborm', options)).toBe(true)
    expect(isNew('  ', options)).toBe(false)
    expect(isNew('!!', options)).toBe(false)
  })

  it('lists each new item once', () => {
    expect(newItems('Brandon Sanderson\nJon Smith\njon smith\nAnn', 'lines', options)).toEqual(['Jon Smith', 'Ann'])
  })

  it('words the note by mode', () => {
    expect(newNote('New series', ['Mistborm'], 'single')).toBe('New series — will be created')
    expect(newNote('New author', ['Jon Smith', 'Ann'], 'lines')).toBe('New author: "Jon Smith", "Ann" — will be created')
  })
})

describe('findByName', () => {
  it('finds by normalized name', () => {
    expect(findByName([{ id: '1', name: 'Mistborn' }], ' MISTBORN ')).toEqual({ id: '1', name: 'Mistborn' })
    expect(findByName([{ id: '1', name: 'Mistborn' }], 'Mist')).toBeUndefined()
    expect(findByName([{ id: '1', name: 'Mistborn' }], '')).toBeUndefined()
  })
})

describe('indexOptions', () => {
  const options = ['Brandon Sanderson', 'Ann Leckie', 'Sanderson, B.', 'ann  leckie']

  it('holds the names, their normalized forms and the set of normalized forms', () => {
    const index = indexOptions(options)
    expect(index.names).toEqual(options)
    expect(index.normalized).toEqual(options.map(normalizeText))
    expect(index.set).toEqual(new Set(options.map(normalizeText)))
  })

  it('gives matchOptions, isNew and newItems the same results as the plain list', () => {
    const index = indexOptions(options)
    for (const q of ['san', 'ann', 'leck', 'zzz', '', 'B']) {
      expect(matchOptions(q, index, ['Ann Leckie'], 3)).toEqual(matchOptions(q, options, ['Ann Leckie'], 3))
    }
    for (const item of ['Ann Leckie', 'ANN LECKIE', 'Nobody', '  ']) {
      expect(isNew(item, index)).toBe(isNew(item, options))
    }
    const value = 'Ann Leckie\nNobody\nnobody\nBrandon Sanderson\nOther'
    expect(newItems(value, 'lines', index)).toEqual(newItems(value, 'lines', options))
    expect(newItems(value, 'lines', index)).toEqual(['Nobody', 'Other'])
  })
})
