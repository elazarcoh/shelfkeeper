import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import postgres from 'postgres'
import { z } from 'zod'

/** packages/db/drizzle when running from source; the image sets MIGRATIONS_DIR instead. */
export const defaultMigrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

export interface JournalEntry {
  tag: string
  /** drizzle's folderMillis, stored as __drizzle_migrations.created_at: the migration's id */
  when: number
}

const JournalFileSchema = z.object({
  version: z.string(),
  dialect: z.string(),
  entries: z.array(
    z.object({
      idx: z.number().int().nonnegative(),
      version: z.string(),
      when: z.number().int().positive(),
      tag: z.string().min(1),
      breakpoints: z.boolean(),
    }),
  ),
})

/** Throws a clear error (naming the file) rather than a raw Zod error when drizzle-kit's own journal shape doesn't match. */
export function readJournal(folder: string): JournalEntry[] {
  const journalPath = path.join(folder, 'meta', '_journal.json')
  const raw: unknown = JSON.parse(readFileSync(journalPath, 'utf8'))
  const parsed = JournalFileSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`Malformed migration journal at ${journalPath}: ${parsed.error.message}`)
  return parsed.data.entries.map((e) => ({ tag: e.tag, when: e.when }))
}

export interface MigrationStatus {
  applied: JournalEntry[]
  pending: JournalEntry[]
  /** applied in the database but unknown to this image: the database is newer than the app */
  unknown: number[]
  last: JournalEntry | null
}

export class MigrationFailedError extends Error {
  override readonly name = 'MigrationFailedError'
  constructor(
    readonly tag: string,
    options: { cause: unknown },
  ) {
    super(`Migration ${tag} failed`, options)
  }
}

const client = (url: string, onclose?: () => void) => postgres(url, { max: 1, onnotice: () => undefined, ...(onclose === undefined ? {} : { onclose }) })

/**
 * 3d item 7: unpatched postgres.js 3.4.9 never settles a graceful `end()` once a connection closed under a
 * running query (the query stays "current" for good). patches/postgres@3.4.9.patch fixes that (3d Task 7);
 * these short-lived clients still end with a time limit, as defence in depth.
 */
const END_TIMEOUT_SECONDS = 5

async function appliedWhens(sql: postgres.Sql): Promise<number[]> {
  const [present] = await sql<{ present: boolean }[]>`select to_regclass('drizzle.__drizzle_migrations') is not null as present`
  if (present?.present !== true) return []
  const rows = await sql<{ created_at: string }[]>`select created_at from drizzle.__drizzle_migrations order by created_at`
  return rows.map((r) => Number(r.created_at))
}

function statusFrom(journal: readonly JournalEntry[], whens: readonly number[]): MigrationStatus {
  const known = new Set(journal.map((e) => e.when))
  const lastWhen = whens.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...whens)
  const applied = journal.filter((e) => e.when <= lastWhen)
  return {
    applied,
    // drizzle's rule: everything after the newest applied migration is pending
    pending: journal.filter((e) => e.when > lastWhen),
    unknown: whens.filter((w) => !known.has(w)),
    last: applied.at(-1) ?? null,
  }
}

export async function migrationStatus(url: string, folder: string): Promise<MigrationStatus> {
  const sql = client(url)
  try {
    return statusFrom(readJournal(folder), await appliedWhens(sql))
  } finally {
    await sql.end({ timeout: END_TIMEOUT_SECONDS })
  }
}

/** For the backup manifest: the newest applied migration; one unknown to this image keeps its id with tag "unknown". */
export async function lastAppliedMigration(url: string, folder: string): Promise<{ tag: string; when: number }> {
  const sql = client(url)
  try {
    const whens = await appliedWhens(sql)
    if (whens.length === 0) throw new Error('The database has no migrations applied')
    const when = Math.max(...whens)
    return { tag: readJournal(folder).find((e) => e.when === when)?.tag ?? 'unknown', when }
  } finally {
    await sql.end({ timeout: END_TIMEOUT_SECONDS })
  }
}

