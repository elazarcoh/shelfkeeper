import { sql } from 'drizzle-orm'
import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { userRoles, type AbsPushField } from '@mylib/domain'

export const userRoleEnum = pgEnum('user_role', userRoles)

export const users = pgTable('app_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** stored lowercase */
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  pinHash: text('pin_hash'),
  role: userRoleEnum('role').notNull().default('member'),
  shareActivity: boolean('share_activity').notNull().default(true),
  /** the languages whose titles and names this person prefers, in order (#145) */
  titleLanguages: text('title_languages').array().notNull().default(sql`'{en,he}'::text[]`),
  /** the fields Admin → Health sends to Audiobookshelf by default (#115) */
  absPushFields: text('abs_push_fields').array().$type<AbsPushField[]>().notNull().default(sql`'{title,subtitle,authors,narrators,series,publishedDate,publisher,language,identifiers}'::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const authSessions = pgTable(
  'auth_session',
  {
    /** sha256(token) hex — the raw token only ever lives in the cookie */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_session_user_idx').on(t.userId)],
)
