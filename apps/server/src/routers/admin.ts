import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  addPersonName,
  addSeriesName,
  assignSetToUser,
  createUser,
  deleteEmptySeries,
  deletePerson,
  dismissKindSuggestion,
  finishAbsPushRun,
  getAbsPushFields,
  getAbsPushRun,
  deleteSessionsForUser,
  getPerson,
  getSeriesAdmin,
  getUser,
  healthCounts,
  hideSetFromUser,
  hideWorkFromUser,
  ignoreHealth,
  lastAbsPushRun,
  listAbsOutOfSync,
  listGlobalSets,
  listHealth,
  listHiddenForUser,
  listPeople,
  listSeriesAdmin,
  listUserSetAssignments,
  listUsers,
  listVolumeCatalog,
  makeNamePrimary,
  makeSeriesNamePrimary,
  mergeAsVolumes,
  mergePeople,
  mergeSeries,
  removePersonName,
  removeSeriesName,
  renameSeriesName,
  setAbsPushFields,
  setNameLanguage,
  setSeriesNameLanguage,
  setPasswordHash,
  setPinHash,
  splitOffName,
  startAbsPushRun,
  splitSeriesName,
  unhideSetFromUser,
  unhideWorkFromUser,
  unignoreHealth,
  updateUser,
} from '@mylib/db'
import { AbsPushFieldsInput, AbsPushSendInput, AddNameInput, AddSeriesNameInput, ListSeriesAdminInput, MergeSeriesInput, RenameSeriesNameInput, SeriesIdInput, SeriesNameIdInput, SetSeriesNameLanguageInput, SplitSeriesNameInput, CreateUserInput, HealthCountsInput, HealthIgnoreInput, HealthListInput, HealthSeriesInput, ListPeopleInput, MergePeopleInput, MergeVolumesInput, NameIdInput, Password, PersonIdInput, Pin, SetNameLanguageInput, SplitOffNameInput, UpdateUserInput } from '@mylib/domain'
import { hashSecret } from '../auth/password'
import { adminProcedure, router } from '../trpc/init'

const UserId = z.object({ userId: z.uuid() })
const UserWork = z.object({ userId: z.uuid(), workId: z.uuid() })
const UserSet = z.object({ userId: z.uuid(), setId: z.uuid() })

const usersRouter = router({
  list: adminProcedure.query(({ ctx }) => listUsers(ctx.db)),
  get: adminProcedure.input(UserId).query(async ({ ctx, input }) => {
    const user = await getUser(ctx.db, input.userId)
    if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' })
    return user
  }),
  create: adminProcedure.input(CreateUserInput).mutation(async ({ ctx, input }) =>
    createUser(ctx.db, {
      username: input.username,
      displayName: input.displayName,
      role: input.role,
      passwordHash: await hashSecret(input.password),
    }),
  ),
  update: adminProcedure
    .input(z.object({ userId: z.uuid(), patch: UpdateUserInput }))
    .mutation(({ ctx, input }) => updateUser(ctx.db, input.userId, input.patch)),
  resetPassword: adminProcedure
    .input(z.object({ userId: z.uuid(), password: Password }))
    .mutation(async ({ ctx, input }) => {
      await setPasswordHash(ctx.db, input.userId, await hashSecret(input.password))
      await deleteSessionsForUser(ctx.db, input.userId)
    }),
  setPin: adminProcedure
    .input(z.object({ userId: z.uuid(), pin: Pin.nullable() }))
    .mutation(async ({ ctx, input }) => {
      await setPinHash(ctx.db, input.userId, input.pin === null ? null : await hashSecret(input.pin))
    }),
  setAssignments: adminProcedure
    .input(UserId)
    .query(({ ctx, input }) => listUserSetAssignments(ctx.db, ctx.scope, input.userId)),
  assignSet: adminProcedure
    .input(z.object({ userId: z.uuid(), setId: z.uuid(), assigned: z.boolean() }))
    .mutation(({ ctx, input }) => assignSetToUser(ctx.db, ctx.scope, input.userId, input.setId, input.assigned)),
  hidden: adminProcedure.input(UserId).query(({ ctx, input }) => listHiddenForUser(ctx.db, ctx.scope, input.userId)),
  hideWork: adminProcedure
    .input(UserWork)
    .mutation(({ ctx, input }) => hideWorkFromUser(ctx.db, ctx.scope, input.userId, input.workId)),
  unhideWork: adminProcedure
    .input(UserWork)
    .mutation(({ ctx, input }) => unhideWorkFromUser(ctx.db, ctx.scope, input.userId, input.workId)),
  hideSet: adminProcedure
    .input(UserSet)
    .mutation(({ ctx, input }) => hideSetFromUser(ctx.db, ctx.scope, input.userId, input.setId)),
  unhideSet: adminProcedure
    .input(UserSet)
    .mutation(({ ctx, input }) => unhideSetFromUser(ctx.db, ctx.scope, input.userId, input.setId)),
})

