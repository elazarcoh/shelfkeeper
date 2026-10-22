import { z } from 'zod'
import {
  addEdition,
  addWorkTitle,
  addWorkToSet,
  assertVisibleEdition,
  changeHolding,
  createWork,
  deleteEdition,
  deleteWork,
  getDefaultPersonalSetId,
  getWorkDetail,
  listFacets,
  listSuggestions,
  makeTitlePrimary,
  mergeWorks,
  removeWorkTitle,
  setSeriesKind,
  setEditionCover,
  splitEdition,
  updateEdition,
  updateWork,
  updateWorkTitle,
} from '@mylib/db'
import { AddWorkTitleInput, CreateWorkInput, DomainError, EditionInput, EditionPatch, HoldingChange, isAllowedCoverRedirect, isAllowedCoverUrl, RemoveWorkTitleInput, sniffImage, TitleIdInput, UpdateWorkTitleInput, WorkKind, WorkPatch } from '@mylib/domain'
import { authedProcedure, router } from '../trpc/init'

const WorkId = z.object({ workId: z.uuid() })
const EditionId = z.object({ editionId: z.uuid() })

export const catalogRouter = router({
  get: authedProcedure.input(WorkId).query(({ ctx, input }) => getWorkDetail(ctx.db, ctx.scope, input.workId)),

  facets: authedProcedure.query(({ ctx }) => listFacets(ctx.db, ctx.scope)),

  suggestions: authedProcedure.query(({ ctx }) => listSuggestions(ctx.db, ctx.scope)),

  create: authedProcedure
    .input(z.object({ work: CreateWorkInput, addToMyBooks: z.boolean().default(true) }))
    .mutation(({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const workId = await createWork(tx, input.work, ctx.user.id)
        if (input.addToMyBooks) {
          await addWorkToSet(tx, ctx.scope, await getDefaultPersonalSetId(tx, ctx.scope.userId), workId)
        }
        return { workId }
      }),
    ),

  update: authedProcedure
    .input(z.object({ workId: z.uuid(), patch: WorkPatch }))
    .mutation(({ ctx, input }) => updateWork(ctx.db, ctx.scope, input.workId, input.patch)),

  titles: router({
    add: authedProcedure.input(AddWorkTitleInput).mutation(({ ctx, input }) => addWorkTitle(ctx.db, ctx.scope, input)),
    update: authedProcedure.input(UpdateWorkTitleInput).mutation(({ ctx, input }) => updateWorkTitle(ctx.db, ctx.scope, input)),
    remove: authedProcedure.input(RemoveWorkTitleInput).mutation(({ ctx, input }) => removeWorkTitle(ctx.db, ctx.scope, input)),
    makePrimary: authedProcedure.input(TitleIdInput).mutation(({ ctx, input }) => makeTitlePrimary(ctx.db, ctx.scope, input)),
  }),

  setSeriesKind: authedProcedure
    .input(z.object({ seriesId: z.uuid(), kind: WorkKind }))
    .mutation(({ ctx, input }) => setSeriesKind(ctx.db, ctx.scope, input.seriesId, input.kind)),

  addEdition: authedProcedure
    .input(z.object({ workId: z.uuid(), edition: EditionInput, addToMyBooks: z.boolean().default(false) }))
    .mutation(({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const editionId = await addEdition(tx, ctx.scope, input.workId, input.edition)
        if (input.addToMyBooks) {
          await addWorkToSet(tx, ctx.scope, await getDefaultPersonalSetId(tx, ctx.scope.userId), input.workId)
        }
        return { editionId }
      }),
    ),

  updateEdition: authedProcedure
    .input(z.object({ editionId: z.uuid(), patch: EditionPatch }))
    .mutation(({ ctx, input }) => updateEdition(ctx.db, ctx.scope, input.editionId, input.patch)),

  // a cover the person picked on a book page: only from a book site's own image host, one download per press
  setCoverFromPage: authedProcedure
    .input(z.object({ editionId: z.uuid(), coverUrl: z.string().max(2000) }))
    .mutation(async ({ ctx, input }) => {
      if (!isAllowedCoverUrl(input.coverUrl)) throw new DomainError('INVALID', 'That cover is not from a book site My Library knows')
      await assertVisibleEdition(ctx.db, ctx.scope, input.editionId)
      const fetched = await ctx.http.getBytes(input.coverUrl, {}, undefined, isAllowedCoverRedirect)
      const kind = fetched.ok ? sniffImage(fetched.value.bytes) : null
      if (!fetched.ok || kind === null) throw new DomainError('INVALID', "The cover couldn't be downloaded — try again in a minute")
      const stored = await ctx.assets.put(fetched.value.bytes, kind.ext)
      await setEditionCover(ctx.db, ctx.scope, input.editionId, { ...stored, mime: kind.mime })
    }),

  // a cover the person chose from a file or pasted (#100); the page shrinks it first, so 4 MB is plenty
  uploadCover: authedProcedure
    .input(z.object({ editionId: z.uuid(), imageBase64: z.base64().max(4 * 1024 * 1024) }))
    .mutation(async ({ ctx, input }) => {
      await assertVisibleEdition(ctx.db, ctx.scope, input.editionId)
      const bytes = new Uint8Array(Buffer.from(input.imageBase64, 'base64'))
      const kind = sniffImage(bytes)
      if (kind === null) throw new DomainError('INVALID', 'That file is not a JPEG, PNG, GIF or WebP picture')
      const stored = await ctx.assets.put(bytes, kind.ext)
      await setEditionCover(ctx.db, ctx.scope, input.editionId, { ...stored, mime: kind.mime })
    }),

  // a picture from an address someone typed, for the page to shrink and send back with uploadCover; nothing is stored here
  fetchCoverUrl: authedProcedure
    .input(z.object({ url: z.string().max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const fetched = await ctx.fetchImage(input.url)
      if (!fetched.ok) throw new DomainError('INVALID', fetched.error)
      return { mime: fetched.value.kind.mime, imageBase64: Buffer.from(fetched.value.bytes).toString('base64') }
    }),

  changeHolding: authedProcedure
    .input(z.object({ editionId: z.uuid(), change: HoldingChange }))
    .mutation(({ ctx, input }) => changeHolding(ctx.db, ctx.scope, input.editionId, input.change)),

  deleteEdition: authedProcedure
    .input(EditionId)
    .mutation(({ ctx, input }) => deleteEdition(ctx.db, ctx.scope, input.editionId)),

  splitEdition: authedProcedure
    .input(EditionId)
    .mutation(async ({ ctx, input }) => ({ workId: await splitEdition(ctx.db, ctx.scope, input.editionId) })),

  mergeWorks: authedProcedure
    .input(z.object({ targetWorkId: z.uuid(), sourceWorkIds: z.array(z.uuid()).min(1).max(20) }))
    .mutation(({ ctx, input }) => mergeWorks(ctx.db, ctx.scope, input.targetWorkId, input.sourceWorkIds)),

  delete: authedProcedure.input(WorkId).mutation(({ ctx, input }) => deleteWork(ctx.db, ctx.scope, input.workId)),
})
