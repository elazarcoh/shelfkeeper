import { defaultPrimaryName } from '@mylib/domain'

interface DraftSeries {
  names: { id: string; primary: boolean }[]
  bookCount: number
}

/** The merge dialog's starting primary name (spec "Same series as…"): the primary of the series with more books, the opened one on a tie. */
export function mergePrimaryDefault(opened: DraftSeries, other: DraftSeries): string {
  const primaryOf = (s: DraftSeries) => s.names.find((n) => n.primary)?.id ?? s.names[0]?.id ?? ''
  return defaultPrimaryName({ primaryNameId: primaryOf(opened), bookCount: opened.bookCount }, { primaryNameId: primaryOf(other), bookCount: other.bookCount })
}

export function seriesSummary(bookCount: number): string {
  return bookCount === 0 ? 'No books' : bookCount === 1 ? '1 book' : `${String(bookCount)} books`
}

/** The split dialog's Submit: at least one book moves and at least one stays. */
export function splitDisabled(ticked: number, total: number): boolean {
  return ticked === 0 || ticked >= total
}
