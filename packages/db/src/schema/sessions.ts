import { sql } from 'drizzle-orm'
import { boolean, check, date, doublePrecision, index, pgEnum, pgTable, primaryKey, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { datePrecisions, progressKinds, sessionModes, sessionOutcomes } from '@mylib/domain'
import { editions, works } from './catalog'
import { users } from './users'

export const sessionModeEnum = pgEnum('session_mode', sessionModes)
export const sessionOutcomeEnum = pgEnum('session_outcome', sessionOutcomes)
export const datePrecisionEnum = pgEnum('date_precision', datePrecisions)

export const readingSessions = pgTable(
  'reading_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    editionId: uuid('edition_id').references(() => editions.id, { onDelete: 'set null' }),
    mode: sessionModeEnum('mode').notNull(),
    startedOn: date('started_on', { mode: 'string' }).notNull(),
    startedPrecision: datePrecisionEnum('started_precision').notNull().default('day'),
    finishedOn: date('finished_on', { mode: 'string' }),
    finishedPrecision: datePrecisionEnum('finished_precision'),
    outcome: sessionOutcomeEnum('outcome').notNull().default('in_progress'),
    fractionCompleted: doublePrecision('fraction_completed'),
    isReread: boolean('is_reread').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** bumped on completion — the activity feed orders by this, not by the (possibly backdated) finishedOn. */
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('reading_session_user_work_idx').on(t.userId, t.workId),
    index('reading_session_user_outcome_idx').on(t.userId, t.outcome),
    check('reading_session_fraction_range', sql`${t.fractionCompleted} is null or (${t.fractionCompleted} between 0 and 1)`),
  ],
)

export const checkinStates = pgTable('checkin_state', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  lastPromptedOn: date('last_prompted_on', { mode: 'string' }),
})

export const checkinSnoozes = pgTable(
  'checkin_snooze',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => readingSessions.id, { onDelete: 'cascade' }),
    until: date('until', { mode: 'string' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionId] })],
)

/**
 * When the reader last answered check-in for a session without a new point ("Still going"). A point's own
 * created_at counts too; together they keep check-in from asking about the same book again within 12 hours (#45).
 */
export const checkinMarks = pgTable('checkin_mark', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => readingSessions.id, { onDelete: 'cascade' }),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }).notNull().defaultNow(),
})

export const progressKindEnum = pgEnum('progress_kind', progressKinds)

/**
 * Reading progress points (reading progress spec §2): where a reader was in a session on a day. The fraction is
 * derived from the session's edition length, never stored. One point per session, volume and day (the last entry wins).
 */
export const readingProgress = pgTable(
  'reading_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => readingSessions.id, { onDelete: 'cascade' }),
    /** the day the reader was at this position — `on` in the API (ON is an SQL keyword) */
    occurredOn: date('occurred_on', { mode: 'string' }).notNull(),
    kind: progressKindEnum('kind').notNull(),
    value: doublePrecision('value').notNull(),
    /** the edition (volume, #66) this point is in; set from the session's edition when the point is written */
    editionId: uuid('edition_id').references(() => editions.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reading_progress_edition_idx').on(t.editionId),
    // a constraint, not a unique index: drizzle only expresses NULLS NOT DISTINCT there (a point without a volume still clashes)
    unique('reading_progress_session_edition_day_idx').on(t.sessionId, t.editionId, t.occurredOn).nullsNotDistinct(),
    // NaN passes ">= 0" in Postgres (it sorts above every number, and 'NaN' = 'NaN'), so finiteness is checked explicitly
    check(
      'reading_progress_value_range',
      sql`${t.value} <> 'NaN'::float8 and ${t.value} < 'Infinity'::float8 and ${t.value} >= 0 and (${t.kind} <> 'percent' or ${t.value} <= 100)`,
    ),
  ],
)
