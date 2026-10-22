import type { ExtractedPage, ItemVolume, PageCapture, ShelfImportInput, ShelfRow, ShelfStatus } from '@mylib/domain'

export type ReviewRow = {
  key: string
  row: ShelfRow
  checked: boolean
  /** true once the person ticked or unticked the row: a later preview no longer decides for them */
  touched: boolean
  status: ShelfStatus | null
  preset: { workId: string; title: string } | null
  capture: PageCapture | null
}

export function rowsFromAnswer(rows: ShelfRow[], key: () => string): ReviewRow[] {
  return rows.map((row) => ({ key: key(), row, checked: true, touched: false, status: null, preset: null, capture: null }))
}

const checkedBy = (status: ShelfStatus): boolean => status.kind === 'new' || status.kind === 'copy_of' || status.kind === 'new_volume' || status.kind === 'maybe'

/** Statuses arrive in row order. A copy-of or new-volume status presets the book; a row the person touched keeps their choice. */
export function applyStatuses(rows: ReviewRow[], statuses: ShelfStatus[]): ReviewRow[] {
  return rows.map((r, i) => {
    const status = statuses[i]
    if (status === undefined) return r
    const checked = r.touched ? r.checked : checkedBy(status)
    // a "have" row the person ticked on purpose is a second copy of that book
    const preset =
      status.kind === 'copy_of' || status.kind === 'new_volume' || (status.kind === 'have' && checked && r.touched)
        ? { workId: status.workId, title: status.title }
        : r.preset?.workId === (status.kind === 'maybe' ? status.workId : undefined)
          ? r.preset
          : null
    return { ...r, status, preset, checked }
  })
}

/** Ticking a "have" row records a second copy of that book (its preset); unticking drops it. A copy-of or picked maybe keeps its preset. */
export const toggle = (rows: ReviewRow[], key: string): ReviewRow[] =>
  rows.map((r) => {
    if (r.key !== key) return r
    const checked = !r.checked
    const preset = r.status?.kind === 'have' ? (checked ? { workId: r.status.workId, title: r.status.title } : null) : r.preset
    return { ...r, checked, touched: true, preset }
  })

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** A patch that changes nothing returns the same rows: tapping a title and leaving keeps the status and a chosen book. */
export function editRow(rows: ReviewRow[], key: string, patch: Partial<ShelfRow>): ReviewRow[] {
  const target = rows.find((r) => r.key === key)
  if (target === undefined) return rows
  const next = { ...target.row, ...patch }
  const unchanged =
    next.title.trim() === target.row.title.trim() && sameList(next.authors.map((a) => a.trim()), target.row.authors.map((a) => a.trim())) && (next.seriesNumber?.trim() ?? null) === (target.row.seriesNumber?.trim() ?? null) &&
    next.volume === target.row.volume &&
    next.volumeCount === target.row.volumeCount &&
    next.volumeSet === target.row.volumeSet
  if (unchanged) return rows
  return rows.map((r) => (r.key === key ? { ...r, row: next, status: null, preset: null } : r))
}

/** When a preview fails, rows still waiting for a status are treated as new instead of "Checking…" forever. */
export const settleStatuses = (rows: ReviewRow[]): ReviewRow[] => rows.map((r) => (r.status === null ? { ...r, status: { kind: 'new' } } : r))

export const setPreset = (rows: ReviewRow[], key: string, preset: ReviewRow['preset']): ReviewRow[] => rows.map((r) => (r.key === key ? { ...r, preset } : r))

export const setCapture = (rows: ReviewRow[], key: string, capture: PageCapture | null): ReviewRow[] =>
  rows.map((r) => (r.key === key ? { ...r, capture, status: null, preset: null } : r))

export const importRows = (rows: ReviewRow[]): ShelfImportInput['rows'] =>
  rows.filter((r) => r.checked).map((r) => ({ row: r.row, preset: r.preset === null ? null : { workId: r.preset.workId }, capture: r.capture }))

export function batchLabel(today: string): string {
  const day = new Date(`${today}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return `Shelf · ${day}`
}

/** A book page read as a row, the way the server does it for "Add one": what the duplicate check and the single-book review work from. */
export const rowFromExtracted = (p: ExtractedPage): ShelfRow => ({
  title: p.title,
  subtitle: null,
  authors: p.authors,
  translators: p.translators,
  publisher: p.publisher,
  series: p.series?.name ?? null,
  seriesNumber: p.series?.position != null ? String(p.series.position) : null,
  volume: p.volume?.number ?? null,
  volumeCount: p.volume?.count ?? null,
  volumeSet: false,
  language: p.language,
  spineText: null,
  originalTitle: null,
  confidence: null,
  notes: null,
})

/** The title to show for a linked page: the page as printed when the person says it is not a volume, else with the volume marker taken off. */
export const shownTitle = (p: ExtractedPage, volume: ItemVolume | null): string => (volume === null ? (p.importedTitle ?? p.title) : p.title)

/** A book page as a row with the person's volume choice (null: not a volume) set, for the duplicate check and "Add one". */
export const rowWithVolume = (p: ExtractedPage, volume: ItemVolume | null): ShelfRow => ({
  ...rowFromExtracted(p),
  title: shownTitle(p, volume),
  volume: volume?.number ?? null,
  volumeCount: volume?.count ?? null,
  volumeSet: true,
})
