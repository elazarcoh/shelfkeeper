import { normalizeText } from './text'

export interface SearchDocumentParts {
  title: string
  subtitle: string | null
  series: { name: string; position: number | null; positionEnd?: number | null }[]
  authors: string[]
  narrators: string[]
  translators: string[]
  tags: string[]
  otherTitles: string[]
  identifiers: string[]
}

export interface SearchDocument {
  document: string
  titleText: string
  seriesText: string
  authorText: string
  otherText: string
  /** #73: space-separated first-letter abbreviations of the titles, series and authors ('' when none) */
  acronyms: string
}

const joinNormalized = (values: readonly string[]) =>
  values
    .map(normalizeText)
    .filter((v) => v !== '')
    .join(' ')

const ARTICLES = new Set(['the', 'a', 'an'])
const MIN_ACRONYM_LENGTH = 2

/**
 * #73: the first letter of each normalized word ("The Wandering Inn" → twi), and again without a leading
 * The/A/An when that still leaves two words (wi). A `name` written "Last, First" is read as "First Last".
 */
export function acronymsOf(text: string, options: { name?: boolean } = {}): string[] {
  const comma = text.indexOf(',')
  const natural = options.name === true && comma !== -1 ? `${text.slice(comma + 1)} ${text.slice(0, comma)}` : text
  const words = normalizeText(natural).split(' ').filter((w) => w !== '')
  const initials = words.map((w) => String.fromCodePoint(w.codePointAt(0) ?? 0))
  const variants = [initials.join('')]
  if (words.length > 2 && ARTICLES.has(words[0] ?? '')) variants.push(initials.slice(1).join(''))
  return variants.filter((a) => a.length >= MIN_ACRONYM_LENGTH)
}

export function buildSearchDocument(p: SearchDocumentParts): SearchDocument {
  const titleText = joinNormalized([p.title, p.subtitle ?? '', ...p.otherTitles])
  const seriesText = joinNormalized(p.series.map((s) => [s.name, s.position, s.positionEnd ?? null].filter((v) => v !== null).join(' ')))
  const authorText = joinNormalized(p.authors)
  const otherText = joinNormalized([...p.narrators, ...p.translators, ...p.tags, ...p.identifiers])
  const document = [titleText, seriesText, authorText, otherText].filter((v) => v !== '').join(' ')
  const acronyms = [
    ...new Set([
      ...[p.title, ...p.otherTitles, ...p.series.map((s) => s.name)].flatMap((t) => acronymsOf(t)),
      ...p.authors.flatMap((a) => acronymsOf(a, { name: true })),
    ]),
  ].join(' ')
  return { document, titleText, seriesText, authorText, otherText, acronyms }
}
