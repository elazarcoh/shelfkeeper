import { z } from 'zod'
import { addWishFromPage, boughtWish, listWishes, removeWish, upsertWish, wishesForWork, wishMembers } from '@mylib/db'
import { DomainError, EditionFormat, extractErrorMessage, extractPage, ItemVolume, PageCapture, WishFields } from '@mylib/domain'
import { authedProcedure, router } from '../trpc/init'

const Target = z.discriminatedUnion('action', [z.object({ action: z.literal('create_work') }), z.object({ action: z.literal('wish_work'), workId: z.uuid() })])
const fieldsOf = (i: { formats: unknown; language: unknown; note: unknown }) => WishFields.parse({ formats: i.formats, language: i.language, note: i.note })

export const wishlistRouter = router({
  addFromPage: authedProcedure.input(WishFields.extend({ capture: PageCapture, target: Target, volume: ItemVolume.nullable().optional() })).mutation(({ ctx, input }) => {
    const page = extractPage(input.capture)
    if (!page.ok) throw new DomainError('INVALID', extractErrorMessage[page.error])
    return addWishFromPage(ctx.db, ctx.scope, { page: input.volume === undefined ? page.value : { ...page.value, volume: input.volume }, target: input.target, fields: fieldsOf(input) })
  }),
  upsert: authedProcedure.input(WishFields.extend({ workId: z.uuid() })).mutation(({ ctx, input }) => upsertWish(ctx.db, ctx.scope, input.workId, fieldsOf(input))),
  remove: authedProcedure.input(z.object({ workId: z.uuid() })).mutation(({ ctx, input }) => removeWish(ctx.db, ctx.scope, input.workId)),
  // never fetches anything itself: the client stores the page cover with catalog.setCoverFromPage (one download per press)
  bought: authedProcedure
    .input(z.object({ workId: z.uuid(), format: EditionFormat, on: z.iso.date(), volume: z.number().int().min(1).max(999).nullable().default(null) }))
    .mutation(({ ctx, input }) => boughtWish(ctx.db, ctx.scope, input.workId, input.format, input.on, input.volume)),
  list: authedProcedure.input(z.object({ userId: z.uuid() })).query(({ ctx, input }) => listWishes(ctx.db, ctx.scope, input.userId)),
  members: authedProcedure.query(({ ctx }) => wishMembers(ctx.db, ctx.scope)),
  forWork: authedProcedure.input(z.object({ workId: z.uuid() })).query(({ ctx, input }) => wishesForWork(ctx.db, ctx.scope, input.workId)),
})
