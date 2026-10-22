import {
  err,
  normalizeLanguage,
  ok,
  tagsFromCached,
  type HardcoverAuthorBooks,
  type HardcoverBookData,
  type HardcoverBookPage,
  type HardcoverBookSeries,
  type HardcoverExternalBook,
  type HardcoverSearchHit,
  type HardcoverSeriesBooks,
  type Result,
} from '@mylib/domain'
import { z } from 'zod'
import * as Q from './queries'

export const HARDCOVER_API_URL_DEFAULT = 'https://api.hardcover.app/v1/graphql'
const USER_AGENT = 'my-library (self-hosted household library)'
const TIMEOUT_MS = 30_000
const BURST = 10
const REFILL_MS = 1000 // 60 a minute
const TRANSIENT_RETRY_MS = 3000

export type PostLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>

export interface HardcoverError {
  kind: 'unauthorized' | 'missing_scope' | 'rate_limited' | 'unavailable' | 'bad_response'
  message: string
  scope?: string
}

export interface HardcoverClient {
  readonly requestsUsed: number
  me(): Promise<Result<{ id: number; username: string }, HardcoverError>>
  editionsByIsbn(isbns: string[]): Promise<Result<{ isbn13: string | null; isbn10: string | null; bookId: number; editionId: number | null }[], HardcoverError>>
  searchBooks(query: string): Promise<Result<HardcoverSearchHit[], HardcoverError>>
  booksById(ids: number[]): Promise<Result<HardcoverBookData[], HardcoverError>>
  /** One request: the book, its authors and series, and its editions (up to 100). */
  bookPage(ref: { id: number } | { slug: string }): Promise<Result<HardcoverBookPage | null, HardcoverError>>
  recommendations(userId: number): Promise<Result<number[], HardcoverError>>
  userBook(userId: number, bookId: number): Promise<Result<{ id: number; statusId: number; rating: number | null } | null, HardcoverError>>
  bookDetails(ids: number[]): Promise<Result<(HardcoverExternalBook & { series: HardcoverBookSeries[]; authorIds: number[] })[], HardcoverError>>
  seriesBooks(seriesIds: number[]): Promise<Result<HardcoverSeriesBooks[], HardcoverError>>
  /** Primary-author, non-compilation books released from 24 months before `today` to 6 months after it. */
  authorBooks(authorIds: number[], today: string): Promise<Result<HardcoverAuthorBooks[], HardcoverError>>
  /** Every book the user has marked Read, 500 per request. */
  readBookIds(userId: number): Promise<Result<number[], HardcoverError>>
  markRead(existing: { id: number; rating: number | null } | null, bookId: number, read: { finishedOn: string; rating: number | null }): Promise<Result<void, HardcoverError>>
}

const Book = z.object({
  id: z.number().int(),
  slug: z.string(),
  title: z.string(),
  rating: z.coerce.number().nullable(),
  ratings_count: z.number().int().nullable(),
  cached_tags: z.unknown(),
  cached_similar_book_ids: z.array(z.number().int()).nullable().catch([]),
})
const toBook = (b: z.output<typeof Book>): HardcoverBookData => ({
  id: b.id,
  slug: b.slug,
  title: b.title,
  rating: b.rating,
  ratingsCount: b.ratings_count ?? 0,
  tags: tagsFromCached(b.cached_tags),
  similarIds: b.cached_similar_book_ids ?? [],
})
const PAGE_SIZE = 500
/** pages of the Read list one call may fetch: 10,000 books */
const READ_MAX_PAGES = 20

/** Audio and e-book editions split one book into parts ("(1 of 3)", ", Part 2"): Hardcover's `featured` flag doesn't separate them from the book. */
const SPLIT_PART = [/\bpart\s+\d+\s+of\s+\d+/i, /\(\s*\d+\s+of\s+\d+\s*\)/i, /\b\d+\/\d+\b/, /,\s*part\s+\d+\s*$/i]
const isSplitPart = (title: string): boolean => SPLIT_PART.some((re) => re.test(title))

const Contributor = z.object({ author: z.object({ id: z.number().int(), name: z.string() }), contribution: z.string().nullable().optional().catch(null) })

