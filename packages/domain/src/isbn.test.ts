import { describe, expect, it } from 'vitest'
import { cleanIsbn, isbnForms, isbnFromBarcode, isIsraeliIsbn, isValidIsbn10, isValidIsbn13 } from './isbn'

describe('isbn', () => {
  it('cleans hyphens, spaces and lowercase x', () => {
    expect(cleanIsbn(' 978-0-7653-1178-8 ')).toBe('9780765311788')
    expect(cleanIsbn('0-7653-1178-x')).toBe('076531178X')
  })
  it('validates ISBN-13 checksums', () => {
    expect(isValidIsbn13('9780765311788')).toBe(true)
    expect(isValidIsbn13('9780765311789')).toBe(false)
    expect(isValidIsbn13('978076531178')).toBe(false)
  })
  it('validates ISBN-10 checksums including X', () => {
    expect(isValidIsbn10('076531178X')).toBe(true)
    expect(isValidIsbn10('0765311781')).toBe(false)
  })
  it('gives both forms of an ISBN, either way round', () => {
    expect(isbnForms('978-0-7653-1178-8')).toEqual({ isbn13: '9780765311788', isbn10: '076531178X' })
    expect(isbnForms('0-7653-1178-x')).toEqual({ isbn13: '9780765311788', isbn10: '076531178X' })
    expect(isbnForms('9789655310320')).toEqual({ isbn13: '9789655310320', isbn10: '9655310329' })
    // a 979 ISBN has no 10-digit form
    expect(isbnForms('9791032305690')).toEqual({ isbn13: '9791032305690', isbn10: null })
    expect(isbnForms('9789655310321')).toBeNull()
    expect(isbnForms('7290000068756')).toBeNull()
    expect(isbnForms('not an isbn')).toBeNull()
  })
  it('reads a barcode as an ISBN only when it is one', () => {
    expect(isbnFromBarcode('9789655310320')).toBe('9789655310320')
    expect(isbnFromBarcode(' 9789655310320\n')).toBe('9789655310320')
    // a price or shop barcode (EAN-13 from another range), a bad check digit, an ISBN-10 printed as text
    expect(isbnFromBarcode('7290000068756')).toBeNull()
    expect(isbnFromBarcode('9789655310321')).toBeNull()
    expect(isbnFromBarcode('076531178X')).toBeNull()
  })
  it('knows an Israeli ISBN', () => {
    expect(isIsraeliIsbn('9789655310320')).toBe(true)
    expect(isIsraeliIsbn('9780765311788')).toBe(false)
  })
})