/**
 * Applies pending migrations one at a time, each in its own transaction with its bookkeeping row
 * (spec §5), into drizzle's own table, so databases migrated before 3c carry on unchanged. A failure
 * rolls back only that migration and throws MigrationFailedError naming it. `upTo` stops after that
 * tag (tests build older schemas with it). The caller must hold the migration lock (prepareDatabase
 * takes it, in a later task) — this function does not serialize against another instance running it
 * concurrently.
 *
 * 3d item 4: `signal` and `beforeEach` (the lock guard's signal and its live `assertHeld`) are checked
 * before each migration, so none starts once the lock is lost; one already running finishes or rolls
 * back as a whole.
 *
 * 3d item 7: `onApplied` hears each migration as it commits, so a caller whose run fails part-way can say
 * which earlier ones were applied. Each migration runs as BEGIN … COMMIT on a reserved connection rather
 * than through `sql.begin`: when the connection drops mid-migration, unpatched postgres.js 3.4.9's `begin`
 * sends its ROLLBACK to the closed socket, an uncaught TypeError that would crash the process (and its own
 * query never settles). patches/postgres@3.4.9.patch now rejects that ROLLBACK instead (3d Task 7); this
 * path stays because it is tested and sends nothing once the connection has closed. The server rolled the
 * transaction back with the session, so the migration and its bookkeeping row are still all or nothing.
 */
export async function applyMigrations(
  url: string,
  folder: string,
  options: { upTo?: string; signal?: AbortSignal; beforeEach?: () => Promise<void>; onApplied?: (tag: string) => void } = {},
): Promise<string[]> {
  const journal = readJournal(folder)
  // keyed by `when` rather than array position: readMigrationFiles re-parses the same journal file, and
  // every meta.folderMillis it produces IS one of these `when` values, so this lookup cannot miss.
  const tagByWhen = new Map(journal.map((e) => [e.when, e.tag]))
  const stopAt = options.upTo === undefined ? journal.length - 1 : journal.findIndex((e) => e.tag === options.upTo)
  if (stopAt === -1) throw new Error(`Unknown migration ${options.upTo ?? ''}`)
  const metas = readMigrationFiles({ migrationsFolder: folder }).slice(0, stopAt + 1)
  // set by postgres.js once the (only) connection has closed; reset each time a migration reserves one
  const connection = { closed: false }
  const sql = client(url, () => {
    connection.closed = true
  })
  // read through a call: TS would otherwise narrow `connection.closed` to the value last assigned here
  const closedNow = (): boolean => connection.closed
  try {
    await sql`create schema if not exists drizzle`
    await sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`
    const whens = await appliedWhens(sql)
    const lastWhen = whens.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...whens)
    const done: string[] = []
    for (const meta of metas) {
      options.signal?.throwIfAborted()
      if (meta.folderMillis <= lastWhen) continue
      const tag = tagByWhen.get(meta.folderMillis)
      if (tag === undefined) throw new Error(`Migration file at ${meta.folderMillis} is not listed in the journal`)
      await options.beforeEach?.()
      const tx = await sql.reserve()
      connection.closed = false
      const send = async (statement: string, parameters: postgres.ParameterOrJSON<never>[] = []): Promise<void> => {
        if (closedNow()) throw Object.assign(new Error('The database connection closed during the migration'), { code: 'CONNECTION_CLOSED' })
        await tx.unsafe(statement, parameters)
      }
      try {
        await send('begin')
        for (const statement of meta.sql) {
          if (statement.trim() !== '') await send(statement)
        }
        await send('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [meta.hash, meta.folderMillis])
        await send('commit')
      } catch (cause) {
        // a closed connection's session is gone, and its transaction with it: nothing to roll back, and
        // nothing may be sent to it (see above)
        if (!closedNow()) await tx.unsafe('rollback').catch(() => undefined)
        throw new MigrationFailedError(tag, { cause })
      } finally {
        if (!closedNow()) tx.release()
      }
      done.push(tag)
      options.onApplied?.(tag)
    }
    return done
  } finally {
    // a connection that closed under a query never ends gracefully (above): destroy it at once
    await sql.end({ timeout: closedNow() ? 0 : END_TIMEOUT_SECONDS })
  }
}
