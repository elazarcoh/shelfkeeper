import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { inject } from 'vitest'
import { createDb, type Db } from '../client'
import { withDatabase, withOpsLock } from '../ops/database-admin'
import type { PgTools } from '../ops/pg-tools'
import { containerPgTools } from './container-pg-tools'
import { cloneTemplate } from './test-db'

export const TEST_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))

/** pg_dump/pg_restore run inside the Testcontainers Postgres, so nothing needs installing on the dev PC (plan deviation 23). */
export function testPgTools(): PgTools {
  return containerPgTools(inject('pgContainerId'))
}

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `mylib-${prefix}-`))
}

export interface ScratchDatabase {
  readonly url: string
  readonly name: string
  readonly db: Db
  close(): Promise<void>
  /** drops it, and any `<name>_restore` / `<name>_prev_*` a test left behind */
  drop(): Promise<void>
}

/** A private database outside useTestDb: a clone of the migrated template, or empty (to build an older schema on). */
export async function createScratchDatabase(from: 'template' | 'empty' = 'template'): Promise<ScratchDatabase> {
  const baseUrl = inject('databaseUrl')
  const template = new URL(baseUrl).pathname.slice(1)
  // short, so `<name>_prev_<timestamp>` stays under Postgres's 63-character limit
  const name = `s_${randomUUID().replaceAll('-', '')}`
  const admin = postgres(withDatabase(baseUrl, 'postgres'), { max: 1, onnotice: () => undefined })
  try {
    if (from === 'template') await cloneTemplate(admin, name, template)
    else await admin.unsafe(`create database "${name}" template template0`)
  } finally {
    await admin.end()
  }
  const url = withDatabase(baseUrl, name)
  const handle = createDb(url, { max: 4 })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await handle.close()
  }
  const drop = async () => {
    await close()
    const cleanup = postgres(withDatabase(baseUrl, 'postgres'), { max: 1, onnotice: () => undefined })
    try {
      const leftovers = await cleanup<{ datname: string }[]>`select datname from pg_database where starts_with(datname, ${name})`
      for (const { datname } of leftovers) await cleanup.unsafe(`drop database if exists "${datname}" with (force)`)
    } finally {
      await cleanup.end()
    }
  }
  return { url, name, db: handle.db, close, drop }
}

/**
 * Final fix 1: what a crash between swapInDatabase's `allow_connections false` and its rename leaves
 * behind — the live database refusing every new connection.
 */
export async function simulateInterruptedSwap(url: string): Promise<void> {
  const admin = postgres(withDatabase(url, 'postgres'), { max: 1, onnotice: () => undefined })
  try {
    await admin.unsafe(`alter database "${new URL(url).pathname.slice(1)}" with allow_connections false`)
  } finally {
    await admin.end()
  }
}

/** Test cleanup: undoes simulateInterruptedSwap whatever the code under test did. */
export async function allowConnections(url: string): Promise<void> {
  const admin = postgres(withDatabase(url, 'postgres'), { max: 1, onnotice: () => undefined })
  try {
    await admin.unsafe(`alter database "${new URL(url).pathname.slice(1)}" with allow_connections true`)
  } finally {
    await admin.end()
  }
}

/**
 * 3d item 3: every DDL statement in `url`'s database now sleeps for ten minutes, server side: a stand-in
 * for a server stuck on its disk. pg_restore's first CREATE blocks on it (pg_sleep stays interruptible,
 * so dropping the database WITH (FORCE) still ends it).
 */
export async function installDdlHang(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined })
  try {
    await sql.unsafe('create function mylib_test_hang() returns event_trigger language plpgsql as $$ begin perform pg_sleep(600); end $$')
    await sql.unsafe('create event trigger mylib_test_hang on ddl_command_start execute function mylib_test_hang()')
  } finally {
    await sql.end()
  }
}

/** 3d item 3: whether any process in the test Postgres container has `fragment` in its command line. */
export function containerProcessMentions(fragment: string): boolean {
  return execFileSync('docker', ['top', inject('pgContainerId')], { encoding: 'utf8', windowsHide: true }).includes(fragment)
}

