import { describe, expect, it } from 'vitest'
import { CsvImportInput, CsvMapping, guessCsvMapping, mapCsvRow, parseCsv, parseCsvDate, parseCsvRating, parseCsvWithLines, splitSeriesFromTitle } from './csv'

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded newlines, CRLF and blank lines', () => {
    expect(parseCsv('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['1', '2', '3'],
    ])
  })
  it('drops a UTF-8 BOM and takes the delimiter from the header line', () => {
    expect(parseCsv('﻿כותרת;מחבר\nהארי פוטר;רולינג')).toEqual([
      ['כותרת', 'מחבר'],
      ['הארי פוטר', 'רולינג'],
    ])
    expect(parseCsv('Title\tAuthor\nDune\tHerbert')).toEqual([
      ['Title', 'Author'],
      ['Dune', 'Herbert'],
    ])
  })
  it('drops a BOM before guessing the header (review finding 2)', () => {
    const rows = parseCsv('﻿Title,Author\nDune,Herbert')
    expect(rows).toEqual([
      ['Title', 'Author'],
      ['Dune', 'Herbert'],
    ])
    expect(guessCsvMapping(rows[0] ?? [])?.columns.title).toBe(0)
  })
  it('detects the delimiter outside quoted sections (review finding 3)', () => {
    expect(parseCsv('"Title, subtitle";Author;Rating\n"A, B";C;5')).toEqual([
      ['Title, subtitle', 'Author', 'Rating'],
      ['A, B', 'C', '5'],
    ])
  })
  it('reports the file line each record starts on, past blank lines and multi-line cells', () => {
    const text = '\uFEFFTitle,Notes\r\nDune,short\r\n\r\nEmma,"two\r\nlines"\r\nUlysses,\n\n\nIvanhoe,x'
    expect(parseCsvWithLines(text)).toEqual([
      { cells: ['Title', 'Notes'], line: 1 },
      { cells: ['Dune', 'short'], line: 2 },
      { cells: ['Emma', 'two\r\nlines'], line: 4 },
      { cells: ['Ulysses', ''], line: 6 },
      { cells: ['Ivanhoe', 'x'], line: 9 },
    ])
    expect(parseCsv(text)).toEqual(parseCsvWithLines(text).map((r) => r.cells))
  })
  it('never throws, even on malformed or degenerate input (review finding 4, R14)', () => {
    expect(() => parseCsv('')).not.toThrow()
    expect(parseCsv('')).toEqual([])
    expect(() => parseCsv('\n\n')).not.toThrow()
    expect(parseCsv('\n\n')).toEqual([])
    expect(() => parseCsv('\r')).not.toThrow()
    expect(parseCsv('\r')).toEqual([])
    expect(() => parseCsv('"')).not.toThrow()
    expect(parseCsv('"')).toEqual([])
    expect(() => parseCsv('a,"bc')).not.toThrow() // unterminated quoted field at EOF
    expect(parseCsv('a,"bc')).toEqual([['a', 'bc']])
    expect(() => parseCsv('ab"cd,ef')).not.toThrow() // quote in the middle of an unquoted field
    expect(parseCsv('ab"cd,ef')).toEqual([['ab"cd', 'ef']])
  })
})

describe('CsvImportInput', () => {
  const base = { fileName: 'f.csv', header: ['Title'], rows: [['A'], ['B']], mapping: { columns: { title: 0 } }, ownership: 'owned', importId: '11111111-1111-4111-8111-111111111111' }
  it('takes optional file lines, one per row, strictly increasing', () => {
    expect(CsvImportInput.safeParse(base).success).toBe(true)
    expect(CsvImportInput.safeParse({ ...base, lines: [2, 5] }).success).toBe(true)
    expect(CsvImportInput.safeParse({ ...base, lines: [2] }).success).toBe(false)
    expect(CsvImportInput.safeParse({ ...base, lines: [5, 5] }).success).toBe(false)
    expect(CsvImportInput.safeParse({ ...base, lines: [5, 3] }).success).toBe(false)
  })
  it('refuses line numbers no real file has (they become an int in SQL)', () => {
    expect(CsvImportInput.safeParse({ ...base, lines: [2, 3_000_000_000] }).success).toBe(false)
  })
})

