import { boolean, doublePrecision, date, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core'
import { sessionModeEnum } from './sessions'
import { users } from './users'

export const dailyStats = pgTable(
  'daily_stat',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    mode: sessionModeEnum('mode').notNull(),
    minutes: doublePrecision('minutes').notNull().default(0),
    words: doublePrecision('words').notNull().default(0),
    estimated: boolean('estimated').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.date, t.mode] })],
)
