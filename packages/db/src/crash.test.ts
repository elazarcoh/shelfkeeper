import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { describe, expect, inject, it } from 'vitest'
import type { Db } from './client'
import { cleanupBackupLeftovers, listBackups, runBackup } from './ops/backups'
import { applyMigrations, migrationStatus } from './ops/migrations'
import { importCsv } from './repos/csv-import'
import { loadUserScope } from './repos/scope'
import { backupRuns, proposals, sourceItems, sources } from './schema'
import {
  createScratchDatabase,
  CRASH_PAUSED_MARKER,
  CRASH_ROWS,
  crashCsvInput,
  endSessions,
  killHard,
  migrationsFolderWith,
  runningQuery,
  seedUser,
  startChild,
  testOpsEnv,
  waitFor,
  withApplicationName,
} from './testing'

const DB_PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const child = (name: string) => fileURLToPath(new URL(`./testing/crash-children/${name}.ts`, import.meta.url))

type SourceRow = typeof sources.$inferSelect
type SourceItemRow = typeof sourceItems.$inferSelect
type ProposalRow = typeof proposals.$inferSelect

interface CsvContentSnapshot {
  sources: unknown[]
  sourceItems: unknown[]
  proposals: unknown[]
}

/** `config` minus `ownerUserId`: the two scratch databases compared below each seed their own (differently-id'd) user. */
function withoutOwner(config: unknown): unknown {
  if (typeof config !== 'object' || config === null) return config
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop ownerUserId (differs per scratch database); comparing everything else
  const { ownerUserId, ...rest } = config as Record<string, unknown>
  return rest
}