describe('parseCsvDate', () => {
  it('reads ISO and slashed dates at day, month and year precision', () => {
    expect(parseCsvDate('2023/05/14', 'ymd')).toEqual({ date: '2023-05-14', precision: 'day' })
    expect(parseCsvDate('2023-05-14 10:30', 'ymd')).toEqual({ date: '2023-05-14', precision: 'day' })
    expect(parseCsvDate('2023-05', 'ymd')).toEqual({ date: '2023-05-01', precision: 'month' })
    expect(parseCsvDate('2023', 'ymd')).toEqual({ date: '2023-01-01', precision: 'year' })
  })
  it('uses the chosen order for day/month/year dates, and refuses ambiguity and impossible dates', () => {
    expect(parseCsvDate('14/05/2023', 'dmy')).toEqual({ date: '2023-05-14', precision: 'day' })
    expect(parseCsvDate('05/14/2023', 'mdy')).toEqual({ date: '2023-05-14', precision: 'day' })
    expect(parseCsvDate('14/05/2023', 'ymd')).toEqual({ date: '2023-05-14', precision: 'day' })
    expect(parseCsvDate('04/05/2023', 'ymd')).toBeNull()
    expect(parseCsvDate('2023-02-30', 'ymd')).toBeNull()
    expect(parseCsvDate('someday', 'ymd')).toBeNull()
  })
})

describe('parseCsvRating', () => {
  it('maps to half steps on a five-star scale; 0 and blank mean no rating', () => {
    expect(parseCsvRating('4', 5)).toBe(4)
    expect(parseCsvRating('4,5', 5)).toBe(4.5)
    expect(parseCsvRating('4.3', 5)).toBe(4.5)
    expect(parseCsvRating('9', 10)).toBe(4.5)
    expect(parseCsvRating('0', 5)).toBeNull()
    expect(parseCsvRating('', 5)).toBeNull()
    expect(parseCsvRating('great', 5)).toBeNull()
    expect(parseCsvRating('7', 5)).toBe(5)
  })
})

describe('splitSeriesFromTitle', () => {
  it('takes a Goodreads-style "(Series, #n)" suffix off the title', () => {
    expect(splitSeriesFromTitle('The Final Empire (Mistborn, #1)')).toEqual({ title: 'The Final Empire', series: [{ name: 'Mistborn', position: 1, positionEnd: null }] })
    expect(splitSeriesFromTitle('Dune')).toEqual({ title: 'Dune', series: [] })
  })
  it('reads a Goodreads range in the title (#122)', () => {
    expect(splitSeriesFromTitle('Publisher’s Pack (Mage Errant, #1-2)')).toEqual({ title: 'Publisher’s Pack', series: [{ name: 'Mage Errant', position: 1, positionEnd: 2 }] })
  })
})

const goodreadsHeader = ['Book Id', 'Title', 'Author', 'Additional Authors', 'ISBN', 'ISBN13', 'My Rating', 'Publisher', 'Number of Pages', 'Date Read', 'Bookshelves', 'Exclusive Shelf']

describe('guessCsvMapping and mapCsvRow', () => {
  it('reads a Goodreads export', () => {
    const mapping = guessCsvMapping(goodreadsHeader)
    expect(mapping?.columns).toMatchObject({ title: 1, authors: 2, isbn: 5, rating: 6, publisher: 7, pageCount: 8, finishedOn: 9, tags: 10 })
    const row = ['1', 'The Final Empire (Mistborn, #1)', 'Brandon Sanderson', '', '="076531178X"', '="9780765311788"', '0', 'Tor', '541', '2023/05/14', 'fantasy, favorites', 'read']
    const result = mapCsvRow(row, 2, CsvMapping.parse(mapping))
    expect(result).toMatchObject({
      ok: true,
      value: {
        item: {
          externalId: 'row:2',
          format: 'physical',
          title: 'The Final Empire',
          authors: ['Brandon Sanderson'],
          series: [{ name: 'Mistborn', position: 1 }],
          identifiers: { isbn13: '9780765311788' },
          publisher: 'Tor',
          pageCount: 541,
          tags: ['fantasy', 'favorites'],
        },
        read: { finishedOn: '2023-05-14', finishedPrecision: 'day' },
        rating: null,
      },
    })
  })

  it('guesses Hebrew headers and keeps Hebrew values', () => {
    const mapping = CsvMapping.parse(guessCsvMapping(['שם הספר', 'מחבר', 'דירוג', 'תאריך קריאה']))
    expect(mapCsvRow(['הארי פוטר ואבן החכמים', 'ג׳יי קיי רולינג', '5', '2020'], 2, mapping)).toMatchObject({
      ok: true,
      value: { item: { title: 'הארי פוטר ואבן החכמים', authors: ['ג׳יי קיי רולינג'] }, read: { finishedOn: '2020-01-01', finishedPrecision: 'year' }, rating: 5 },
    })
  })

  it('splits several authors and reports a row without a title', () => {
    const mapping = CsvMapping.parse({ columns: { title: 0, authors: 1 } })
    expect(mapCsvRow(['Good Omens', 'Terry Pratchett; Neil Gaiman'], 2, mapping)).toMatchObject({ ok: true, value: { item: { authors: ['Terry Pratchett', 'Neil Gaiman'] } } })
    expect(mapCsvRow(['', 'Someone'], 7, mapping)).toEqual({ ok: false, error: 'Row 7: no title' })
    expect(guessCsvMapping(['foo', 'bar'])).toBeNull()
  })

  it('guesses the shelf column and reads Goodreads shelves case-insensitively', () => {
    expect(guessCsvMapping(goodreadsHeader)?.columns.shelf).toBe(11)
    expect(guessCsvMapping(['Title', 'Read Status'])?.columns.shelf).toBe(1)
    expect(guessCsvMapping(['Title', 'STATUS'])?.columns.shelf).toBe(1)
    expect(guessCsvMapping(['Title', 'Shelf'])?.columns.shelf).toBe(1)
    expect(guessCsvMapping(['Title', 'Author'])?.columns.shelf).toBeNull()
    const mapping = CsvMapping.parse({ columns: { title: 0, shelf: 1 } })
    const shelfOf = (value: string) => {
      const r = mapCsvRow(['Dune', value], 2, mapping)
      return r.ok ? r.value.shelf : 'invalid'
    }
    expect(['read', 'READ', 'currently-reading', 'Reading', 'to-read', 'Want to read', 'wishlist', 'favorites', ''].map(shelfOf)).toEqual([
      'read',
      'read',
      'reading',
      'reading',
      'want',
      'want',
      'want',
      null,
      null,
    ])
    expect(mapCsvRow(['Dune'], 2, CsvMapping.parse({ columns: { title: 0 } }))).toMatchObject({ ok: true, value: { shelf: null } })
  })

  it('drops the Goodreads status shelves from the tags', () => {
    const mapping = CsvMapping.parse({ columns: { title: 0, tags: 1 } })
    expect(mapCsvRow(['Dune', 'to-read, Sci-Fi, Currently-Reading, READ, favorites'], 2, mapping)).toMatchObject({ ok: true, value: { item: { tags: ['Sci-Fi', 'favorites'] } } })
  })

  it('ignores a matched header beyond the column limit instead of throwing (review finding 1, R14)', () => {
    const header = Array.from({ length: 65 }, (_, i) => (i === 0 ? 'Title' : i === 64 ? 'Rating' : `Col${i}`))
    expect(() => guessCsvMapping(header)).not.toThrow()
    const mapping = guessCsvMapping(header)
    expect(mapping?.columns.title).toBe(0)
    expect(mapping?.columns.rating).toBeNull()
  })
})

