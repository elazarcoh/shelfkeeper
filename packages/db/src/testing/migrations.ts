import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { TEST_MIGRATIONS_FOLDER, tempDir } from './ops'

interface JournalFile {
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[]
}

/** A temp copy of packages/db/drizzle with `extra` migrations appended (for failure and crash tests). */
export function migrationsFolderWith(extra: readonly { tag: string; sql: string }[]): string {
  const dir = tempDir('migrations')
  cpSync(TEST_MIGRATIONS_FOLDER, dir, { recursive: true })
  const journalPath = path.join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalFile
  let when = Math.max(...journal.entries.map((e) => e.when))
  for (const migration of extra) {
    when += 1000
    journal.entries.push({ idx: journal.entries.length, version: '7', when, tag: migration.tag, breakpoints: true })
    writeFileSync(path.join(dir, `${migration.tag}.sql`), migration.sql)
  }
  writeFileSync(journalPath, JSON.stringify(journal, null, 2))
  return dir
}
