import { err, ExternalItem, htmlToText, libraryPathOf, ok, parseSeriesPosition, type ArrConfig, type EditionFormat, type ItemError, type Result } from '@mylib/domain'
import type { ArrBook, ArrBookFile } from './api'

const AUDIO = new Set(['mp3', 'm4b', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'wav'])
const EBOOK = new Set(['epub', 'mobi', 'azw', 'azw3', 'kfx', 'pdf', 'cbz', 'cbr', 'fb2', 'djvu', 'txt', 'rtf', 'doc', 'docx', 'lit'])

export const arrBookIdKey = (kind: ArrConfig['kind']) => (kind === 'readarr' ? 'readarrBookId' : 'chaptarrBookId')

/** By the file's extension, else Readarr's quality name (EPUB, MOBI, MP3, M4B, FLAC…). */
export function formatOfFile(file: ArrBookFile): EditionFormat | null {
  for (const candidate of [/\.([a-z0-9]+)$/i.exec(file.path)?.[1], file.quality?.quality.name]) {
    const key = (candidate ?? '').toLowerCase()
    if (AUDIO.has(key)) return 'audiobook'
    if (EBOOK.has(key)) return 'ebook'
  }
  return null
}

/** "Mistborn #2; The Cosmere #4; Mage Errant #1-2" -> series with positions; a name without "#n" has no position. */
export function parseSeriesTitle(text: string | null | undefined): { name: string; position: number | null; positionEnd: number | null }[] {
  return (text ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const m = /^(.*?)\s*#\s*(\d+(?:\.\d+)?(?:\s*[-–—]\s*\d+(?:\.\d+)?)?)$/.exec(part)
      const at = m?.[2] === undefined ? null : parseSeriesPosition(m[2])
      if (m?.[1] && at) return { name: m[1], ...at }
      // a backwards range keeps its start, as an unreadable position did before (#122)
      const start = m?.[1] && m[2] ? Number.parseFloat(m[2]) : Number.NaN
      return m?.[1] && Number.isFinite(start) ? { name: m[1], position: start, positionEnd: null } : { name: part, position: null, positionEnd: null }
    })
}

const segmentsOf = (path: string): string[] => path.split(/[\\/]+/).filter((s) => s !== '')

/**
 * #104: the folder holding all of these files (a book's CD1/CD2 subfolders resolve to the book's
 * folder), relative to the root folder it is in. Null outside every root, or directly in one.
 */
export function libraryPathOfFiles(files: readonly ArrBookFile[], roots: readonly string[]): string | null {
  const [first, ...rest] = files.map((f) => segmentsOf(f.path).slice(0, -1))
  if (first === undefined) return null
  let common = first
  for (const dir of rest) {
    let n = 0
    while (n < common.length && n < dir.length && common[n] === dir[n]) n++
    common = common.slice(0, n)
  }
  // the deepest root that contains the folder (a root inside another root wins)
  const root = roots
    .map(segmentsOf)
    .filter((r) => r.length < common.length && r.every((segment, i) => common[i] === segment))
    .sort((a, b) => b.length - a.length)[0]
  return root === undefined ? null : libraryPathOf(common.slice(root.length).join('/'))
}

/**
 * One Readarr/Chaptarr book -> one item per format it has files in (plan deviation 3), or — when
 * it is monitored and has none — one wanted item (spec §5). Unmonitored missing books are skipped.
 */
export function toArrItems(
  config: ArrConfig,
  book: ArrBook,
  authorName: string | undefined,
  files: readonly ArrBookFile[],
  roots: readonly string[] = [],
): Result<ExternalItem[], ItemError> {
  const bookRef = `book:${book.id}`
  const hasFiles = (book.statistics?.bookFileCount ?? 0) > 0
  if (hasFiles && files.length === 0) return err({ externalId: bookRef, message: 'Could not read this book\'s files' })

  const edition = book.editions?.find((e) => e.monitored === true) ?? book.editions?.[0]
  const release = (book.releaseDate ?? '').slice(0, 10)
  const cover = book.images?.find((i) => i.coverType === 'cover')?.url ?? null
  const common = {
    title: book.title,
    authors: authorName === undefined ? [] : [authorName],
    series: parseSeriesTitle(book.seriesTitle),
    publisher: edition?.publisher ?? null,
    publishedOn: /^\d{4}-\d{2}-\d{2}$/.test(release) ? release : null,
    pageCount: book.pageCount ?? edition?.pageCount ?? null,
    language: edition?.language ?? null,
    description: htmlToText(book.overview),
    coverUrl: cover === null ? null : new URL(cover, `${config.baseUrl}/`).toString(),
    tags: [...new Set(book.genres ?? [])],
    raw: book,
  }
  const bookId = { [arrBookIdKey(config.kind)]: String(book.id) }
  const identifiersFor = (format: EditionFormat, path: string | null = null) => {
    const matches = format === 'ebook' ? edition?.isEbook !== false : edition?.isEbook === false
    const others = path === null ? bookId : { ...bookId, libraryPath: path }
    return { isbn13: matches ? (edition?.isbn13 ?? null) : null, isbn10: null, asin: matches ? (edition?.asin ?? null) : null, others }
  }

  const candidates: unknown[] = []
  if (!hasFiles) {
    if (!book.monitored) return ok([])
    // the format is a placeholder: accepting a wanted item never creates an edition (plan deviation 4)
    candidates.push({ ...common, externalId: bookRef, format: 'ebook', wantedOnly: true, identifiers: { ...identifiersFor(edition?.isEbook === false ? 'audiobook' : 'ebook') } })
  } else {
    const formats = new Set(files.map(formatOfFile))
    if (formats.has(null) && formats.size === 1) return err({ externalId: bookRef, message: 'No ebook or audio files recognised' })
    for (const format of ['ebook', 'audiobook'] as const) {
      if (!formats.has(format)) continue
      const path = libraryPathOfFiles(files.filter((f) => formatOfFile(f) === format), roots)
      candidates.push({ ...common, externalId: `${bookRef}:${format}`, format, identifiers: identifiersFor(format, path) })
    }
  }

  const items: ExternalItem[] = []
  for (const candidate of candidates) {
    const item = ExternalItem.safeParse(candidate)
    if (!item.success) return err({ externalId: bookRef, message: item.error.issues[0]?.message ?? 'Invalid item' })
    items.push(item.data)
  }
  return ok(items)
}
