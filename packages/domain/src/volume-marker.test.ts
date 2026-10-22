import { describe, expect, it } from 'vitest'
import { romanNumber } from './numerals'
import { parseVolumeMarker, parseVolumeText, volumeFromTitles, volumeNumber } from './volume-marker'

describe('parseVolumeMarker', () => {
  it.each([
    ["ג'ונתן סטריינג' ומר נורל - כרך א'", "ג'ונתן סטריינג' ומר נורל", 1, null],
    ['דרך המלכים כרך ב׳', 'דרך המלכים', 2, null],
    ['דרך המלכים (כרך א)', 'דרך המלכים', 1, null],
    ['מלחמה ושלום חלק שני', 'מלחמה ושלום', 2, null],
    ['מלחמה ושלום, חלק 3 מתוך 4', 'מלחמה ושלום', 3, 4],
    ['הארי פוטר: ספר 1', 'הארי פוטר', 1, null],
    ['The Way of Kings, Part 1', 'The Way of Kings', 1, null],
    ['The Way of Kings: Part 2 of 2', 'The Way of Kings', 2, 2],
    ['Les Misérables Vol. II', 'Les Misérables', 2, null],
    ['Les Misérables (Volume 3)', 'Les Misérables', 3, null],
    ['Collected Stories vol.4', 'Collected Stories', 4, null],
    ['Henry IV, Part 1', 'Henry IV', 1, null],
    ['Saga, Part 2', 'Saga', 2, null],
    ['Saga, Book 2 of 3', 'Saga', 2, 3],
  ])('%s → %s, vol %d of %s', (text, title, volume, count) => {
    expect(parseVolumeMarker(text)).toEqual({ title, volume, count })
  })

  it.each(['1984', 'Catch-22', 'ספר הדקדוק', 'The Jungle Book', 'Book Lovers', 'Part of Your World', 'הספר השני', 'Fahrenheit 451', 'Facebook 2', 'כרך', 'Volume'])(
    '%s is not a volume',
    (text) => {
      expect(parseVolumeMarker(text)).toBeNull()
    },
  )

  it('a marker alone leaves an empty title (callers decide)', () => {
    expect(parseVolumeMarker("כרך א'")).toEqual({ title: '', volume: 1, count: null })
  })

  it('a count below the volume is dropped; numbers past 999 are not volumes', () => {
    expect(parseVolumeMarker('Saga, Part 3 of 2')).toEqual({ title: 'Saga', volume: 3, count: null })
    expect(parseVolumeMarker('Saga, Part 1000')).toBeNull()
  })
})

describe('volumeNumber and romanNumber', () => {
  it('reads digits, Hebrew numerals, ordinals and strict roman numerals', () => {
    expect(volumeNumber('2')).toBe(2)
    expect(volumeNumber("ב'")).toBe(2)
    expect(volumeNumber('שלישי')).toBe(3)
    expect(volumeNumber('IV')).toBe(4)
    expect(volumeNumber('0')).toBeNull()
    expect(romanNumber('XIV')).toBe(14)
    expect(romanNumber('IIII')).toBeNull()
    expect(romanNumber('dim')).toBeNull()
  })
})

describe('"Book N" needs a count (#75)', () => {
  it('a bare "Book N" is not a volume marker', () => {
    expect(parseVolumeMarker('Mistborn, Book 2')).toBeNull()
    expect(volumeFromTitles('The Final Empire', 'Mistborn Book 1')).toEqual({ title: 'The Final Empire', subtitle: 'Mistborn Book 1', volume: null })
  })
  it('an explicit volume field still accepts it', () => {
    expect(parseVolumeText('Book 2')).toEqual({ number: 2, count: null })
  })
})

describe('parseVolumeText', () => {
  it.each([
    ['2', { number: 2, count: null }],
    ["כרך ב'", { number: 2, count: null }],
    ['2 of 3', { number: 2, count: 3 }],
    ['2/3', { number: 2, count: 3 }],
    ["א' מתוך 2", { number: 1, count: 2 }],
    ['Vol. 3', { number: 3, count: null }],
    ['3 of 2', { number: 3, count: null }],
  ])('%s', (text, expected) => {
    expect(parseVolumeText(text)).toEqual(expected)
  })
  it.each([null, '', 'first', 'n/a', '1/2/3'])('%s is no volume', (text) => {
    expect(parseVolumeText(text)).toBeNull()
  })
})

describe('volumeFromTitles', () => {
  it('reads the title first, then the subtitle; a subtitle that is only a marker goes away', () => {
    expect(volumeFromTitles('דרך המלכים כרך א', 'ארכיון אור הסערה')).toEqual({ title: 'דרך המלכים', subtitle: 'ארכיון אור הסערה', volume: { number: 1, count: null } })
    expect(volumeFromTitles('דרך המלכים', "כרך ב' מתוך 2")).toEqual({ title: 'דרך המלכים', subtitle: null, volume: { number: 2, count: 2 } })
    expect(volumeFromTitles('Saga', 'A Novel, Part 2')).toEqual({ title: 'Saga', subtitle: 'A Novel', volume: { number: 2, count: null } })
  })
  it('a title that is only a marker is kept as it is', () => {
    expect(volumeFromTitles("כרך א'", null)).toEqual({ title: "כרך א'", subtitle: null, volume: null })
  })
  it('no marker: unchanged', () => {
    expect(volumeFromTitles('1984', null)).toEqual({ title: '1984', subtitle: null, volume: null })
  })
})