export const adminRouter = router({
  users: usersRouter,
  sets: router({
    list: adminProcedure.query(({ ctx }) => listGlobalSets(ctx.db, ctx.scope)),
  }),
  volumes: router({
    catalog: adminProcedure.query(({ ctx }) => listVolumeCatalog(ctx.db, ctx.scope)),
    merge: adminProcedure.input(MergeVolumesInput).mutation(({ ctx, input }) => mergeAsVolumes(ctx.db, ctx.scope, input)),
  }),
  health: router({
    counts: adminProcedure.input(HealthCountsInput).query(({ ctx, input }) => healthCounts(ctx.db, input)),
    list: adminProcedure.input(HealthListInput).query(({ ctx, input }) => listHealth(ctx.db, input)),
    ignore: adminProcedure.input(HealthIgnoreInput).mutation(({ ctx, input }) => ignoreHealth(ctx.db, ctx.scope.userId, input)),
    unignore: adminProcedure.input(HealthIgnoreInput).mutation(({ ctx, input }) => unignoreHealth(ctx.db, input)),
    dismissKind: adminProcedure.input(z.object({ workId: z.uuid() })).mutation(({ ctx, input }) => dismissKindSuggestion(ctx.db, ctx.scope, input.workId)),
    deleteEmptySeries: adminProcedure.input(HealthSeriesInput).mutation(({ ctx, input }) => deleteEmptySeries(ctx.db, input.seriesId)),
  }),
  absPush: router({
    list: adminProcedure.input(z.object({ showIgnored: z.boolean() })).query(async ({ ctx, input }) => {
      const [out, fields, run] = await Promise.all([listAbsOutOfSync(ctx.db, input), getAbsPushFields(ctx.db, ctx.user.id), lastAbsPushRun(ctx.db)])
      return { ...out, fields, run }
    }),
    setFields: adminProcedure.input(AbsPushFieldsInput).mutation(({ ctx, input }) => setAbsPushFields(ctx.db, ctx.user.id, input.fields)),
    send: adminProcedure.input(AbsPushSendInput).mutation(async ({ ctx, input }) => {
      const runId = await startAbsPushRun(ctx.db, ctx.user.id, input.books)
      if (runId === null) throw new TRPCError({ code: 'CONFLICT', message: 'A send is already running' })
      try {
        await ctx.jobs.enqueueAbsPush({ runId })
      } catch (error) {
        // a run nobody will pick up would hold the one-running slot forever
        await finishAbsPushRun(ctx.db, runId, 'failed', error instanceof Error ? error.message : String(error))
        throw error
      }
      return { runId }
    }),
    run: adminProcedure.input(z.object({ runId: z.uuid() })).query(async ({ ctx, input }) => {
      const run = await getAbsPushRun(ctx.db, input.runId)
      if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Run not found' })
      return run
    }),
  }),
  people: router({
    list: adminProcedure.input(ListPeopleInput).query(({ ctx, input }) => listPeople(ctx.db, ctx.scope, input)),
    get: adminProcedure.input(PersonIdInput).query(({ ctx, input }) => getPerson(ctx.db, ctx.scope, input.personId)),
    merge: adminProcedure.input(MergePeopleInput).mutation(({ ctx, input }) => mergePeople(ctx.db, ctx.scope, input)),
    splitOff: adminProcedure.input(SplitOffNameInput).mutation(({ ctx, input }) => splitOffName(ctx.db, ctx.scope, input)),
    addName: adminProcedure.input(AddNameInput).mutation(({ ctx, input }) => addPersonName(ctx.db, ctx.scope, input)),
    setLanguage: adminProcedure.input(SetNameLanguageInput).mutation(({ ctx, input }) => setNameLanguage(ctx.db, ctx.scope, input)),
    makePrimary: adminProcedure.input(NameIdInput).mutation(({ ctx, input }) => makeNamePrimary(ctx.db, ctx.scope, input.nameId)),
    removeName: adminProcedure.input(NameIdInput).mutation(({ ctx, input }) => removePersonName(ctx.db, ctx.scope, input.nameId)),
    delete: adminProcedure.input(PersonIdInput).mutation(({ ctx, input }) => deletePerson(ctx.db, ctx.scope, input.personId)),
  }),
  series: router({
    list: adminProcedure.input(ListSeriesAdminInput).query(({ ctx, input }) => listSeriesAdmin(ctx.db, ctx.scope, input)),
    get: adminProcedure.input(SeriesIdInput).query(({ ctx, input }) => getSeriesAdmin(ctx.db, ctx.scope, input.seriesId)),
    merge: adminProcedure.input(MergeSeriesInput).mutation(({ ctx, input }) => mergeSeries(ctx.db, ctx.scope, input)),
    split: adminProcedure.input(SplitSeriesNameInput).mutation(({ ctx, input }) => splitSeriesName(ctx.db, ctx.scope, input)),
    addName: adminProcedure.input(AddSeriesNameInput).mutation(({ ctx, input }) => addSeriesName(ctx.db, ctx.scope, input)),
    renameName: adminProcedure.input(RenameSeriesNameInput).mutation(({ ctx, input }) => renameSeriesName(ctx.db, ctx.scope, input)),
    setLanguage: adminProcedure.input(SetSeriesNameLanguageInput).mutation(({ ctx, input }) => setSeriesNameLanguage(ctx.db, ctx.scope, input)),
    makePrimary: adminProcedure.input(SeriesNameIdInput).mutation(({ ctx, input }) => makeSeriesNamePrimary(ctx.db, ctx.scope, input.nameId)),
    removeName: adminProcedure.input(SeriesNameIdInput).mutation(({ ctx, input }) => removeSeriesName(ctx.db, ctx.scope, input.nameId)),
  }),
})
