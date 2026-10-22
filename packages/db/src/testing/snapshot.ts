import { sql } from 'drizzle-orm'
import type { Db } from '../client'

/** Tables that describe this install's operations, not its data: never compared, never backed up (plan deviation 9). */
export const OPS_TABLES = ['backup_run', 'system_state'] as const

/** Every row of every public table, each table's rows sorted, for "every row survived exactly". */
export async function snapshotPublicTables(db: Db, options: { exclude?: readonly string[] } = {}): Promise<Record<string, Record<string, unknown>[]>> {
  const tables = await db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  )
  const snapshot: Record<string, Record<string, unknown>[]> = {}
  for (const { table_name: table } of tables) {
    if (options.exclude?.includes(table) === true) continue
    const rows = await db.execute<{ row: string }>(sql`select row_to_json(t)::text as row from ${sql.identifier(table)} t`)
    snapshot[table] = rows
      .map((r) => r.row)
      .sort()
      .map((text) => JSON.parse(text) as Record<string, unknown>)
  }
  return snapshot
}
