import { check, date, index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { editions } from './catalog'
import { users } from './users'

export const loans = pgTable(
  'loan',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    editionId: uuid('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    lentByUserId: uuid('lent_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    borrowerUserId: uuid('borrower_user_id').references(() => users.id, { onDelete: 'restrict' }),
    borrowerName: text('borrower_name'),
    lentOn: date('lent_on', { mode: 'string' }).notNull(),
    dueOn: date('due_on', { mode: 'string' }),
    returnedOn: date('returned_on', { mode: 'string' }),
  },
  (t) => [
    index('loan_edition_idx').on(t.editionId),
    check(
      'loan_exactly_one_borrower',
      sql`(${t.borrowerUserId} is null) <> (${t.borrowerName} is null)`,
    ),
  ],
)
