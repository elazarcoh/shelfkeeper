import { sql } from 'drizzle-orm'
import { bigint, check, index, integer, jsonb, pgEnum, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { backupKinds, type MaintenanceState, type RestoreOutcome } from '@mylib/domain'
import { users } from './users'

export const backupRunStatuses = ['running', 'succeeded', 'failed'] as const
export type BackupRunStatus = (typeof backupRunStatuses)[number]

export const backupKindEnum = pgEnum('backup_kind', backupKinds)
export const backupRunStatusEnum = pgEnum('backup_run_status', backupRunStatuses)

/** One row (id = 1): what both processes must agree on right now (plan deviation 2). Its data is never backed up. */
export const systemState = pgTable(
  'system_state',
  {
    id: smallint('id').primaryKey().default(1),
    maintenance: jsonb('maintenance').$type<MaintenanceState>(),
    /** the worker writes this once it has stopped taking jobs for a maintenance */
    workerPausedAt: timestamp('worker_paused_at', { withTimezone: true }),
    lastRestore: jsonb('last_restore').$type<RestoreOutcome>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('system_state_single_row', sql`${t.id} = 1`)],
)

/** One row (id = 1): Admin → Backups settings. A null schedule means BACKUP_SCHEDULE from the environment. */
export const backupSettings = pgTable(
  'backup_settings',
  {
    id: smallint('id').primaryKey().default(1),
    schedule: text('schedule'),
    keepScheduled: integer('keep_scheduled').notNull().default(14),
    keepPreUpgrade: integer('keep_pre_upgrade').notNull().default(5),
    keepPreRestore: integer('keep_pre_restore').notNull().default(5),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('backup_settings_single_row', sql`${t.id} = 1`)],
)

/** Every backup attempt on this install. Never backed up itself (plan deviation 9). */
export const backupRuns = pgTable(
  'backup_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: backupKindEnum('kind').notNull(),
    status: backupRunStatusEnum('status').notNull().default('running'),
    fileName: text('file_name'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('backup_run_started_idx').on(t.startedAt)],
)