/** 3d item 4: what a dropped connection does to a session: Postgres ends it, and every session lock with it. */
export async function terminateBackend(url: string, pid: number): Promise<void> {
  const admin = postgres(withDatabase(url, 'postgres'), { max: 1, onnotice: () => undefined })
  try {
    // fix round 1: waits (up to 5 s) until the backend has exited, so its locks are released when this resolves
    await admin`select pg_terminate_backend(${pid}, 5000)`
  } finally {
    await admin.end()
  }
}

/** 3d item 4: the backend holding this database's ops lock (`mylib:<lock>:<db>`), or null when nobody holds it. */
export async function opsLockBackend(url: string, lock: 'backup' | 'migrate'): Promise<number | null> {
  const key = opsLockKey(url, lock)
  const admin = postgres(withDatabase(url, 'postgres'), { max: 1, onnotice: () => undefined })
  try {
    const [row] = await admin<{ pid: number }[]>`
      select pid from pg_locks
      where locktype = 'advisory' and granted and objsubid = 1
        and database = (select oid from pg_database where datname = 'postgres')
        and classid = ((hashtext(${key})::bigint >> 32) & 4294967295)::oid
        and objid = (hashtext(${key})::bigint & 4294967295)::oid`
    return row?.pid ?? null
  } finally {
    await admin.end()
  }
}

function opsLockKey(url: string, lock: 'backup' | 'migrate'): string {
  return `mylib:${lock}:${decodeURIComponent(new URL(url).pathname.slice(1))}`
}

/** 3d item 4 (ruling P10): drops the connection of whoever holds this database's ops lock, so the lock is gone. */
export async function loseOpsLock(url: string, lock: 'backup' | 'migrate'): Promise<void> {
  const pid = await opsLockBackend(url, lock)
  if (pid === null) throw new Error(`nothing holds the ${lock} lock`)
  await terminateBackend(url, pid)
}

/**
 * 3d item 4: another backup or restore taking the ops lock (once it is free) and holding it until the
 * returned function is called. Resolves once the lock is held.
 */
export async function holdOpsLock(url: string, lock: 'backup' | 'migrate'): Promise<() => Promise<void>> {
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let held!: () => void
  const holding = new Promise<void>((resolve) => {
    held = resolve
  })
  // fix round 1: waits for the lock, so a dying previous holder never makes this flaky
  const done = withOpsLock(
    url,
    lock,
    async () => {
      held()
      await released
    },
    { wait: true },
  )
  await Promise.race([holding, done])
  return async () => {
    release()
    await done
  }
}

/** 3d item 7: terminates every session on `url`'s database whose running query contains `fragment`; returns how many. */
export async function terminateBackendsRunning(url: string, fragment: string): Promise<number> {
  const admin = postgres(withDatabase(url, 'postgres'), { max: 1, onnotice: () => undefined })
  try {
    const rows = await admin<{ pid: number }[]>`
      select pg_terminate_backend(pid), pid from pg_stat_activity
      where datname = ${decodeURIComponent(new URL(url).pathname.slice(1))} and state = 'active'
        and query ilike ${`%${fragment}%`} and pid <> pg_backend_pid()`
    return rows.length
  } finally {
    await admin.end()
  }
}

/** 3d item 7: `alter database … set <name> = <value>` (null: reset); new sessions see it. */
export async function setDatabaseSetting(url: string, name: string, value: string | null): Promise<void> {
  const database = `"${decodeURIComponent(new URL(url).pathname.slice(1)).replaceAll('"', '""')}"`
  const admin = postgres(withDatabase(url, 'postgres'), { max: 1, onnotice: () => undefined })
  try {
    if (value === null) await admin.unsafe(`alter database ${database} reset ${name}`)
    else await admin.unsafe(`alter database ${database} set ${name} = '${value.replaceAll("'", "''")}'`)
  } finally {
    await admin.end()
  }
}
