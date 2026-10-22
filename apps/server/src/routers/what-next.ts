import { z } from 'zod'
import {
  getWhatNext,
  hidePick,
  listAuthorFollows,
  promptInputFor,
  readTitlesFor,
  saveAiAnswer,
  saveWhatNextFormat,
  setAuthorFollow,
  unhidePick,
  wishedTitles,
  wishFromPick,
} from '@mylib/db'
import { AiPick, buildWhatNextPrompt, DomainError, parseWhatNextAnswer, sameTitleAndAuthor, SHELF_MAX_ANSWER, whatNextFormats, whatNextMoods } from '@mylib/domain'
import { authedProcedure, router } from '../trpc/init'

const Mood = z.enum(whatNextMoods)
const Format = z.enum(whatNextFormats)
const Today = z.iso.date()
const Author = z.union([z.object({ contributorId: z.uuid() }), z.object({ hardcoverAuthorId: z.number().int().positive(), name: z.string().trim().min(1).max(300) })])
const Wish = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hardcover'), hardcoverId: z.number().int().positive(), reason: z.string().trim().min(1).max(1000).optional() }),
  z.object({ kind: z.literal('ai'), pick: AiPick }),
])

// every procedure reads only what the household's sync already cached: nothing here calls Hardcover
export const whatNextRouter = router({
  get: authedProcedure
    .input(z.object({ mood: Mood.nullable(), format: Format.nullable(), today: Today }))
    .query(({ ctx, input }) => getWhatNext(ctx.db, ctx.scope, input)),
  prompt: authedProcedure
    .input(z.object({ mood: Mood, format: Format, today: Today }))
    .query(async ({ ctx, input }) => ({ prompt: buildWhatNextPrompt(await promptInputFor(ctx.db, ctx.scope, input.mood, input.format, input.today)) })),
  parseAnswer: authedProcedure.input(z.object({ text: z.string().max(SHELF_MAX_ANSWER), save: z.boolean().default(true) })).mutation(async ({ ctx, input }) => {
    const parsed = parseWhatNextAnswer(input.text, await readTitlesFor(ctx.db, ctx.scope))
    if (!parsed.ok) throw new DomainError('INVALID', parsed.error)
    // opening the page reads the saved answer again without writing it (save: false)
    if (input.save) await saveAiAnswer(ctx.db, ctx.scope, input.text, ctx.now())
    const wished = await wishedTitles(ctx.db, ctx.scope)
    return { picks: parsed.value.picks.map((pick) => ({ ...pick, onWishlist: wished.some((w) => sameTitleAndAuthor(w, { title: pick.title, authors: pick.authors })) })), alreadyRead: parsed.value.alreadyRead, unusable: parsed.value.unusable }
  }),
  clearAnswer: authedProcedure.mutation(({ ctx }) => saveAiAnswer(ctx.db, ctx.scope, null, ctx.now())),
  hide: authedProcedure.input(z.object({ key: z.string().min(1).max(300) })).mutation(({ ctx, input }) => hidePick(ctx.db, ctx.scope, input.key)),
  unhide: authedProcedure.input(z.object({ key: z.string().min(1).max(300) })).mutation(({ ctx, input }) => unhidePick(ctx.db, ctx.scope, input.key)),
  follow: authedProcedure
    .input(z.object({ author: Author, mode: z.enum(['follow', 'unfollow']).nullable() }))
    .mutation(({ ctx, input }) => setAuthorFollow(ctx.db, ctx.scope, input.author, input.mode)),
  follows: authedProcedure.query(({ ctx }) => listAuthorFollows(ctx.db, ctx.scope)),
  setFormat: authedProcedure.input(z.object({ format: Format })).mutation(({ ctx, input }) => saveWhatNextFormat(ctx.db, ctx.scope, input.format)),
  wish: authedProcedure.input(Wish).mutation(({ ctx, input }) => {
    if (input.kind === 'ai') return wishFromPick(ctx.db, ctx.scope, input)
    const { reason, ...rest } = input
    return wishFromPick(ctx.db, ctx.scope, reason === undefined ? rest : { ...rest, reason })
  }),
})