const Detail = z.object({
  id: z.number().int(),
  title: z.string(),
  pages: z.number().int().nullable().optional().catch(null),
  release_date: z.string().nullable().optional().catch(null),
  cached_image: z.object({ url: z.string() }).nullable().optional().catch(null),
  // one malformed entry is skipped, not the whole list
  cached_contributors: z
    .array(z.unknown())
    .catch([])
    .transform((list) => list.flatMap((c) => { const r = Contributor.safeParse(c); return r.success ? [r.data] : [] })),
  cached_tags: z.unknown(),
  book_series: z.array(z.object({ position: z.coerce.number().nullable().catch(null), featured: z.boolean().catch(false), series: z.object({ id: z.number().int(), name: z.string() }) })).catch([]),
  editions: z.array(z.object({ id: z.number().int() })).optional(),
})
type Contributors = z.output<typeof Detail>['cached_contributors']
const mainAuthors = (list: Contributors) => list.filter((c) => c.contribution == null || c.contribution === 'Author').map((c) => c.author)
const seriesOf = (rows: z.output<typeof Detail>['book_series']): HardcoverBookSeries[] => rows.map((s) => ({ id: s.series.id, name: s.series.name, position: s.position, featured: s.featured }))
/** `featured` is unreliable (a whole universe can carry it): the lowest position wins, then a featured entry, then the first */
const mainSeries = (series: HardcoverBookSeries[]): HardcoverBookSeries | undefined => {
  const placed = series.filter((s) => s.position !== null)
  const lowest = Math.min(...placed.map((s) => s.position as number))
  const tied = placed.filter((s) => s.position === lowest)
  return tied.length > 0 ? (tied.find((s) => s.featured) ?? tied[0]) : (series.find((s) => s.featured) ?? series[0])
}
const toDetail = (b: z.output<typeof Detail>): HardcoverExternalBook & { series: HardcoverBookSeries[]; authorIds: number[] } => {
  const authors = mainAuthors(b.cached_contributors)
  const series = seriesOf(b.book_series)
  const main = mainSeries(series)
  return {
    id: b.id,
    title: b.title,
    authors: authors.map((a) => a.name),
    authorIds: authors.map((a) => a.id),
    seriesName: main?.name ?? null,
    position: main?.position ?? null,
    series,
    pages: b.pages ?? null,
    releaseDate: b.release_date ?? null,
    imageUrl: b.cached_image?.url ?? null,
    tags: tagsFromCached(b.cached_tags),
    hasAudiobook: b.editions === undefined ? null : b.editions.length > 0,
  }
}