function normalizeSources(rows: SourceRow[]): unknown[] {
  return rows
    .map((r) => ({ kind: r.kind, name: r.name, schedule: r.schedule, lastSyncAt: r.lastSyncAt, lastSyncStatus: r.lastSyncStatus, config: withoutOwner(r.config) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function normalizeSourceItems(rows: SourceItemRow[]): unknown[] {
  return rows
    .map((r) => ({
      externalId: r.externalId,
      raw: r.raw,
      normalized: r.normalized,
      contentHash: r.contentHash,
      removedAt: r.removedAt,
      editionId: r.editionId,
      workId: r.workId,
      state: r.state,
      coverCheckedAt: r.coverCheckedAt,
    }))
    .sort((a, b) => a.externalId.localeCompare(b.externalId))
}

function normalizeProposals(rows: ProposalRow[]): unknown[] {
  return rows
    .map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop sourceId/sourceItemId (random per scratch database); the row's own externalId is the stable key
      const { sourceId, sourceItemId, ...restPayload } = r.payload
      const item = restPayload.item as Record<string, unknown> | undefined
      const key = typeof item?.externalId === 'string' ? item.externalId : ''
      return { key, kind: r.kind, scope: r.scope, createdBy: r.createdBy, status: r.status, resolution: r.resolution, candidates: r.candidates, payload: restPayload }
    })
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** The content of a CSV import — sources, source_item, proposal — with every random id, foreign key and
 * timestamp stripped, so two independent scratch databases (a real crash vs. a clean uninterrupted
 * import of the same input) can be compared for equal *content*, not just equal row counts. */
async function csvContentSnapshot(db: Db): Promise<CsvContentSnapshot> {
  const [sourceRows, itemRows, proposalRows] = await Promise.all([db.select().from(sources), db.select().from(sourceItems), db.select().from(proposals)])
  return { sources: normalizeSources(sourceRows), sourceItems: normalizeSourceItems(itemRows), proposals: normalizeProposals(proposalRows) }
}

describe('crash safety (spec §7): a SIGKILL mid-write leaves the before or the after state', () => {
  // Two real imports (the clean comparison db, then the retry — the crash itself never gets past row 50,
  // by design) plus a child process spawn: ~10 s in isolation, but a loaded machine running the full
  // `pnpm check` pushed it past the default 30 s, so it gets the 90 s every Docker-backed slow test gets.
  it(
    'a CSV import killed mid-transaction leaves no half import, and the retry imports it once',
    async () => {
      const s = await createScratchDatabase()
      const clean = await createScratchDatabase()
      try {
        const user = await seedUser(s.db)
        const before = await csvContentSnapshot(s.db)

        const app = 'crash-csv'
        const run = startChild(child('csv-import'), { CRASH_DB_URL: withApplicationName(s.url, app), CRASH_USER_ID: user.id }, DB_PACKAGE)
        try {
          // Deterministic, not a race: the child's importCsv hook pauses (still inside its one
          // transaction, uncommitted) after a fixed row and prints a marker — the kill always lands
          // mid-transaction, so the rolled-back branch is always the one exercised here.
          await waitFor(() => Promise.resolve(run.output().includes(CRASH_PAUSED_MARKER)), 'the import to pause mid-transaction', run)
          await killHard(run)
          await endSessions(s.url, app)
        } finally {
          // tolerant of an already-exited process (killHard's own check): guarantees no orphaned child
          // even when waitFor throws (it never paused, or exited early) before the kill above ran.
          await killHard(run)
        }

        // a clean, uninterrupted import of the same input, in a second scratch database, is the other
        // acceptable end state below
        const cleanUser = await seedUser(clean.db)
        await importCsv(clean.db, await loadUserScope(clean.db, cleanUser), crashCsvInput())
        const cleanSnapshot = await csvContentSnapshot(clean.db)

        const after = await csvContentSnapshot(s.db)
        expect([before, cleanSnapshot]).toContainEqual(after)

        // the restart: the person sends the same file pick again
        const retry = await importCsv(s.db, await loadUserScope(s.db, user), crashCsvInput())
        expect(retry.proposals).toBe(CRASH_ROWS)
        expect(await csvContentSnapshot(s.db)).toEqual(cleanSnapshot)
      } finally {
        await s.drop()
        await clean.drop()
      }
    },
    90_000,
  )

  it('a migration killed mid-way is rolled back whole, and the restart applies it', async () => {
    const s = await createScratchDatabase()
    try {
      await s.db.execute(sql`create table crash_flag (x int)`)
      const folder = migrationsFolderWith([
        {
          tag: '9998_slow',
          sql: `CREATE TABLE "slow_table" ("id" integer);--> statement-breakpoint\nSELECT pg_sleep(CASE WHEN to_regclass('public.crash_flag') IS NULL THEN 0 ELSE 60 END);`,
        },
      ])
      const app = 'crash-migrate'
      const run = startChild(child('migrate'), { CRASH_DB_URL: withApplicationName(s.url, app), CRASH_MIGRATIONS: folder }, DB_PACKAGE)
      try {
        await waitFor(() => runningQuery(s.url, app, 'pg_sleep'), 'the slow migration', run)
        await killHard(run)
        await endSessions(s.url, app)
      } finally {
        await killHard(run)
      }

      const [row] = await s.db.execute<{ slow: string | null }>(sql`select to_regclass('public.slow_table')::text as slow`)
      expect(row?.slow).toBeNull()
      expect((await migrationStatus(s.url, folder)).pending.map((e) => e.tag)).toEqual(['9998_slow'])
      await s.db.execute(sql`drop table crash_flag`)
      expect(await applyMigrations(s.url, folder)).toEqual(['9998_slow'])
    } finally {
      await s.drop()
    }
  })

  it('a backup killed mid-write leaves no finished backup; the restart removes the leftovers and backs up', async () => {
    const s = await createScratchDatabase()
    try {
      const env = testOpsEnv(s.url)
      const app = 'crash-backup'
      const run = startChild(
        child('backup'),
        { CRASH_DB_URL: withApplicationName(s.url, app), CRASH_BACKUP_DIR: env.backupDir, CRASH_ASSETS_DIR: env.assetsDir, CRASH_PG_CONTAINER: inject('pgContainerId') },
        DB_PACKAGE,
      )
      try {
        await waitFor(() => Promise.resolve(readdirSync(env.backupDir).some((f) => f.endsWith('.zip.tmp'))), 'the temp zip', run)
        await killHard(run)
        await endSessions(s.url, app)
      } finally {
        await killHard(run)
      }

      expect(await listBackups(env.backupDir)).toEqual([])
      expect((await s.db.select().from(backupRuns)).map((r) => r.status)).toEqual(['running'])
      // the restart
      expect((await cleanupBackupLeftovers(env)).removed).toBeGreaterThan(0)
      expect(readdirSync(env.backupDir).filter((f) => f.endsWith('.tmp') || f.startsWith('.work-'))).toEqual([])
      expect((await s.db.select().from(backupRuns)).map((r) => r.status)).toEqual(['failed'])
      await runBackup(env, 'manual')
      expect(await listBackups(env.backupDir)).toHaveLength(1)
    } finally {
      await s.drop()
    }
  })
})
