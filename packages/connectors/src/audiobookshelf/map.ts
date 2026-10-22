import { cleanIsbn, err, ExternalItem, htmlToText, isValidIsbn10, isValidIsbn13, libraryPathOf, ok, parseSeriesPosition, type ItemError, type Result } from '@mylib/domain'
import { AbsItem } from './api'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** "1" / "1-2" (#122); text it can't read keeps its leading number ("1a" → 1), as before ranges. */
function sequencePosition(sequence: string | null | undefined): { position: number | null; positionEnd: number | null } {
  if (sequence === null || sequence === undefined) return { position: null, positionEnd: null }
  // a comma here is no decimal point ("1,2" stays 1, as before ranges): only the form and CSV read one
  const parsed = sequence.includes(',') ? null : parseSeriesPosition(sequence)
  if (parsed !== null) return parsed
  const n = Number.parseFloat(sequence)
  return { position: Number.isFinite(n) ? n : null, positionEnd: null }
}

function identifiers(isbn: string | null | undefined, asin: string | null | undefined, others: Record<string, string>) {
  const cleaned = isbn === null || isbn === undefined ? '' : cleanIsbn(isbn)
  return {
    isbn13: isValidIsbn13(cleaned) ? cleaned : null,
    isbn10: isValidIsbn10(cleaned) ? cleaned : null,
    asin: asin ?? null,
    others,
  }
}

/** The book's folder for #104's cross-source match; a lone file at the library root has none. */
function libraryPath(abs: AbsItem): string | null {
  return abs.isFile || abs.relPath === null || abs.relPath === undefined ? null : libraryPathOf(abs.relPath)
}

const unique = (values: readonly string[]): string[] => [...new Set(values.map((v) => v.trim()).filter((v) => v !== ''))]

/** One Audiobookshelf book -> its audiobook and/or ebook edition (spec §5). */
export function toExternalItems(baseUrl: string, raw: unknown): Result<ExternalItem[], ItemError> {
  const rawId = typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string' ? raw.id : null
  const parsed = AbsItem.safeParse(raw)
  if (!parsed.success) return err({ externalId: rawId, message: 'Unexpected item shape from Audiobookshelf' })
  const abs = parsed.data
  if (abs.mediaType !== 'book' || abs.isMissing || abs.isInvalid) return ok([])
  const m = abs.media.metadata
  const path = libraryPath(abs)

  const common = {
    title: m.title ?? '',
    subtitle: m.subtitle ?? null,
    authors: unique(m.authors.map((a) => a.name)),
    series: m.series.map((s) => ({ name: s.name, ...sequencePosition(s.sequence) })),
    identifiers: identifiers(m.isbn, m.asin, path === null ? { audiobookshelfId: abs.id } : { audiobookshelfId: abs.id, libraryPath: path }),
    publisher: m.publisher ?? null,
    publishedOn: m.publishedDate !== null && m.publishedDate !== undefined && ISO_DATE.test(m.publishedDate) ? m.publishedDate : null,
    language: m.language ?? null,
    description: htmlToText(m.descriptionPlain ?? m.description),
    coverUrl: `${baseUrl}/api/items/${encodeURIComponent(abs.id)}/cover`,
    tags: unique([...m.genres, ...abs.media.tags]),
    raw,
  }
  const hasAudio = abs.media.audioFiles.length > 0 || (abs.media.numAudioFiles ?? 0) > 0
  const candidates: unknown[] = []
  if (hasAudio) {
    const duration = abs.media.duration ?? null
    candidates.push({ ...common, externalId: abs.id, format: 'audiobook', narrators: unique(m.narrators), durationSec: duration === null ? null : Math.round(duration) })
  }
  if (abs.media.ebookFile) {
    // Audiobookshelf has one ISBN/ASIN per book; with audio present it describes the audiobook, so the
    // ebook sibling gets none of it (an ebook-only book keeps its identifiers)
    const identifiers = hasAudio ? { isbn13: null, isbn10: null, asin: null, others: common.identifiers.others } : common.identifiers
    candidates.push({ ...common, externalId: `${abs.id}:ebook`, format: 'ebook', narrators: [], durationSec: null, identifiers })
  }

  const items: ExternalItem[] = []
  for (const candidate of candidates) {
    const item = ExternalItem.safeParse(candidate)
    if (!item.success) return err({ externalId: abs.id, message: item.error.issues[0]?.message ?? 'Invalid item' })
    items.push(item.data)
  }
  return ok(items)
}