/** An edition without an edition_format is named by its reading format when that says something (Physical says nothing). */
const READING_FORMAT_LABEL: Record<number, string> = { 2: 'Audiobook', 4: 'E-book' }
const PageEdition = z.object({
  id: z.number().int(),
  title: z.string().nullable().optional().catch(null),
  isbn_13: z.string().nullable().optional().catch(null),
  isbn_10: z.string().nullable().optional().catch(null),
  pages: z.number().int().nullable().optional().catch(null),
  release_date: z.string().nullable().optional().catch(null),
  edition_format: z.string().nullable().optional().catch(null),
  reading_format_id: z.number().int().nullable().optional().catch(null),
  publisher: z.object({ name: z.string() }).nullable().optional().catch(null),
  cached_image: z.object({ url: z.string() }).nullable().optional().catch(null),
  language: z.object({ code3: z.string().nullable().catch(null) }).nullable().optional().catch(null),
})
const PageBook = z.object({
  id: z.number().int(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable().optional().catch(null),
  release_date: z.string().nullable().optional().catch(null),
  cached_image: z.object({ url: z.string() }).nullable().optional().catch(null),
  cached_contributors: Detail.shape.cached_contributors,
  book_series: Detail.shape.book_series,
  default_physical_edition_id: z.number().int().nullable().optional().catch(null),
  default_cover_edition_id: z.number().int().nullable().optional().catch(null),
  editions: z.array(PageEdition).catch([]),
})
const toPage = (b: z.output<typeof PageBook>): HardcoverBookPage => {
  const main = mainSeries(seriesOf(b.book_series))
  return {
    id: b.id,
    slug: b.slug,
    title: b.title,
    description: b.description ?? null,
    releaseDate: b.release_date ?? null,
    imageUrl: b.cached_image?.url ?? null,
    authors: mainAuthors(b.cached_contributors).map((a) => a.name),
    translators: b.cached_contributors.filter((c) => c.contribution === 'Translator').map((c) => c.author.name),
    series: main ? { name: main.name, position: main.position } : null,
    mainEditionId: b.default_physical_edition_id ?? b.default_cover_edition_id ?? null,
    editions: b.editions.map((e) => ({
      id: e.id,
      title: e.title ?? null,
      format: e.edition_format || (e.reading_format_id == null ? null : (READING_FORMAT_LABEL[e.reading_format_id] ?? null)),
      pages: e.pages ?? null,
      publisher: e.publisher?.name ?? null,
      releaseDate: e.release_date ?? null,
      isbn13: e.isbn_13 ?? null,
      isbn10: e.isbn_10 ?? null,
      imageUrl: e.cached_image?.url ?? null,
      language: normalizeLanguage(e.language?.code3),
    })),
  }
}

const SeriesRow = z.object({
  series_id: z.number().int(),
  position: z.coerce.number().nullable(),
  series: z.object({ name: z.string() }).nullable().catch(null),
  book: z.object({ id: z.number().int(), title: z.string(), release_date: z.string().nullable().catch(null), users_count: z.number().nullable().catch(0) }),
})
type SeriesRowBook = z.output<typeof SeriesRow>['book']
/** Of several books at one position (split volumes, translations) the most read one; ties go to the earliest release. */
const moreRead = (a: SeriesRowBook, b: SeriesRowBook): boolean => {
  const [ua, ub] = [a.users_count ?? 0, b.users_count ?? 0]
  if (ua !== ub) return ua > ub
  if (a.release_date === null) return false
  return b.release_date === null || a.release_date < b.release_date
}

/** `date` (YYYY-MM-DD) moved by whole months, the day clamped to the target month's length. */
function addMonths(date: string, months: number): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number)
  const moved = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 0)).getUTCDate()
  moved.setUTCDate(Math.min(d, lastDay))
  return moved.toISOString().slice(0, 10)
}

const Mutation =z.object({ id: z.number().int().nullable(), error: z.string().nullable() })

