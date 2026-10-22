import { z } from 'zod'
import { hardcoverPage, openLibraryWork, type HardcoverClient, type HardcoverError } from '@mylib/connectors'
import {
  cachedCapture,
  countMyPushes,
  countPastPushes,
  getHardcoverAccount,
  getHardcoverAccountWithToken,
  getHardcoverForWork,
  getWorkDetail,
  lastHardcoverRun,
  listMyPushes,
  openLibraryIdsFor,
  queuePastPushes,
  rejectHardcoverMatch,
  removeHardcoverAccount,
  saveHardcoverAccount,
  saveMatch,
  setHardcoverAccountStatus,
  setSendFinished,
  type HardcoverScope,
} from '@mylib/db'
import { cleanIsbn, DomainError, HardcoverToken, hardcoverEditionIdFromUrl, hardcoverSlugFromUrl, isValidIsbn10, isValidIsbn13, type HardcoverBookPage } from '@mylib/domain'
import { adminProcedure, authedProcedure, router } from '../trpc/init'
import type { Context } from '../trpc/context'

const WorkId = z.object({ workId: z.uuid() })
// a sample ISBN: a household token must also be able to read book data (spec: a missing permission shows now, not at night)
const PROBE_ISBN = '9780141439518'

async function connect(ctx: Context, scope: HardcoverScope, token: string) {
  const client = ctx.hardcover(token)
  const me = await client.me()
  if (!me.ok) throw new DomainError('INVALID', me.error.message)
  if (scope.kind === 'household') {
    const probe = await client.editionsByIsbn([PROBE_ISBN])
    if (!probe.ok) throw new DomainError('INVALID', probe.error.message)
  }
  return saveHardcoverAccount(ctx.db, ctx.secrets, scope, { token, hardcoverUserId: me.value.id, username: me.value.username, now: ctx.now() })
}

async function retest(ctx: Context, scope: HardcoverScope) {
  const account = await getHardcoverAccountWithToken(ctx.db, ctx.secrets, scope)
  if (!account) throw new DomainError('INVALID', 'No Hardcover token is saved')
  const me = await ctx.hardcover(account.token).me()
  const status = me.ok ? 'ok' : me.error.kind === 'missing_scope' ? 'missing_scope' : me.error.kind === 'unauthorized' ? 'needs_token' : account.status
  await setHardcoverAccountStatus(ctx.db, account.id, status, me.ok ? null : me.error.message, ctx.now())
  return getHardcoverAccount(ctx.db, scope)
}

/** a Hardcover failure as the message the dialog shows */
function hardcoverFailure(error: HardcoverError): DomainError {
  if (error.kind === 'rate_limited') return new DomainError('INVALID', 'Hardcover is busy — try again in a minute')
  if (error.kind === 'unauthorized' || error.kind === 'missing_scope') return new DomainError('INVALID', 'Hardcover needs a new household token — an admin can add one in Admin → Hardcover')
  return new DomainError('INVALID', error.message)
}

/** a book's page (null = no such book) with the household client */
export async function readBookPage(ctx: Context, ref: { id: number } | { slug: string }): Promise<HardcoverBookPage> {
  const found = await (await householdClient(ctx)).bookPage(ref)
  if (!found.ok) throw hardcoverFailure(found.error)
  if (found.value === null) throw new DomainError('INVALID', 'Hardcover has no such book')
  return found.value
}

/** household data is only ever fetched with the household token, never a personal one */
export async function householdClient(ctx: Context): Promise<HardcoverClient> {
  const account = await getHardcoverAccountWithToken(ctx.db, ctx.secrets, { kind: 'household' })
  if (!account) throw new DomainError('INVALID', 'Hardcover is not set up — an admin adds a token in Admin → Hardcover')
  return ctx.hardcover(account.token)
}

const mineScope = (ctx: { user: { id: string } }): HardcoverScope => ({ kind: 'user', userId: ctx.user.id })

