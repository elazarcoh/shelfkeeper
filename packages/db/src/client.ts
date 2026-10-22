import type { PgDatabase } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

/** A database handle. Transactions (`tx`) are also `Db`, so repositories accept either. */
export type Db = PgDatabase<PostgresJsQueryResultHKT>

export interface DbHandle {
  db: Db
  /**
   * Ends the pool, waiting for queries in flight. With `timeoutSeconds`, whatever is still open after that
   * is destroyed. 3d item 6: unpatched postgres.js 3.4.9 never settles a graceful end once a connection
   * closed under a running query. patches/postgres@3.4.9.patch fixes that (3d Task 7); a close on the
   * start-up, restore or shutdown path still passes a limit, as defence in depth.
   */
  close: (timeoutSeconds?: number) => Promise<void>
}

/** 3d item 6: the time limit for the short-lived handles the ops code opens and closes. */
export const OPS_CLOSE_TIMEOUT_SECONDS = 5

export function createDb(url: string, options: { max?: number } = {}): DbHandle {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => undefined })
  return { db: drizzle(client), close: (timeoutSeconds) => client.end(timeoutSeconds === undefined ? {} : { timeout: timeoutSeconds }) }
}
