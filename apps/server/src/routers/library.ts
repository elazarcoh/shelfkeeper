import { z } from 'zod'
import { getWorkCards, listLibrary, listQueueIds, listWorks } from '@mylib/db'
import { LibraryQuery, toOfflineWork, tokenize, type OfflineSnapshot } from '@mylib/domain'
import { authedProcedure, router } from '../trpc/init'

/** Clients can't opt into wanted (no-edition) books: only `search` below does, for the pickers. */
const PublicQuery = LibraryQuery.omit({ includeWanted: true })

const SNAPSHOT_PAGE = 100
/** LibraryQuery's own offset cap */
const SNAPSHOT_MAX = 100_000

export const libraryRouter = router({
  list: authedProcedure.input(PublicQuery).query(({ ctx, input }) => listWorks(ctx.db, ctx.scope, { ...input, includeWanted: false })),

  /** The Library page: works and, with collapseSeries, series cards. `cursor` (infinite scroll) is the offset to start at. */
  browse: authedProcedure
    .input(PublicQuery.extend({ cursor: z.number().int().min(0).max(100_000).nullish() }))
    .query(({ ctx, input: { cursor, ...q } }) => listLibrary(ctx.db, ctx.scope, { ...q, includeWanted: false, offset: cursor ?? q.offset })),

  search: authedProcedure
    .input(z.object({ q: z.string().max(200), limit: z.number().int().min(1).max(20).default(8) }))
    .query(async ({ ctx, input }) => {
      if (tokenize(input.q).length === 0) return { items: [], total: 0 }
      return listWorks(ctx.db, ctx.scope, LibraryQuery.parse({ scope: 'catalog', search: input.q, limit: input.limit, includeWanted: true }))
    }),

  /** #62: every book this person can see (wanted ones too), compact, for the phone's offline copy; 100 a query. */
  snapshot: authedProcedure.query(async ({ ctx }): Promise<OfflineSnapshot> => {
    const at = new Date().toISOString()
    const works: OfflineSnapshot['works'] = []
    for (let offset = 0; offset <= SNAPSHOT_MAX; offset += SNAPSHOT_PAGE) {
      const page = await listWorks(ctx.db, ctx.scope, LibraryQuery.parse({ scope: 'catalog', includeWanted: true, limit: SNAPSHOT_PAGE, offset }))
      works.push(...page.items.map(toOfflineWork))
      if (page.items.length < SNAPSHOT_PAGE) break
    }
    return { at, works }
  }),

  queue: authedProcedure.query(async ({ ctx }) => getWorkCards(ctx.db, ctx.scope, await listQueueIds(ctx.db, ctx.scope))),
})
