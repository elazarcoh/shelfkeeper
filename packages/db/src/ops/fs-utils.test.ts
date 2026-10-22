import { DrizzleQueryError } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { crashLogLine, describeError } from './fs-utils'

describe('describeError (#5: no query parameters in a log or a stored failure)', () => {
  it('keeps the SQL and the database reason of a failed query, never its parameters', () => {
    const cause = new Error('duplicate key value violates unique constraint "users_email_key"')
    const error = new DrizzleQueryError('insert into "users" ("email", "password_hash") values ($1, $2)', ['kid@example.com', 'hunter2'], cause)
    const line = describeError(error)
    expect(line).toBe('Failed query: insert into "users" ("email", "password_hash") values ($1, $2) (duplicate key value violates unique constraint "users_email_key")')
    expect(line).not.toMatch(/kid@example\.com|hunter2|params/)
  })

  it('redacts a params tail in any other message', () => {
    const line = describeError(new Error('Failed query: select 1\nparams: hunter2,kid@example.com'))
    expect(line).toBe('Failed query: select 1 params: [redacted]')
  })

  it('leaves an ordinary message as one trimmed line', () => {
    expect(describeError(new Error('  queue\n is down '))).toBe('queue is down')
    expect(describeError('plain')).toBe('plain')
  })
})

describe('crashLogLine (3d Task 7: the server and worker uncaughtException handlers)', () => {
  it('names the error, its code and the origin, in one short line without a stack', () => {
    const error = Object.assign(new TypeError('Cannot read properties of null\n  (reading write)'), { code: 'ERR_X' })
    const line = crashLogLine('server', error, 'uncaughtException')
    expect(line).toBe('[server] uncaught exception (TypeError ERR_X), exiting: Cannot read properties of null (reading write)')
    expect(line).not.toContain('\n')
  })

  it('labels an unhandled rejection as one', () => {
    expect(crashLogLine('worker', new Error('boom'), 'unhandledRejection')).toBe('[worker] unhandled rejection (Error), exiting: boom')
  })

  it('never throws on a value that is not an Error', () => {
    expect(crashLogLine('server', null, 'uncaughtException')).toBe('[server] uncaught exception (object), exiting: null')
    expect(crashLogLine('server', undefined, 'unhandledRejection')).toBe('[server] unhandled rejection (undefined), exiting: undefined')
    expect(crashLogLine('worker', { code: 42 }, 'uncaughtException')).toBe('[worker] uncaught exception (object), exiting: [object Object]')
  })
})
