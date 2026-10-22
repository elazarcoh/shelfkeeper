import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type { EditionFormat, WishPage } from '@mylib/domain'
import { editionFormatEnum, works } from './catalog'
import { users } from './users'

/** One person's wish to own a book (#53): which formats (none = any), a language, a note, and the page it came from. */
export const wishes = pgTable(
  'wish',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    formats: editionFormatEnum('formats').array().$type<EditionFormat[]>().notNull().default([]),
    language: text('language'),
    note: text('note'),
    page: jsonb('page').$type<WishPage>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('wish_user_work_uq').on(t.userId, t.workId), index('wish_work_idx').on(t.workId)],
)
