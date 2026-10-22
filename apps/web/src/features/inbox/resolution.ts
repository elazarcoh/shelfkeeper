import type { CsvResolution, CsvShelf, EditionFormat, InboxResolution, MatchBasis } from '@mylib/domain'

export const basisLabel: Record<MatchBasis, string> = {
  identifier: 'Exact match',
  restore: 'Formerly owned',
  title_author: 'Similar',
}

export function sameCopyResolution(
  candidate: { basis: MatchBasis; workId: string; edition: { id: string; format: EditionFormat } | null },
  itemFormat: EditionFormat,
): InboxResolution | null {
  if (candidate.edition === null || candidate.edition.format !== itemFormat) return null
  return { action: 'link_edition', editionId: candidate.edition.id }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

type BulkCounts = { created: number; linked: number; wanted: number; skipped: number }

export function bulkCreateSummary({ created, linked, wanted, skipped }: BulkCounts): string {
  const parts = [`Created ${plural(created, 'book', 'books')}`]
  if (linked > 0) parts.push(`added ${plural(linked, 'ebook edition', 'ebook editions')}`)
  if (wanted > 0) parts.push(`added ${plural(wanted, 'wanted book', 'wanted books')}`)
  if (skipped > 0) parts.push(`skipped ${skipped} already handled`)
  return parts.join(', ')
}

export function sumCounts(rounds: readonly (BulkCounts & { remaining: number })[]): BulkCounts {
  return rounds.reduce((a, r) => ({ created: a.created + r.created, linked: a.linked + r.linked, wanted: a.wanted + r.wanted, skipped: a.skipped + r.skipped }), {
    created: 0,
    linked: 0,
    wanted: 0,
    skipped: 0,
  })
}

/** Runs a chunked bulk action until nothing remains, or a round makes no progress (plan deviation 15). */
export async function drain<T extends { remaining: number }>(step: () => Promise<T>, progressed: (r: T) => boolean, maxRounds = 100): Promise<T[]> {
  const rounds: T[] = []
  for (let i = 0; i < maxRounds; i++) {
    const r = await step()
    rounds.push(r)
    if (r.remaining === 0 || !progressed(r)) break
  }
  return rounds
}

/** `drain` can stop with items still pending (a stalled chunk someone must review, or the round cap) — say so. */
export function withRemainingNote(message: string, remaining: number): string {
  return remaining > 0 ? `${message} — ${remaining} still waiting, run it again` : message
}

export const csvShelfLabel: Record<CsvShelf, string> = { read: 'Read', reading: 'Reading', want: 'Want to read' }

const WANT_LABEL = 'Add to my want-to-read'

/** A to-read row never becomes a copy, so its "create" button says what it really does. */
export const csvCreateLabel = (shelf: CsvShelf | null): string => (shelf === 'want' ? WANT_LABEL : 'Create new book')

export function csvCandidateResolutions(
  candidate: { workId: string; edition: { id: string; format: EditionFormat } | null; volume: { number: number } | null },
  itemFormat: EditionFormat,
  shelf: CsvShelf | null = null,
  fromShelfPhoto = false,
): { label: string; resolution: CsvResolution }[] {
  if (shelf === 'want') return [{ label: WANT_LABEL, resolution: { action: 'track_only', workId: candidate.workId } }]
  if (candidate.volume !== null) {
    // another volume of this book: it can't be one of its copies (#66)
    const add = { label: `Add as volume ${candidate.volume.number}`, resolution: { action: 'link_new_edition', workId: candidate.workId } } as const
    return fromShelfPhoto ? [add] : [add, { label: 'Just record my read', resolution: { action: 'track_only', workId: candidate.workId } }]
  }
  const options: { label: string; resolution: CsvResolution }[] = []
  if (candidate.edition !== null && candidate.edition.format === itemFormat) options.push({ label: 'It’s my copy', resolution: { action: 'link_edition', editionId: candidate.edition.id } })
  // a book photographed on a shelf is in hand: it is a copy, never just a read
  if (!fromShelfPhoto) options.push({ label: 'Just record my read', resolution: { action: 'track_only', workId: candidate.workId } })
  options.push({ label: 'Add my copy to this book', resolution: { action: 'link_new_edition', workId: candidate.workId } })
  return options
}

export function csvReadSummary({
  read,
  rating,
  shelf = null,
}: {
  read: { finishedOn: string; finishedPrecision: 'day' | 'month' | 'year' } | null
  rating: number | null
  shelf?: CsvShelf | null
}): string {
  const parts: string[] = []
  if (read !== null) parts.push(`Read ${read.finishedPrecision === 'day' ? read.finishedOn : read.finishedPrecision === 'month' ? read.finishedOn.slice(0, 7) : read.finishedOn.slice(0, 4)}`)
  // a dated read already says "Read"
  if (shelf !== null && !(shelf === 'read' && read !== null)) parts.push(csvShelfLabel[shelf])
  if (rating !== null) parts.push(`★ ${rating}`)
  return parts.join(' · ')
}

/** The book the shelf review chose ("physical copy of X") is offered first; the rest keep their order. */
export function presetFirst<T extends { workId: string }>(candidates: T[], preset: { workId: string } | null): T[] {
  if (preset === null) return candidates
  const at = candidates.findIndex((c) => c.workId === preset.workId)
  if (at <= 0) return candidates
  return [candidates[at] as T, ...candidates.slice(0, at), ...candidates.slice(at + 1)]
}
