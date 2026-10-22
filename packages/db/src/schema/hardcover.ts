import { sql } from 'drizzle-orm'
import { boolean, check, date, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { hardcoverAccountStatuses, hardcoverMatchKinds, hardcoverPushStatuses, type HardcoverTags } from '@mylib/domain'
import { works } from './catalog'
import { readingSessions } from './sessions'
import { users } from './users'

export const hardcoverScopeEnum = pgEnum('hardcover_scope', ['household', 'user'])
export const hardcoverAccountStatusEnum = pgEnum('hardcover_account_status', hardcoverAccountStatuses)
export const hardcoverMatchEnum = pgEnum('hardcover_match', hardcoverMatchKinds)
export const hardcoverPushStatusEnum = pgEnum('hardcover_push_status', hardcoverPushStatuses)

/** A Hardcover token: the household's (book data) or one person's (their recommendations and sends). Reusable by a future Hardcover source. */
export const hardcoverAccounts = pgTable(
  'hardcover_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: hardcoverScopeEnum('scope').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** sealed with SecretBox; never leaves the server */
    token: text('token').notNull(),
    hardcoverUserId: integer('hardcover_user_id').notNull(),
    username: text('username').notNull(),
    status: hardcoverAccountStatusEnum('status').notNull().default('ok'),
    statusDetail: text('status_detail'),
    sendFinished: boolean('send_finished').notNull().default(false),
    sendSince: timestamp('send_since', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hardcover_account_one_household').on(t.scope).where(sql`${t.scope} = 'household'`),
    uniqueIndex('hardcover_account_one_per_user').on(t.userId).where(sql`${t.scope} = 'user'`),
    check('hardcover_account_scope_user', sql`(${t.scope} = 'household') = (${t.userId} is null)`),
  ],
)

export const hardcoverBooks = pgTable(
  'hardcover_book',
  {
    workId: uuid('work_id')
      .primaryKey()
      .references(() => works.id, { onDelete: 'cascade' }),
    hardcoverId: integer('hardcover_id'),
    slug: text('slug'),
    match: hardcoverMatchEnum('match').notNull(),
    rating: doublePrecision('rating'),
    ratingsCount: integer('ratings_count').notNull().default(0),
    tags: jsonb('tags').$type<HardcoverTags>().notNull().default({ genre: [], mood: [] }),
    similarIds: jsonb('similar_ids').$type<number[]>().notNull().default([]),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
  },
  (t) => [
    index('hardcover_book_hardcover_idx').on(t.hardcoverId),
    check('hardcover_book_matched_has_id', sql`(${t.match} in ('none', 'rejected')) = (${t.hardcoverId} is null)`),
  ],
)

export const hardcoverRecommendations = pgTable('hardcover_recommendation', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => hardcoverAccounts.id, { onDelete: 'cascade' }),
  hardcoverIds: jsonb('hardcover_ids').$type<number[]>().notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
})

export const hardcoverRuns = pgTable(
  'hardcover_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull().$type<'refresh' | 'send'>(),
    trigger: text('trigger').notNull().$type<'schedule' | 'manual'>(),
    status: text('status').notNull().$type<'running' | 'succeeded' | 'failed' | 'stopped'>().default('running'),
    stats: jsonb('stats').$type<Record<string, number>>(),
    error: text('error'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('hardcover_run_one_running').on(t.kind).where(sql`${t.status} = 'running'`), index('hardcover_run_started_idx').on(t.startedAt)],
)

export const hardcoverPushes = pgTable(
  'hardcover_push',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => hardcoverAccounts.id, { onDelete: 'cascade' }),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => readingSessions.id, { onDelete: 'set null' }),
    finishedOn: date('finished_on', { mode: 'string' }),
    status: hardcoverPushStatusEnum('status').notNull().default('waiting'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.workId] }), index('hardcover_push_waiting_idx').on(t.status)],
)
