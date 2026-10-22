import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import { describeError, loadUserScope } from '@mylib/db'
import { DomainError, type DomainErrorCode } from '@mylib/domain'
import type { Context } from './context'

const t = initTRPC.context<Context>().create({ transformer: superjson })

const codeFor: Record<DomainErrorCode, TRPCError['code']> = {
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  INVALID: 'BAD_REQUEST',
}

const domainErrors = t.middleware(async ({ next }) => {
  const result = await next()
  if (!result.ok && result.error.cause instanceof DomainError) {
    const cause = result.error.cause
    throw new TRPCError({ code: codeFor[cause.code], message: cause.message, cause })
  }
  return result
})

/**
 * Unexpected failures must not echo their message (a database error can hold SQL and parameters), in any route (#5):
 * the client gets a generic 500, the real error goes to the server-side log as one redacted line.
 */
const genericInternalError = t.middleware(async ({ next, path }) => {
  const result = await next()
  if (!result.ok && result.error.code === 'INTERNAL_SERVER_ERROR') {
    const cause = result.error.cause
    // tRPC wraps an unknown throw as INTERNAL_SERVER_ERROR with the original as `cause`. No cause, or a TRPCError or
    // DomainError cause, means the route threw it on purpose: left as it is.
    if (cause !== undefined && !(cause instanceof DomainError) && !(cause instanceof TRPCError)) {
      // the only copy of the real error: one line, no stack
      console.error(`[trpc] ${path} failed:`, describeError(cause))
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong. Please try again.', cause })
    }
  }
  return result
})

export const router = t.router
export const createCallerFactory = t.createCallerFactory
// genericInternalError runs outermost, so it also covers a failure in any middleware below it (the scope lookup)
export const publicProcedure = t.procedure.use(genericInternalError).use(domainErrors)

export const authedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in' })
  const scope = await loadUserScope(ctx.db, ctx.user)
  return next({ ctx: { ...ctx, user: ctx.user, scope } })
})

export const adminProcedure = authedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: 'Admins only' })
  return next()
})
