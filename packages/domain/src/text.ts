const APOSTROPHES = /['’`]/g
const COMBINING_MARKS = /\p{M}+/gu
const NON_WORD = /[^\p{L}\p{N}]+/gu
const LEADING_ARTICLE = /^(the|a|an) /

/**
 * Canonical form used for search documents, search queries and name de-duplication:
 * lowercase, diacritics/niqqud removed, apostrophes dropped, everything that is not a
 * letter or digit collapsed to single spaces.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(APOSTROPHES, '')
    .toLowerCase()
    .replace(NON_WORD, ' ')
    .trim()
}

export function tokenize(input: string): string[] {
  const normalized = normalizeText(input)
  return normalized === '' ? [] : normalized.split(' ')
}

export function sortTitle(title: string): string {
  return normalizeText(title).replace(LEADING_ARTICLE, '')
}

export function sortName(name: string): string {
  const normalized = normalizeText(name)
  if (name.includes(',')) return normalized
  const parts = normalized.split(' ')
  const last = parts.pop()
  return last === undefined ? '' : [last, ...parts].join(' ')
}
