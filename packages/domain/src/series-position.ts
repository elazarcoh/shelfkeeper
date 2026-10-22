/** A book's place in a series: a position, or a range of them for one item holding several books (#122). */
export interface SeriesPosition {
  position: number | null
  positionEnd: number | null
}

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`
const SINGLE = new RegExp(`^${NUMBER}$`)
const RANGE = new RegExp(String.raw`^${NUMBER}\s*[-–—]\s*${NUMBER}$`)
const toNumber = (s: string) => Number(s.replace(',', '.'))

/** "3", "2.5", "2,5", "1-2", "1 – 2" → a position; "" → no position; null when unreadable or a range that doesn't go up. */
export function parseSeriesPosition(text: string): SeriesPosition | null {
  const t = text.trim()
  if (t === '') return { position: null, positionEnd: null }
  const single = SINGLE.exec(t)
  if (single?.[1]) return { position: toNumber(single[1]), positionEnd: null }
  const range = RANGE.exec(t)
  if (!range?.[1] || !range[2]) return null
  const position = toNumber(range[1])
  const positionEnd = toNumber(range[2])
  return positionEnd > position ? { position, positionEnd } : null
}

/** "" / "3" / "1–2" (en dash). */
export function formatSeriesPosition(position: number | null, positionEnd: number | null): string {
  if (position === null) return ''
  return positionEnd === null ? String(position) : `${position}–${positionEnd}`
}

/** The positions a link holds: itself, or a range's two ends and every whole number between them. */
export function coveredPositions(position: number | null, positionEnd: number | null): number[] {
  if (position === null) return []
  if (positionEnd === null) return [position]
  const out = new Set<number>([position])
  for (let n = Math.ceil(position); n <= Math.floor(positionEnd); n++) out.add(n)
  out.add(positionEnd)
  return [...out].sort((a, b) => a - b)
}
