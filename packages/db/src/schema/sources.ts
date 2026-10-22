import { sql } from 'drizzle-orm'
import { index, jsonb, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import {
  proposalCreators,
  proposalKinds,
  proposalScopes,
  proposalStatuses,
  sourceKinds,
  sourceSchedules,
  type AbsPushSendInput,
  type ExternalItem,
  type MatchCandidate,
  type SyncStats,
} from '@mylib/domain'
import type { AbsPushResult } from '../repos/abs-push'
import { editions, works } from './catalog'
import { users } from './users'

export const sourceItemStates = ['pending', 'linked', 'ignored'] as const
export type SourceItemState = (typeof sourceItemStates)[number]
export const jobTriggers = ['manual', 'schedule', 'rerun'] as const
export type JobTrigger = (typeof jobTriggers)[number]
export const jobStatuses = ['queued', 'running', 'succeeded', 'failed', 'skipped'] as const
export type JobStatus = (typeof jobStatuses)[number]

export const sourceKindEnum = pgEnum('source_kind', sourceKinds)
export const sourceScheduleEnum = pgEnum('source_schedule', sourceSchedules)
export const sourceItemStateEnum = pgEnum('source_item_state', sourceItemStates)
export const proposalKindEnum = pgEnum('proposal_kind', proposalKinds)
export const proposalScopeEnum = pgEnum('proposal_scope', proposalScopes)
export const proposalStatusEnum = pgEnum('proposal_status', proposalStatuses)
export const proposalCreatorEnum = pgEnum('proposal_creator', proposalCreators)
export const jobTriggerEnum = pgEnum('job_trigger', jobTriggers)
export const jobStatusEnum = pgEnum('job_status', jobStatuses)

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const sources = pgTable('source', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: sourceKindEnum('kind').notNull(),
  name: text('name').notNull(),
  /** SourceConfig with its secret fields sealed by the secret box (see repos/sources.ts) */
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  schedule: sourceScheduleEnum('schedule'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncStatus: jobStatusEnum('last_sync_status'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})

export const sourceItems = pgTable(
  'source_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    raw: jsonb('raw'),
    /** the validated ExternalItem, without raw */
    normalized: jsonb('normalized').$type<ExternalItem>().notNull(),
    contentHash: text('content_hash').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    editionId: uuid('edition_id').references(() => editions.id, { onDelete: 'set null' }),
    workId: uuid('work_id').references(() => works.id, { onDelete: 'set null' }),
    state: sourceItemStateEnum('state').notNull().default('pending'),
    /** last cover download attempt; a failure is retried after COVER_RETRY_DAYS */
    coverCheckedAt: timestamp('cover_checked_at', { withTimezone: true }),
  },
  (t) => [
    unique('source_item_external_uq').on(t.sourceId, t.externalId),
    index('source_item_edition_idx').on(t.editionId),
    // cross-source-id matching (findCandidates): `(normalized->'identifiers'->'others') @> {key: value}`
    index('source_item_others_idx').using('gin', sql`((${t.normalized} -> 'identifiers') -> 'others') jsonb_path_ops`),
  ],
)

export const proposals = pgTable(
  'proposal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: proposalKindEnum('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    candidates: jsonb('candidates').$type<MatchCandidate[]>().notNull().default([]),
    scope: proposalScopeEnum('scope').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdBy: proposalCreatorEnum('created_by').notNull(),
    status: proposalStatusEnum('status').notNull().default('pending'),
    resolution: jsonb('resolution'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    sourceItemId: uuid('source_item_id').references(() => sourceItems.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('proposal_status_scope_idx').on(t.status, t.scope),
    uniqueIndex('proposal_one_pending_per_item').on(t.sourceItemId).where(sql`${t.status} = 'pending'`),
  ],
)

export const jobRuns = pgTable(
  'job_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    trigger: jobTriggerEnum('trigger').notNull(),
    status: jobStatusEnum('status').notNull().default('queued'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    stats: jsonb('stats').$type<SyncStats>(),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('job_run_created_idx').on(t.createdAt),
    // at most one sync of a source runs at a time (spec §8: syncs are idempotent and serialized)
    uniqueIndex('job_run_one_running_per_source').on(t.sourceId).where(sql`${t.status} = 'running'`),
  ],
)

/** One send of metadata to Audiobookshelf (#115); `results` grows as the worker goes, so the page can poll it. */
export const absPushRuns = pgTable(
  'abs_push_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: text('status').notNull().$type<'running' | 'succeeded' | 'failed' | 'stopped'>().default('running'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    request: jsonb('request').$type<AbsPushSendInput['books']>().notNull(),
    results: jsonb('results').$type<AbsPushResult[]>().notNull().default([]),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('abs_push_run_one_running').on(t.status).where(sql`${t.status} = 'running'`)],
)
