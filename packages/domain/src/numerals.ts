const HEBREW_NUMERALS: Record<string, number> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40, נ: 50, ן: 50, ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90, ק: 100,
}

const HEBREW_ORDINALS: Record<string, number> = {
  ראשון: 1, ראשונה: 1, שני: 2, שנייה: 2, שניה: 2, שלישי: 3, שלישית: 3, רביעי: 4, רביעית: 4, חמישי: 5, חמישית: 5,
  שישי: 6, שישית: 6, שביעי: 7, שביעית: 7, שמיני: 8, שמינית: 8, תשיעי: 9, תשיעית: 9, עשירי: 10, עשירית: 10,
}

/** "3", "#4", "ב", "כרך א'", "יא", "חלק שני" → a number; other words and anything else → null. */
export function seriesPosition(text: string | null): number | null {
  if (text === null) return null
  const hadGeresh = /['"׳״]/.test(text)
  const core = text
    .replace(/^\s*(?:כרך|חלק|ספר|מס['׳]?|#)\s*/u, '')
    .replace(/['"׳״]/g, '')
    .trim()
  if (/^\d{1,5}$/.test(core)) return Number(core)
  const ordinal = HEBREW_ORDINALS[core]
  if (ordinal !== undefined) return ordinal
  const letters = Array.from(core)
  if (letters.length === 0 || letters.some((c) => HEBREW_NUMERALS[c] === undefined)) return null
  // a Hebrew word read as letters would be a nonsense number: only short numerals, or ones marked with a geresh
  if (letters.length > 2 && !hadGeresh) return null
  return letters.reduce((sum, c) => sum + (HEBREW_NUMERALS[c] ?? 0), 0)
}

const ROMAN = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i
const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }

/** A strict roman numeral ("XIV" → 14); anything else ("IIII", "dim", "") → null. */
export function romanNumber(token: string): number | null {
  if (token === '' || !ROMAN.test(token)) return null
  const digits = Array.from(token.toUpperCase(), (c) => ROMAN_VALUES[c] ?? 0)
  return digits.reduce((sum, v, i) => sum + (v < (digits[i + 1] ?? 0) ? -v : v), 0)
}