export function createHardcoverClient(options: { token: string; apiUrl?: string; post?: PostLike; sleep?: (ms: number) => Promise<void> }): HardcoverClient {
  const post: PostLike = options.post ?? ((url, init) => fetch(url, init))
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const apiUrl = options.apiUrl ?? HARDCOVER_API_URL_DEFAULT
  let used = 0
  let tokens = BURST
  let last = Date.now()

  /** A token bucket: BURST back-to-back, then one a second (Hardcover: burst 10, 60 a minute). */
  async function take(): Promise<void> {
    const now = Date.now()
    tokens = Math.min(BURST, tokens + (now - last) / REFILL_MS)
    last = now
    if (tokens < 1) {
      await sleep(Math.ceil((1 - tokens) * REFILL_MS))
      tokens = 1
      last = Date.now()
    }
    tokens -= 1
  }

  async function call<T>(query: string, variables: Record<string, unknown>, data: z.ZodType<T>, retried = false, transientRetried = false): Promise<Result<T, HardcoverError>> {
    // a lost or failed query is asked again once; a mutation never is (insert_user_book_read would add a second read)
    const mayRetry = !transientRetried && !query.trimStart().startsWith('mutation')
    const again = async () => {
      await sleep(TRANSIENT_RETRY_MS)
      return call(query, variables, data, retried, true)
    }
    await take()
    used += 1
    let response: Response
    try {
      response = await post(apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}`, 'user-agent': USER_AGENT },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      if (mayRetry) return again()
      return err({ kind: 'unavailable', message: `Could not reach Hardcover (${error instanceof Error ? error.message : String(error)})` })
    }
    const body: unknown = await response.json().catch(() => null)
    if (response.status === 401) return err({ kind: 'unauthorized', message: 'Hardcover rejected the token' })
    if (response.status === 403) {
      const scope = z.object({ scope: z.string() }).safeParse(body)
      if (scope.success) return err({ kind: 'missing_scope', message: `The token lacks the "${scope.data.scope}" permission`, scope: scope.data.scope })
      return err({ kind: 'unauthorized', message: 'Hardcover refused the request' })
    }
    if (response.status === 429) {
      if (retried) return err({ kind: 'rate_limited', message: 'Hardcover is rate limiting requests — try again later' })
      await sleep(60_000)
      return call(query, variables, data, true, transientRetried)
    }
    if (response.status >= 500 || response.status === 408) {
      if (mayRetry) return again()
      return err({ kind: 'unavailable', message: `Hardcover answered ${response.status}` })
    }
    if (!response.ok) return err({ kind: 'bad_response', message: `Hardcover answered ${response.status}` })
    const parsed = z.object({ data: data }).safeParse(body)
    if (!parsed.success) {
      const errors = z.object({ errors: z.array(z.object({ message: z.string() })) }).safeParse(body)
      return err({ kind: 'bad_response', message: errors.success ? errors.data.errors.map((e) => e.message).join('; ') : 'Unexpected reply from Hardcover' })
    }
    return ok(parsed.data.data)
  }

  const mapOk = async <A, B>(r: Promise<Result<A, HardcoverError>>, f: (a: A) => B): Promise<Result<B, HardcoverError>> => {
    const v = await r
    return v.ok ? ok(f(v.value)) : v
  }

  async function mutate(query: string, variables: Record<string, unknown>, field: string): Promise<Result<number, HardcoverError>> {
    const r = await call(query, variables, z.object({ [field]: Mutation }))
    if (!r.ok) return r
    const m = (r.value as Record<string, z.output<typeof Mutation>>)[field]
    if (!m || m.error !== null || m.id === null) return err({ kind: 'bad_response', message: m?.error ?? 'Hardcover did not save it' })
    return ok(m.id)
  }

  return {
    get requestsUsed() {
      return used
    },
    me: () =>
      mapOk(call(Q.ME, {}, z.object({ me: z.union([z.array(z.object({ id: z.number().int(), username: z.string() })).min(1), z.object({ id: z.number().int(), username: z.string() })]) })), (d) =>
        Array.isArray(d.me) ? (d.me[0] as { id: number; username: string }) : d.me,
      ),
    editionsByIsbn: (isbns) =>
      mapOk(call(Q.EDITIONS_BY_ISBN, { isbns }, z.object({ editions: z.array(z.object({ id: z.number().int().nullable().optional().catch(null), isbn_13: z.string().nullable(), isbn_10: z.string().nullable(), book_id: z.number().int() })) })), (d) =>
        d.editions.map((e) => ({ isbn13: e.isbn_13, isbn10: e.isbn_10, bookId: e.book_id, editionId: e.id ?? null })),
      ),
    searchBooks: (query) =>
      mapOk(
        call(
          Q.SEARCH_BOOKS,
          { q: query },
          z.object({
            search: z.object({
              results: z
                .object({
                  hits: z
                    .array(
                      z.object({
                        document: z.object({
                          id: z.coerce.number().int(),
                          title: z.string(),
                          author_names: z.array(z.string()).catch([]),
                          release_year: z.number().int().nullable().optional().catch(null),
                          series_names: z.array(z.string()).optional().catch([]),
                          image: z.object({ url: z.string() }).nullable().optional().catch(null),
                        }),
                      }),
                    )
                    .catch([]),
                })
                .catch({ hits: [] }),
            }),
          }),
        ),
        (d): HardcoverSearchHit[] =>
          d.search.results.hits.map((h) => ({ id: h.document.id, title: h.document.title, authors: h.document.author_names, year: h.document.release_year ?? null, series: h.document.series_names ?? [], imageUrl: h.document.image?.url ?? null })),
      ),
    booksById: (ids) => mapOk(call(Q.BOOKS_BY_ID, { ids }, z.object({ books: z.array(Book) })), (d) => d.books.map(toBook)),
    bookPage: (ref) =>
      mapOk(
        'id' in ref ? call(Q.BOOK_PAGE_BY_ID, { id: ref.id }, z.object({ books: z.array(PageBook) })) : call(Q.BOOK_PAGE_BY_SLUG, { slug: ref.slug }, z.object({ books: z.array(PageBook) })),
        (d) => (d.books[0] ? toPage(d.books[0]) : null),
      ),
    recommendations: (userId) =>
      mapOk(call(Q.RECOMMENDATIONS, { userId }, z.object({ vibes: z.array(z.object({ cached_book_ids: z.array(z.number().int()).catch([]) })) })), (d) => d.vibes[0]?.cached_book_ids ?? []),
    userBook: (userId, bookId) =>
      mapOk(call(Q.USER_BOOK, { userId, bookId }, z.object({ user_books: z.array(z.object({ id: z.number().int(), status_id: z.number().int(), rating: z.coerce.number().nullable() })) })), (d) => {
        const b = d.user_books[0]
        return b ? { id: b.id, statusId: b.status_id, rating: b.rating } : null
      }),
    bookDetails: (ids) => mapOk(call(Q.BOOK_DETAILS, { ids }, z.object({ books: z.array(Detail) })), (d) => d.books.map(toDetail)),
    seriesBooks: (seriesIds) =>
      mapOk(call(Q.SERIES_BOOKS, { ids: seriesIds }, z.object({ book_series: z.array(SeriesRow) })), (d) => {
        const bySeries = new Map<number, { name: string; positions: Map<number, SeriesRowBook> }>()
        for (const row of d.book_series) {
          if (row.position === null || isSplitPart(row.book.title)) continue
          const entry = bySeries.get(row.series_id) ?? { name: row.series?.name ?? '', positions: new Map<number, SeriesRowBook>() }
          const current = entry.positions.get(row.position)
          if (current === undefined || moreRead(row.book, current)) entry.positions.set(row.position, row.book)
          bySeries.set(row.series_id, entry)
        }
        return [...bySeries].map(
          ([seriesId, { name, positions }]): HardcoverSeriesBooks => ({
            seriesId,
            name,
            books: [...positions].sort(([a], [b]) => a - b).map(([position, b]) => ({ id: b.id, position, title: b.title, releaseDate: b.release_date })),
          }),
        )
      }),
    authorBooks: (authorIds, today) =>
      mapOk(
        call(
          Q.AUTHOR_BOOKS,
          { ids: authorIds, since: addMonths(today, -24), until: addMonths(today, 6) },
          z.object({ contributions: z.array(z.object({ author_id: z.number().int(), book: z.object({ id: z.number().int(), title: z.string(), release_date: z.string().nullable().catch(null) }) })) }),
        ),
        (d) => {
          const byAuthor = new Map<number, HardcoverAuthorBooks['books']>()
          for (const c of d.contributions) byAuthor.set(c.author_id, [...(byAuthor.get(c.author_id) ?? []), { id: c.book.id, title: c.book.title, releaseDate: c.book.release_date }])
          return [...byAuthor].map(([authorId, books]): HardcoverAuthorBooks => ({ authorId, books }))
        },
      ),
    async readBookIds(userId) {
      const ids: number[] = []
      // a cap on the pages: a Hardcover that ignored `offset` would otherwise page until the quota is gone
      for (let pageNo = 0; pageNo < READ_MAX_PAGES; pageNo++) {
        const page = await call(Q.READ_BOOK_IDS, { userId, offset: pageNo * PAGE_SIZE }, z.object({ user_books: z.array(z.object({ book_id: z.number().int() })) }))
        if (!page.ok) return page
        ids.push(...page.value.user_books.map((b) => b.book_id))
        if (page.value.user_books.length < PAGE_SIZE) break
      }
      return ok(ids)
    },
    async markRead(existing, bookId, read) {
      // add-only (spec ruling 5): Hardcover's own rating stays; ours goes only where it has none
      const rating = existing?.rating == null ? read.rating : null
      const saved =
        existing === null
          ? await mutate(Q.INSERT_USER_BOOK, { object: { book_id: bookId, status_id: 3, ...(rating === null ? {} : { rating }) } }, 'insert_user_book')
          : await mutate(Q.UPDATE_USER_BOOK, { id: existing.id, object: { status_id: 3, ...(rating === null ? {} : { rating }) } }, 'update_user_book')
      if (!saved.ok) return saved
      const dated = await mutate(Q.INSERT_READ, { id: saved.value, read: { finished_at: read.finishedOn } }, 'insert_user_book_read')
      return dated.ok ? ok(undefined) : dated
    },
  }
}
