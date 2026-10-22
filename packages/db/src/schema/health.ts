import { primaryKey, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

/** Admin → Health problems the admin chose to ignore. No foreign key to the subject: a row for a merged or deleted book just stops matching. */
export const healthIgnores = pgTable(
  'health_ignore',
  {
    /** a HealthCheck value ("check" is a reserved word) */
    checkName: text('check_name').notNull(),
    /** work, edition, series or loan id; a duplicate pair is "a:b" (see pairKey) */
    subjectKey: text('subject_key').notNull(),
    ignoredBy: uuid('ignored_by').references(() => users.id, { onDelete: 'set null' }),
    ignoredAt: timestamp('ignored_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.checkName, t.subjectKey] })],
)
