import { coveredPositions } from '@mylib/domain'

/** The positions other books already hold in a series, and the next free whole number. */
export interface SeriesHint {
  taken: number[]
  next: number
}

export function seriesPositionHint(
  entries: readonly { id: string; position: number | null; positionEnd?: number | null }[],
  currentWorkId: string | undefined,
): SeriesHint | null {
  // a range holds its whole numbers (#122)
  const taken = [...new Set(entries.flatMap((e) => (e.id === currentWorkId ? [] : coveredPositions(e.position, e.positionEnd ?? null))))].sort((a, b) => a - b)
  const last = taken[taken.length - 1]
  return last === undefined ? null : { taken, next: Math.floor(last) + 1 }
}

export function formatSeriesHint(hint: SeriesHint): string {
  const label = (p: number) => `#${p}`
  const shown = hint.taken.length > 8 ? [...hint.taken.slice(0, 3).map(label), '…', ...hint.taken.slice(-3).map(label)] : hint.taken.map(label)
  return `In this series: ${shown.join(', ')} — next #${hint.next}`
}