export const hardcoverRouter = router({
  admin: router({
    get: adminProcedure.query(async ({ ctx }) => ({
      account: await getHardcoverAccount(ctx.db, { kind: 'household' }),
      lastRefresh: await lastHardcoverRun(ctx.db, 'refresh'),
      lastSend: await lastHardcoverRun(ctx.db, 'send'),
    })),
    setToken: adminProcedure.input(z.object({ token: HardcoverToken })).mutation(({ ctx, input }) => connect(ctx, { kind: 'household' }, input.token)),
    test: adminProcedure.mutation(({ ctx }) => retest(ctx, { kind: 'household' })),
    remove: adminProcedure.mutation(({ ctx }) => removeHardcoverAccount(ctx.db, { kind: 'household' })),
    refreshNow: adminProcedure.mutation(async ({ ctx }) => {
      // the job skips quietly without a working household token: say so here instead
      const account = await getHardcoverAccount(ctx.db, { kind: 'household' })
      if (account === null) throw new DomainError('INVALID', 'No household token — add one first')
      if (account.status !== 'ok') throw new DomainError('INVALID', 'Needs a new token — save a new household token first')
      return ctx.jobs.enqueueHardcover({ kind: 'refresh', trigger: 'manual', requestedBy: ctx.user.id })
    }),
  }),
  mine: router({
    get: authedProcedure.query(async ({ ctx }) => ({ account: await getHardcoverAccount(ctx.db, mineScope(ctx)) })),
    setToken: authedProcedure.input(z.object({ token: HardcoverToken })).mutation(({ ctx, input }) => connect(ctx, mineScope(ctx), input.token)),
    test: authedProcedure.mutation(({ ctx }) => retest(ctx, mineScope(ctx))),
    remove: authedProcedure.mutation(({ ctx }) => removeHardcoverAccount(ctx.db, mineScope(ctx))),
    setSend: authedProcedure.input(z.object({ on: z.boolean() })).mutation(({ ctx, input }) => setSendFinished(ctx.db, ctx.user.id, input.on, ctx.now())),
    pushes: authedProcedure.query(({ ctx }) => listMyPushes(ctx.db, ctx.scope, 20)),
    pushCounts: authedProcedure.query(({ ctx }) => countMyPushes(ctx.db, ctx.user.id)),
    /** what "Send my past reads" would queue (#140) */
    pastReads: authedProcedure.query(({ ctx }) => countPastPushes(ctx.db, ctx.user.id)),
    sendPast: authedProcedure.mutation(async ({ ctx }) => {
      const account = await getHardcoverAccount(ctx.db, mineScope(ctx))
      if (account === null) throw new DomainError('INVALID', 'Link your Hardcover account first')
      if (account.status !== 'ok') throw new DomainError('INVALID', 'Needs a new token — save a new Hardcover token first')
      if (!account.sendFinished) throw new DomainError('INVALID', 'Turn on “Send books I finish to Hardcover” first')
      const queued = await queuePastPushes(ctx.db, ctx.user.id)
      // the first run's worth goes out now; the rest follow with the hourly send
      if (queued > 0) await ctx.jobs.enqueueHardcover({ kind: 'send', trigger: 'manual', requestedBy: ctx.user.id })
      return { queued }
    }),
  }),
  forWork: authedProcedure.input(WorkId).query(async ({ ctx, input }) => {
    if ((await getHardcoverAccount(ctx.db, { kind: 'household' })) === null) return { enabled: false, view: null }
    return { enabled: true, view: await getHardcoverForWork(ctx.db, ctx.scope, input.workId) }
  }),
  reject: authedProcedure.input(WorkId).mutation(({ ctx, input }) => rejectHardcoverMatch(ctx.db, ctx.scope, input.workId)),
  available: authedProcedure.query(async ({ ctx }) => ({ enabled: (await getHardcoverAccount(ctx.db, { kind: 'household' })) !== null })),
  // Fetch metadata (#146): a valid ISBN goes straight to its page, anything else is a text search
  lookup: authedProcedure.input(z.object({ query: z.string().trim().min(1).max(300) })).mutation(async ({ ctx, input }) => {
    const client = await householdClient(ctx)
    const isbn = cleanIsbn(input.query)
    if (isValidIsbn13(isbn) || isValidIsbn10(isbn)) {
      const hit = await client.editionsByIsbn([isbn])
      if (!hit.ok) throw hardcoverFailure(hit.error)
      const edition = hit.value[0]
      if (edition !== undefined) {
        const book = await readBookPage(ctx, { id: edition.bookId })
        return { kind: 'page' as const, page: hardcoverPage(book, edition.editionId), editionId: edition.editionId }
      }
    }
    const found = await client.searchBooks(input.query)
    if (!found.ok) throw hardcoverFailure(found.error)
    return { kind: 'results' as const, results: found.value }
  }),
  // the version picker: a mutation, so it runs only when pressed
  versions: authedProcedure.input(z.object({ hardcoverId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const book = await readBookPage(ctx, { id: input.hardcoverId })
    return { mainEditionId: book.mainEditionId, editions: book.editions }
  }),
  page: authedProcedure.input(z.object({ hardcoverId: z.number().int().positive(), editionId: z.number().int().positive().nullable() })).mutation(async ({ ctx, input }) => {
    return hardcoverPage(await readBookPage(ctx, { id: input.hardcoverId }), input.editionId)
  }),
  pageByUrl: authedProcedure.input(z.object({ url: z.string().max(2000) })).mutation(async ({ ctx, input }) => {
    const slug = hardcoverSlugFromUrl(input.url)
    if (slug === null) throw new DomainError('INVALID', 'Paste a link like https://hardcover.app/books/…')
    const editionId = hardcoverEditionIdFromUrl(input.url)
    return { page: hardcoverPage(await readBookPage(ctx, { slug }), editionId), editionId }
  }),
  link: authedProcedure.input(WorkId.extend({ hardcoverId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await getHardcoverForWork(ctx.db, ctx.scope, input.workId)
    const books = await (await householdClient(ctx)).booksById([input.hardcoverId])
    if (!books.ok) throw hardcoverFailure(books.error)
    const book = books.value[0]
    if (book === undefined) throw new DomainError('INVALID', 'Hardcover has no such book')
    await saveMatch(ctx.db, input.workId, { kind: 'manual', book }, ctx.now())
  }),
  // Fetch metadata's Hardcover prefill: the original's title for a translated book Open Library knows, else the book's own
  suggestQuery: authedProcedure.input(WorkId).query(async ({ ctx, input }) => {
    const work = await getWorkDetail(ctx.db, ctx.scope, input.workId)
    const olId = (await openLibraryIdsFor(ctx.db, [input.workId])).get(input.workId)
    if (olId !== undefined) {
      const original = await openLibraryWork(ctx.http, olId, await cachedCapture(ctx.db, 'openlibrary', olId))
      if (original !== null) return { query: `${original.title} ${original.authors[0] ?? ''}`.trim(), from: 'openlibrary' as const }
    }
    return { query: `${work.title} ${work.authors[0]?.name ?? ''}`.trim(), from: 'book' as const }
  }),
})
