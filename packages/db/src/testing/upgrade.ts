import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import type { Db } from '../client'
import { applyMigrations } from '../ops/migrations'
import type { SecretBox } from '../secrets'
import { createScratchDatabase, TEST_MIGRATIONS_FOLDER, type ScratchDatabase } from './ops'

/**
 * Each release's last migration (packages/db/drizzle/meta/_journal.json). 3c is the schema deployed to the household
 * server before reading progress.
 */
export const RELEASE_SCHEMAS = {
  '3a': '0004_work_search_title_trgm',
  '3b': '0006_asset_hash_cover_checked',
  '3c': '0007_backups_system_state',
} as const
export type Release = keyof typeof RELEASE_SCHEMAS

export const FIXTURE_IDS = {
  noa: 'a1111111-1111-4111-8111-000000000001',
  dan: 'a1111111-1111-4111-8111-000000000002',
  finalEmpire: 'b1111111-1111-4111-8111-000000000001',
  hebrewBook: 'b1111111-1111-4111-8111-000000000002',
  hiddenBook: 'b1111111-1111-4111-8111-000000000003',
  wantedBook: 'b1111111-1111-4111-8111-000000000004',
  finalEmpireAudiobookEdition: 'e1111111-1111-4111-8111-000000000002',
  absSource: '91111111-1111-4111-8111-000000000001',
  readarrSource: '91111111-1111-4111-8111-000000000002',
  csvSource: '91111111-1111-4111-8111-000000000003',
  mistbornItem: '9a111111-1111-4111-8111-000000000001',
  hp1Item: '9a111111-1111-4111-8111-000000000002',
  /** ignored, then deleted from Audiobookshelf entirely — never resurfaced by a sync that never sees it again. */
  ignoredGoneItem: '9a111111-1111-4111-8111-000000000005',
  cover3a: '31111111-1111-4111-8111-000000000001',
  cover3b: '31111111-1111-4111-8111-000000000002',
  /** Noa's in-progress read of the Hebrew ebook (3a.sql; its edition's wordCount is 180000). */
  noaReadingSession: '61111111-1111-4111-8111-000000000002',
} as const

/** An empty database migrated exactly to a release's schema. */
export async function buildDatabaseAt(release: Release): Promise<ScratchDatabase> {
  const scratch = await createScratchDatabase('empty')
  await applyMigrations(scratch.url, TEST_MIGRATIONS_FOLDER, { upTo: RELEASE_SCHEMAS[release] })
  return scratch
}

/** Loads the release's fixture (3b = 3a's rows plus 3b's; 3c = 3b's rows plus 3c's), sealing the source secrets with `box`. */
export async function loadFixture(db: Db, release: Release, secrets: { box: SecretBox; absToken: string; arrKey: string }): Promise<void> {
  const files = release === '3a' ? ['3a.sql'] : release === '3b' ? ['3a.sql', '3b.sql'] : ['3a.sql', '3b.sql', '3c.sql']
  for (const file of files) {
    const text = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
      .replaceAll('__SEALED_ABS_TOKEN__', secrets.box.seal(secrets.absToken))
      .replaceAll('__SEALED_ARR_KEY__', secrets.box.seal(secrets.arrKey))
    for (const statement of text.split('--> statement-breakpoint')) {
      const body = statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
      if (body !== '') await db.execute(sql.raw(body))
    }
  }
}
