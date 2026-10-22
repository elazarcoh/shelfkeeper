const ENGLISH = new Set(['en', 'eng', 'english'])
const HEBREW = new Set(['he', 'heb', 'iw', 'hebrew', 'עברית'])

/** A language as one code: `en` and `he` for the spellings sources use, anything else as written (trimmed); blank is null. */
export function normalizeLanguage(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return null
  const lower = trimmed.toLowerCase()
  const base = lower.split(/[-_]/)[0] ?? lower
  if (ENGLISH.has(lower) || base === 'en') return 'en'
  if (HEBREW.has(lower) || base === 'he') return 'he'
  return trimmed
}

/** The language a title is written in, by script: any Hebrew letter is `he`, else any Latin letter is `en`. */
export function scriptLanguage(text: string): 'he' | 'en' | null {
  if (/[֐-׿]/.test(text)) return 'he'
  if (/[A-Za-zÀ-ɏ]/.test(text)) return 'en'
  return null
}
