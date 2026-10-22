import { sql } from 'drizzle-orm'
import { check, doublePrecision, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { readingStatuses } from '@mylib/domain'
import { series, works } from './catalog'
import { users } from './users'

export const readingStatusEnum = pgEnum('reading_status', readingStatuses)

export const userWorks = pgTable(
  'user_work',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    status: readingStatusEnum('status').notNull().default('none'),
    rating: doublePrecision('rating'),
    review: text('review'),
    ratedAt: timestamp('rated_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.workId] }),
    index('user_work_work_idx').on(t.workId),
    check(
      'user_work_rating_half_steps',
      sql`${t.rating} is null or (${t.rating} between 0.5 and 5 and ${t.rating} * 2 = floor(${t.rating} * 2))`,
    ),
  ],
)

export const queueEntries = pgTable(
  'queue_entry',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workId] }), index('queue_entry_user_position_idx').on(t.userId, t.position)],
)

/** Series the user asked not to be suggested in Series continuation (Home, and after finishing a book). */
export const userHiddenContinuations = pgTable(
  'user_hidden_continuation',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.seriesId] })],
)
