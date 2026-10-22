export const cleanIsbn = (raw: string): string => raw.replace(/[\s-]/g, '').toUpperCase()

export function isValidIsbn13(isbn: string): boolean {
  if (!/^\d{13}$/.test(isbn)) return false
  let sum = 0
  for (let i = 0; i < 13; i++) sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3)
  return sum % 10 === 0
}

export function isValidIsbn10(isbn: string): boolean {
  if (!/^\d{9}[\dX]$/.test(isbn)) return false
  let sum = 0
  for (let i = 0; i < 10; i++) {
    const ch = isbn[i]
    sum += (ch === 'X' ? 10 : Number(ch)) * (10 - i)
  }
  return sum % 11 === 0
}

/** Both forms of a valid ISBN, for a look-up that may have either on file; null when it isn't one. */
export function isbnForms(raw: string): { isbn13: string; isbn10: string | null } | null {
  const isbn = cleanIsbn(raw)
  if (isValidIsbn10(isbn)) {
    const body = `978${isbn.slice(0, 9)}`
    let sum = 0
    for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3)
    return { isbn13: `${body}${(10 - (sum % 10)) % 10}`, isbn10: isbn }
  }
  // a shop or price barcode passes the same checksum: an ISBN starts 978 or 979
  if (!isValidIsbn13(isbn) || !/^97[89]/.test(isbn)) return null
  // only a 978 ISBN has a 10-digit form
  if (!isbn.startsWith('978')) return { isbn13: isbn, isbn10: null }
  const body = isbn.slice(3, 12)
  let sum = 0
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * (10 - i)
  const check = (11 - (sum % 11)) % 11
  return { isbn13: isbn, isbn10: `${body}${check === 10 ? 'X' : String(check)}` }
}

/** A book's barcode (EAN-13 starting 978 or 979) as its ISBN-13; any other barcode (a price code) is null. */
export function isbnFromBarcode(text: string): string | null {
  const digits = text.trim()
  return /^\d{13}$/.test(digits) ? (isbnForms(digits)?.isbn13 ?? null) : null
}

/** Israel's ISBN group (978-965): such a book is looked up at the National Library first. */
export const isIsraeliIsbn = (isbn13: string): boolean => isbn13.startsWith('978965')
