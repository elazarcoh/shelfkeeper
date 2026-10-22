import { sql } from 'drizzle-orm'
import { boolean, check, date, doublePrecision, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { whatNextFormats, type HardcoverBookSeries, type HardcoverSeriesBooks, type HardcoverTags } from '@mylib/domain'
import { contributors } from './catalog'
import { hardcoverAccounts } from './hardcover'
import { users } from './users'

export const authorFollowModeEnum = pgEnum('author_follow_mode', ['follow', 'unfollow'])
export const whatNextFormatEnum = pgEnum('what_next_format', whatNextFormats)

/** One Hardcover book seen by the nightly what-next refresh (series, author and Read-list members); refreshed after 7 days. */
export const hardcoverExternalBooks = pgTable('hardcover_external_book', {
  hardcoverId: integer('hardcover_id').primaryKey(),
  title: text('title').notNull(),
  authors: jsonb('authors').$type<string[]>().notNull().default([]),
  /** the first featured series entry, for display */
  seriesName: text('series_name'),
  position: doublePrecision('position'),
  pages: integer('pages'),
  releaseDate: date('release_date', { mode: 'string' }),
  imageUrl: text('image_url'),
  tags: jsonb('tags').$type<HardcoverTags>().notNull().default({ genre: [], mood: [] }),
  hasAudiobook: boolean('has_audiobook'),
  series: jsonb('series').$type<HardcoverBookSeries[]>().notNull().default([]),
  authorIds: jsonb('author_ids').$type<number[]>().notNull().default([]),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
})

export const hardcoverSeries = pgTable('hardcover_series', {
  hardcoverSeriesId: integer('hardcover_series_id').primaryKey(),
  name: text('name').notNull(),
  books: jsonb('books').$type<HardcoverSeriesBooks['books']>().notNull().default([]),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
})

export const hardcoverAuthors = pgTable('hardcover_author', {
  hardcoverAuthorId: integer('hardcover_author_id').primaryKey(),
  name: text('name'),
  bookIds: jsonb('book_ids').$type<{ id: number; title: string; releaseDate: string | null }[]>().notNull().default([]),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
})

/** A person's Hardcover Read list (book ids). */
export const hardcoverReads = pgTable('hardcover_read', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => hardcoverAccounts.id, { onDelete: 'cascade' }),
  bookIds: jsonb('book_ids').$type<number[]>().notNull().default([]),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
})

/** Picks a person hid from What next; `pick_key` is `hc:<hardcover id>` or `work:<uuid>`. */
export const whatNextHidden = pgTable(
  'what_next_hidden',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pickKey: text('pick_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.pickKey] })],
)

/** An author a person follows (or unfollows, to opt out of the automatic ones): a library contributor or a Hardcover author. */
export const authorFollows = pgTable(
  'author_follow',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contributorId: uuid('contributor_id').references(() => contributors.id, { onDelete: 'cascade' }),
    hardcoverAuthorId: integer('hardcover_author_id'),
    mode: authorFollowModeEnum('mode').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('author_follow_one_target', sql`(${t.contributorId} is null) <> (${t.hardcoverAuthorId} is null)`),
    uniqueIndex('author_follow_contributor_uq').on(t.userId, t.contributorId).where(sql`${t.contributorId} is not null`),
    uniqueIndex('author_follow_hardcover_uq').on(t.userId, t.hardcoverAuthorId).where(sql`${t.hardcoverAuthorId} is not null`),
  ],
)

export const whatNextPrefs = pgTable('what_next_pref', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  format: whatNextFormatEnum('format').notNull().default('audio'),
  aiAnswer: text('ai_answer'),
  aiPastedAt: timestamp('ai_pasted_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** A Hardcover id the details request asked for and Hardcover did not return (deleted or merged); not asked again until the cache window passes. */
export const hardcoverMissingBooks = pgTable('hardcover_missing_book', {
  hardcoverId: integer('hardcover_id').primaryKey(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
})
