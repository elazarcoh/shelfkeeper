import { check, date, doublePrecision, index, pgEnum, pgTable, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { goalMetrics } from '@mylib/domain'
import { users } from './users'

export const goalMetricEnum = pgEnum('goal_metric', goalMetrics)

export const goals = pgTable(
  'goal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    metric: goalMetricEnum('metric').notNull(),
    target: doublePrecision('target').notNull(),
  },
  (t) => [
    index('goal_user_idx').on(t.userId),
    check('goal_period_order', sql`${t.periodEnd} >= ${t.periodStart}`),
    check('goal_target_positive', sql`${t.target} > 0`),
  ],
)
