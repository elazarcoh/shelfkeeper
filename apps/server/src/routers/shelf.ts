import { z } from 'zod'
import { hardcoverPage } from '@mylib/connectors'
import { addOneShelf, attachExtracted, attachPage, cachedCapture, importShelf, listWorks, previewShelf, setMyProposalCover, setMyProposalVolume, unlinkPage, type Db, type UserScope } from '@mylib/db'
import {
  DomainError,
  extractErrorMessage,
  extractPage,
  isbnForms,
  isIsraeliIsbn,
  ItemVolume,
  LibraryQuery,
  NLI_API_URL,
  nliResults,
  nliSearchUrl,
  openLibraryIsbnCapture,
  openLibraryIsbnUrl,
  openLibraryResults,
  openLibrarySearchUrl,
  pageFromText,
  PageCapture,
  ShelfAddOneInput,
  ShelfImportInput,
  ShelfPreviewInput,
  sniffImage,
  type ProviderId,
} from '@mylib/domain'
import type { Context } from '../trpc/context'
import { authedProcedure, router } from '../trpc/init'
import { readBookPage } from './hardcover'
import { queueCovers } from './queue-covers'

// spec §7.2: a pasted link that does not answer in 10 s is given up on
const PAGE_TIMEOUT_MS = 10_000
const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
// Open Library asks API clients to name themselves
const API_UA = 'MyLibrary/1.0 (self-hosted home library; +https://github.com/elazarcoh/my-library)'
// the National Library's firewall turns away a client that names itself, so it is asked like Simania (#157)
const headersFor = (provider: string, accept: string) =>
  provider === 'simania' || provider === 'nli' ? { accept, 'user-agent': BROWSER_UA, 'accept-language': 'he,en;q=0.8' } : { accept, 'user-agent': API_UA }
const NLI_NOT_SET_UP = "The National Library look-up isn't set up — the server needs an NLI_API_KEY"

/** The National Library's search address with the household's key (#157); null when the server has none. */
function nliRequest(ctx: Context, query: string): string | null {
  const key = ctx.config.nliApiKey
  return key === null ? null : `${nliSearchUrl(query, ctx.config.nliApiUrl ?? NLI_API_URL)}&api_key=${encodeURIComponent(key)}`
}

type Lookup = { capture: PageCapture | null } | { failed: true }

/** A book in the catalog (not only wished for) with an edition of this ISBN: the search indexes editions' ISBNs. */
async function bookWithIsbn(db: Db, scope: UserScope, forms: { isbn13: string; isbn10: string | null }): Promise<{ workId: string; title: string } | null> {
  for (const isbn of [forms.isbn13, forms.isbn10]) {
    if (isbn === null) continue
    const found = await listWorks(db, scope,LibraryQuery.parse({ scope: 'catalog', search: isbn, limit: 1, includeWanted: false }))
    const work = found.items[0]
    if (work !== undefined) return { workId: work.id, title: work.title }
  }
  return null
}

/** One search of Open Library for an ISBN (it knows both forms of one). */
async function openLibraryByIsbn(ctx: Context, isbn13: string): Promise<Lookup> {
  const body = await ctx.http.getText(openLibraryIsbnUrl(isbn13), headersFor('openlibrary', 'application/json'), undefined, PAGE_TIMEOUT_MS)
  if (!body.ok) return { failed: true }
  try {
    return { capture: openLibraryIsbnCapture(JSON.parse(body.value)) }
  } catch {
    return { failed: true }
  }
}

