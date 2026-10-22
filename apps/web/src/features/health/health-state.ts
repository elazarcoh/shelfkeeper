import { HealthCheck, healthChecks, type HealthCounts, type HealthItem } from '@mylib/domain'

export const checkLabel: Record<HealthCheck, string> = {
  no_cover: 'No cover',
  no_isbn: 'No ISBN',
  no_author: 'No author',
  no_length: 'No length',
  duplicates: 'Possible duplicates',
  empty_series: 'Empty series',
  series_gaps: 'Series gaps',
  long_loans: 'Long loans',
  kind_suggestions: 'Possible fanfiction or web serial',
  abs_out_of_sync: 'Out of sync with Audiobookshelf',
}

/** The first check with problems; the first check when everything is clean (or the counts are still loading). */
export function defaultCheck(counts: HealthCounts | undefined): HealthCheck {
  return healthChecks.find((c) => (counts?.[c] ?? 0) > 0) ?? 'no_cover'
}

export function parseHealthSearch(raw: Record<string, unknown>): { check?: HealthCheck } {
  const parsed = HealthCheck.safeParse(raw.check)
  return parsed.success ? { check: parsed.data } : {}
}

export function missingText(missing: number[], max = 10): string {
  const shown = missing.slice(0, max).map((n) => `#${String(n)}`).join(', ')
  return missing.length > max ? `Missing ${shown} and ${String(missing.length - max)} more` : `Missing ${shown}`
}

const formatName = { physical: 'Physical', ebook: 'Ebook', audiobook: 'Audiobook' } as const

// null for long_loans: the row renders that sentence itself, so the borrower name can sit in a <bdi>.
export function itemDetail(item: HealthItem): string | null {
  switch (item.check) {
    case 'no_cover':
      return 'No cover on any copy'
    case 'no_isbn':
      return 'No ISBN on a printed or ebook copy'
    case 'no_author':
      return 'No author'
    case 'no_length': {
      const copy = item.edition.volume === null ? formatName[item.edition.format] : `${formatName[item.edition.format]}, volume ${String(item.edition.volume)}`
      return `${copy}: ${item.edition.format === 'audiobook' ? 'no duration' : 'no page count'}`
    }
    case 'duplicates':
      return 'Similar titles'
    case 'empty_series':
      return 'No books in this series'
    case 'series_gaps':
      // unnumbered books may be the "missing" ones, so say they exist (#123)
      return item.unnumbered === 0
        ? missingText(item.missing)
        : `${missingText(item.missing)} · ${String(item.unnumbered)} ${item.unnumbered === 1 ? 'book has' : 'books have'} no number`
    case 'kind_suggestions':
      return item.suggested === 'fanfiction' ? 'Looks like fanfiction' : 'Looks like a web serial'
    case 'long_loans':
      return null
  }
}