describe('volumes in CSV rows', () => {
  const mapping = (volume: number | null = null) => CsvMapping.parse({ columns: { title: 0, authors: 1, volume } })
  it('a marker in the title becomes the volume, after a Goodreads series is split off', () => {
    const r = mapCsvRow(['The Way of Kings, Part 1 (The Stormlight Archive, #1)', 'Brandon Sanderson'], 2, mapping())
    expect(r.ok && r.value.item).toMatchObject({ title: 'The Way of Kings', volume: { number: 1, count: null }, series: [{ name: 'The Stormlight Archive', position: 1 }] })
  })
  it('a volume column wins over the title', () => {
    const r = mapCsvRow(["דרך המלכים כרך א'", 'סנדרסון', '2 of 2'], 2, mapping(2))
    expect(r.ok && r.value.item).toMatchObject({ title: 'דרך המלכים', volume: { number: 2, count: 2 } })
  })
  it('remembers the title as imported, so "not a volume" can bring it back', () => {
    const r = mapCsvRow(['Henry IV, Part 1', 'Shakespeare'], 2, mapping())
    expect(r.ok && r.value.item).toMatchObject({ title: 'Henry IV', volume: { number: 1, count: null }, importedTitle: { title: 'Henry IV, Part 1', subtitle: null } })
    const plain = mapCsvRow(['1984', 'Orwell'], 2, mapping())
    expect(plain.ok && plain.value.item.importedTitle).toBeNull()
  })
  it('the volume column is guessed from its header', () => {
    expect(guessCsvMapping(['Title', 'Volume'])?.columns.volume).toBe(1)
    expect(guessCsvMapping(['Title', 'כרך'])?.columns.volume).toBe(1)
  })
  it('no marker, no column: no volume', () => {
    const r = mapCsvRow(['1984', 'Orwell'], 2, mapping())
    expect(r.ok && r.value.item.volume).toBeNull()
  })
})

describe('mapCsvRow series ranges (#122)', () => {
  const mapping = CsvMapping.parse({ columns: { title: 0, series: 1, seriesPosition: 2 } })
  const seriesOf = (position: string) => {
    const r = mapCsvRow(['Publisher’s Pack', 'Mage Errant', position], 2, mapping)
    return r.ok ? r.value.item.series : 'invalid'
  }
  it('reads a range cell, and an unreadable cell as no position', () => {
    expect(seriesOf('1-2')).toEqual([{ name: 'Mage Errant', position: 1, positionEnd: 2 }])
    expect(seriesOf('3')).toEqual([{ name: 'Mage Errant', position: 3, positionEnd: null }])
    expect(seriesOf('abc')).toEqual([{ name: 'Mage Errant', position: null, positionEnd: null }])
  })
})
