import type { EditionFormat, WishRow } from '@mylib/domain'

/** The volumes "Bought" can ask about: the missing ones of the set in the chosen format, unless the saved page already names its volume. */
export function boughtVolumeChoices(w: Pick<WishRow, 'page' | 'volumes'>, format: EditionFormat): number[] {
  if (w.page?.volume != null || w.volumes === null || w.volumes.format !== format) return []
  return w.volumes.missing
}
