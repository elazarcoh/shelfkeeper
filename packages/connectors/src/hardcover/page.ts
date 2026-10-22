import type { ExtractedPage, HardcoverBookPage } from '@mylib/domain'

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A Hardcover book and the edition the user picked (the book's main edition when none) as a fetched page. */
export function hardcoverPage(book: HardcoverBookPage, editionId: number | null): ExtractedPage {
  const edition = book.editions.find((e) => e.id === (editionId ?? book.mainEditionId)) ?? null
  const date = edition?.releaseDate ?? book.releaseDate
  const publishedOn = date !== null && FULL_DATE.test(date) ? date : null
  return {
    provider: 'hardcover',
    providerId: String(book.id),
    url: `https://hardcover.app/books/${book.slug}${edition ? `/editions/${edition.id}` : ''}`,
    title: book.title,
    subtitle: null,
    authors: book.authors,
    translators: book.translators,
    publisher: edition?.publisher ?? null,
    year: publishedOn?.slice(0, 4) ?? null,
    publishedOn,
    pageCount: edition?.pages ?? null,
    isbn13: edition?.isbn13 ?? null,
    isbn10: edition?.isbn10 ?? null,
    series: book.series,
    language: edition?.language ?? null,
    coverUrl: edition?.imageUrl ?? book.imageUrl,
    description: book.description,
    volume: null,
    importedTitle: null,
  }
}
