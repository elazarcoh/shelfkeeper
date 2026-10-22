import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, inject } from 'vitest'
import { createDb, type Db, type DbHandle } from '../client'
import { withDatabase } from '../ops/database-admin'

export interface TestDb {
  readonly db: Db
  /** this file's private database (for code that opens its own connections, like backups) */
  readonly url: string
}

export async function cloneTemplate(admin: postgres.Sql, name: string, template: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.unsafe(`create database "${name}" template "${template}"`)
      return
    } catch (err) {
      const busy = err instanceof Error && err.message.includes('being accessed by other users')
      if (!busy || attempt >= 10) throw err
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
    }
  }
}

export async function resetDatabase(db: Db): Promise<void> {
  await db.execute(sql`truncate table app_user, work, contributor, series, tag, book_set, asset, source, backup_run, system_state, backup_settings, hardcover_external_book, hardcover_series, hardcover_author, hardcover_missing_book cascade`)
}

/** A private database for this test file (cloned from the migrated template), emptied before every test. */
export function useTestDb(): TestDb {
  const baseUrl = inject('databaseUrl')
  const template = new URL(baseUrl).pathname.slice(1)
  const name = `test_${randomUUID().replaceAll('-', '')}`
  const admin = postgres(withDatabase(baseUrl, 'postgres'), { max: 1, onnotice: () => undefined })
  let handle: DbHandle | undefined

  beforeAll(async () => {
    await cloneTemplate(admin, name, template)
    handle = createDb(withDatabase(baseUrl, name))
  })
  beforeEach(async () => {
    if (handle) await resetDatabase(handle.db)
  })
  afterAll(async () => {
    await handle?.close()
    await admin.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.end()
  })

  return {
    get db() {
      if (!handle) throw new Error('useTestDb: the database is only available inside tests and hooks')
      return handle.db
    },
    get url() {
      return withDatabase(baseUrl, name)
    },
  }
}
