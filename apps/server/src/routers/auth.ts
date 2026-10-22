import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  countUsers,
  createFirstAdmin,
  createSession,
  deleteSession,
  deleteSessionsForUser,
  findUserForLogin,
  setPasswordHash,
  updateUser,
} from '@mylib/db'
import { DisplayName, LoginInput, Password, PinLoginInput, SetupInput, TitleLanguages } from '@mylib/domain'
import { clearSessionCookie, sessionCookie } from '../auth/cookies'
import { dummyHash, hashSecret, verifySecret } from '../auth/password'
import { newSessionToken, sessionIdFromToken } from '../auth/session-token'
import type { Context } from '../trpc/context'
import { authedProcedure, publicProcedure, router } from '../trpc/init'

const INVALID_LOGIN = 'Invalid username or password'

async function startSession(ctx: Context, userId: string): Promise<void> {
  const token = newSessionToken()
  const ttlSec = ctx.config.sessionTtlDays * 86_400
  await createSession(ctx.db, {
    id: sessionIdFromToken(token),
    userId,
    expiresAt: new Date(ctx.now().getTime() + ttlSec * 1000),
  })
  ctx.resHeaders.append('Set-Cookie', sessionCookie(token, ttlSec, ctx.config.cookieSecure, ctx.config.basePath || '/'))
}

async function checkCredentials(ctx: Context, username: string, secret: string, kind: 'password' | 'pin') {
  // Claimed synchronously before any await, so concurrent (e.g. batched) guesses count against the limit.
  if (!ctx.throttle.attempt(username)) {
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many attempts — try again in 15 minutes' })
  }
  const found = await findUserForLogin(ctx.db, username)
  const stored = kind === 'password' ? found?.passwordHash : found?.pinHash
  const ok = await verifySecret(secret, stored ?? (await dummyHash()))
  if (!found || !stored || !ok) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: INVALID_LOGIN })
  }
  ctx.throttle.reset(username)
  return found.user
}

export const authRouter = router({
  status: publicProcedure.query(async ({ ctx }) => ({
    needsSetup: (await countUsers(ctx.db)) === 0,
    user: ctx.user,
  })),

  setup: publicProcedure.input(SetupInput).mutation(async ({ ctx, input }) => {
    const user = await createFirstAdmin(ctx.db, {
      username: input.username,
      displayName: input.displayName,
      passwordHash: await hashSecret(input.password),
    })
    if (!user) throw new TRPCError({ code: 'CONFLICT', message: 'Setup is already complete' })
    await startSession(ctx, user.id)
    return user
  }),

  login: publicProcedure.input(LoginInput).mutation(async ({ ctx, input }) => {
    const user = await checkCredentials(ctx, input.username, input.password, 'password')
    await startSession(ctx, user.id)
    return user
  }),

  loginPin: publicProcedure.input(PinLoginInput).mutation(async ({ ctx, input }) => {
    const user = await checkCredentials(ctx, input.username, input.pin, 'pin')
    await startSession(ctx, user.id)
    return user
  }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    if (ctx.sessionId !== null) await deleteSession(ctx.db, ctx.sessionId)
    ctx.resHeaders.append('Set-Cookie', clearSessionCookie(ctx.config.cookieSecure, ctx.config.basePath || '/'))
    return { ok: true }
  }),

  updateMe: authedProcedure
    .input(
      z
        .object({ displayName: DisplayName.optional(), shareActivity: z.boolean().optional(), titleLanguages: TitleLanguages.optional() })
        .refine((p) => Object.values(p).some((v) => v !== undefined), 'Nothing to update'),
    )
    .mutation(({ ctx, input }) => updateUser(ctx.db, ctx.user.id, input)),

  changePassword: authedProcedure
    .input(z.object({ current: z.string().min(1).max(200), next: Password }))
    .mutation(async ({ ctx, input }) => {
      await checkCredentials(ctx, ctx.user.username, input.current, 'password')
      await setPasswordHash(ctx.db, ctx.user.id, await hashSecret(input.next))
      await deleteSessionsForUser(ctx.db, ctx.user.id)
      await startSession(ctx, ctx.user.id)
      return { ok: true }
    }),
})
