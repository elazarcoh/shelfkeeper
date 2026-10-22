import { cleanIsbn, err, ExternalItem, globalIdKeys, htmlToText, isValidIsbn10, isValidIsbn13, ok, type CalibreConfig, type ItemError, type Result } from '@mylib/domain'
import { CalibreBook } from './api'

const GLOBAL_KEYS: ReadonlySet<string> = new Set(globalIdKeys)
/** Calibre's placeholder author and "undefined" date (year 101) mean "not set". */
const UNKNOWN_AUTHOR = 'Unknown'
const unique = (values: readonly string[]): string[] => [...new Set(values.map((v) => v.trim()).filter((v) => v !== ''))]

function calibreDate(value: string | null | undefined): string | null {
  const day = (value ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number(day.slice(0, 4)) < 1000) return null
  return day
}

/** One Calibre book -> its ebook edition, or null when it has no format files (plan deviation 2). */
export function toCalibreItem(config: CalibreConfig, id: string, raw: unknown): Result<ExternalItem | null, ItemError> {
  const parsed = CalibreBook.safeParse(raw)
  if (!parsed.success) return err({ externalId: id, message: 'Unexpected book shape from Calibre' })
  const book = parsed.data
  if ((book.formats ?? []).length === 0) return ok(null)

  const ids = book.identifiers ?? {}
  const isbn = cleanIsbn(ids.isbn ?? '')
  const others: Record<string, string> = { calibreId: id }
  for (const [key, value] of Object.entries(ids)) if (GLOBAL_KEYS.has(key)) others[key] = value
  const words = config.wordCountColumn === null ? undefined : book.user_metadata?.[config.wordCountColumn]?.['#value#']

  const item = ExternalItem.safeParse({
    externalId: id,
    format: 'ebook',
    title: book.title ?? '',
    authors: unique((book.authors ?? []).filter((a) => a !== UNKNOWN_AUTHOR)),
    series: book.series ? [{ name: book.series, position: book.series_index ?? null }] : [],
    identifiers: {
      isbn13: isValidIsbn13(isbn) ? isbn : null,
      isbn10: isValidIsbn10(isbn) ? isbn : null,
      asin: ids.amazon ?? ids['mobi-asin'] ?? null,
      others,
    },
    publisher: book.publisher ?? null,
    publishedOn: calibreDate(book.pubdate),
    wordCount: typeof words === 'number' ? Math.round(words) : null,
    language: book.languages?.[0] ?? null,
    description: htmlToText(book.comments),
    coverUrl: book.cover ? new URL(book.cover, `${config.baseUrl}/`).toString() : null,
    tags: unique(book.tags ?? []),
    raw,
  })
  return item.success ? ok(item.data) : err({ externalId: id, message: item.error.issues[0]?.message ?? 'Invalid item' })
}