/** The National Library by ISBN: the 13-digit form, then the 10-digit one, which its records may hold instead. At most two requests. */
async function nliByIsbn(ctx: Context, forms: { isbn13: string; isbn10: string | null }): Promise<Lookup | null> {
  for (const isbn of [forms.isbn13, forms.isbn10]) {
    if (isbn === null) continue
    const url = nliRequest(ctx, `any,contains,${isbn}`)
    if (url === null) return null
    const body = await ctx.http.getText(url, headersFor('nli', 'application/json'), undefined, PAGE_TIMEOUT_MS)
    if (!body.ok) return { failed: true }
    let found: PageCapture[]
    try {
      found = nliResults(JSON.parse(body.value))
    } catch {
      return { failed: true }
    }
    // the search looks in every field: only a record carrying this ISBN is taken (or the one record found)
    const exact = found.find((c) => {
      const page = extractPage(c)
      return page.ok && (page.value.isbn13 === forms.isbn13 || (forms.isbn10 !== null && page.value.isbn10 === forms.isbn10))
    })
    const capture = exact ?? (found.length === 1 ? found[0] : undefined)
    if (capture !== undefined) return { capture }
  }
  return { capture: null }
}

export const shelfRouter = router({
  // a mutation although it only reads: up to 100 rows (and their pages) do not fit in a GET url
  preview: authedProcedure.input(ShelfPreviewInput).mutation(({ ctx, input }) => previewShelf(ctx.db, ctx.scope, input)),
  import: authedProcedure.input(ShelfImportInput).mutation(({ ctx, input }) => importShelf(ctx.db, ctx.scope, input)),
  addOne: authedProcedure.input(ShelfAddOneInput).mutation(async ({ ctx, input }) => {
    const result = await addOneShelf(ctx.db, ctx.scope, input)
    await queueCovers(ctx, [result.sourceId])
    return result
  }),
  attachPage: authedProcedure
    .input(z.object({ proposalId: z.uuid(), capture: PageCapture }))
    .mutation(({ ctx, input }) => attachPage(ctx.db, ctx.scope, input.proposalId, input.capture)),
  // a Hardcover look-up result: one request for the book, then linked like a page (no captured page to store)
  attachHardcover: authedProcedure
    .input(z.object({ proposalId: z.uuid(), hardcoverId: z.number().int().positive(), editionId: z.number().int().positive().nullable() }))
    .mutation(async ({ ctx, input }) => attachExtracted(ctx.db, ctx.scope, input.proposalId, hardcoverPage(await readBookPage(ctx, { id: input.hardcoverId }), input.editionId), null)),
  // the person's own reading of the volume: final, null is "not a volume"
  setVolume: authedProcedure
    .input(z.object({ proposalId: z.uuid(), volume: ItemVolume.nullable() }))
    .mutation(({ ctx, input }) => setMyProposalVolume(ctx.db, ctx.scope, input.proposalId, input.volume)),
  // #161: a cover photo (framed in the browser) for a book waiting in my Inbox; null takes it off
  setCover: authedProcedure
    .input(z.object({ proposalId: z.uuid(), imageBase64: z.base64().max(4 * 1024 * 1024).nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (input.imageBase64 === null) return setMyProposalCover(ctx.db, ctx.scope, input.proposalId, null)
      const bytes = new Uint8Array(Buffer.from(input.imageBase64, 'base64'))
      const kind = sniffImage(bytes)
      if (kind === null) throw new DomainError('INVALID', 'That file is not a JPEG, PNG, GIF or WebP picture')
      const stored = await ctx.assets.put(bytes, kind.ext)
      await setMyProposalCover(ctx.db, ctx.scope, input.proposalId, { ...stored, mime: kind.mime })
    }),
  // a pasted link: one request, only to the provider's own address for that book (never the pasted one), redirects refused
  fetchPage: authedProcedure
    .input(z.object({ proposalId: z.uuid().nullable(), text: z.string().max(4000) }))
    .mutation(async ({ ctx, input }) => {
      const found = pageFromText(input.text)
      if (found === null) throw new DomainError('INVALID', 'Paste the link of a book page on Simania or Open Library')
      const { provider, id } = found
      let capture = await cachedCapture(ctx.db, provider.id, id)
      if (capture === null) {
        const url = provider.id === 'nli' ? nliRequest(ctx, `any,contains,${id}`) : provider.fetch.url(id)
        if (url === null) throw new DomainError('INVALID', NLI_NOT_SET_UP)
        const body = await ctx.http.getText(url, headersFor(provider.id, provider.fetch.accept), undefined, PAGE_TIMEOUT_MS)
        if (!body.ok) throw new DomainError('INVALID', provider.bookmarklet ? `${provider.label} didn't answer — use the bookmarklet instead` : `${provider.label} didn't answer — try again in a minute`)
        // an Open Library edition's own record adds its page count; if it fails, the link works without one (#102)
        const detailsUrl = provider.fetch.detailsUrl?.(id) ?? null
        const details = detailsUrl === null ? null : await ctx.http.getText(detailsUrl, headersFor(provider.id, provider.fetch.accept), undefined, PAGE_TIMEOUT_MS)
        capture = provider.fetch.capture(body.value, provider.canonicalUrl(id), details?.ok === true ? details.value : null)
        if (capture === null) throw new DomainError('INVALID', `${provider.label} doesn't know that book`)
      }
      const extracted = extractPage(capture)
      if (!extracted.ok) throw new DomainError('INVALID', extractErrorMessage[extracted.error])
      if (input.proposalId !== null) await attachPage(ctx.db, ctx.scope, input.proposalId, capture)
      return { title: extracted.value.title, capture }
    }),
  // one search of Open Library's API per press (Simania is never searched by the server)
  search: authedProcedure.input(z.object({ query: z.string().trim().min(1).max(300) })).mutation(async ({ ctx, input }) => {
    const body = await ctx.http.getText(openLibrarySearchUrl(input.query), headersFor('openlibrary', 'application/json'), undefined, PAGE_TIMEOUT_MS)
    if (!body.ok) throw new DomainError('INVALID', "Open Library didn't answer — try again in a minute")
    let json: unknown
    try {
      json = JSON.parse(body.value)
    } catch {
      throw new DomainError('INVALID', "Open Library didn't answer — try again in a minute")
    }
    return {
      results: openLibraryResults(json).flatMap((capture) => {
        const page = extractPage(capture)
        return page.ok ? [{ page: page.value, capture }] : []
      }),
    }
  }),
  // a scanned or typed ISBN (#157): is it already here, and the book's page from Open Library or the National Library
  // (an Israeli ISBN asks the National Library first); stops at the first that knows it
  byIsbn: authedProcedure.input(z.object({ isbn: z.string().trim().min(1).max(40) })).mutation(async ({ ctx, input }) => {
    const forms = isbnForms(input.isbn)
    if (forms === null) throw new DomainError('INVALID', "That isn't an ISBN")
    const have = await bookWithIsbn(ctx.db, ctx.scope, forms)
    const order: ProviderId[] = isIsraeliIsbn(forms.isbn13) ? ['nli', 'openlibrary'] : ['openlibrary', 'nli']
    const tried: ProviderId[] = []
    const failed: ProviderId[] = []
    for (const source of order) {
      const found = source === 'nli' ? await nliByIsbn(ctx, forms) : await openLibraryByIsbn(ctx, forms.isbn13)
      if (found === null) continue
      tried.push(source)
      if ('failed' in found) failed.push(source)
      else if (found.capture !== null) return { isbn: forms.isbn13, have, capture: found.capture, tried, failed }
    }
    return { isbn: forms.isbn13, have, capture: null, tried, failed }
  }),
  unlinkPage: authedProcedure.input(z.object({ proposalId: z.uuid() })).mutation(({ ctx, input }) => unlinkPage(ctx.db, ctx.scope, input.proposalId)),
  extract: authedProcedure.input(z.object({ capture: PageCapture })).mutation(({ input }) => {
    const extracted = extractPage(input.capture)
    if (!extracted.ok) throw new DomainError('INVALID', extractErrorMessage[extracted.error])
    return extracted.value
  }),
})
