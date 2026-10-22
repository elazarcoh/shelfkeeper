import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { setKinds, setScopes, type FilterNode } from '@mylib/domain'
import { works } from './catalog'
import { users } from './users'

export const setScopeEnum = pgEnum('set_scope', setScopes)
export const setKindEnum = pgEnum('set_kind', setKinds)

export const sets = pgTable(
  'book_set',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    scope: setScopeEnum('scope').notNull(),
    kind: setKindEnum('kind').notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    filter: jsonb('filter').$type<FilterNode>(),
    isDefaultPersonal: boolean('is_default_personal').notNull().default(false),
    defaultForNewUsers: boolean('default_for_new_users').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('book_set_owner_matches_scope', sql`(${t.scope} = 'global') = (${t.ownerUserId} is null)`),
    check('book_set_filter_matches_kind', sql`(${t.kind} = 'smart') = (${t.filter} is not null)`),
    check('book_set_new_user_default_is_global', sql`not ${t.defaultForNewUsers} or ${t.scope} = 'global'`),
    index('book_set_owner_idx').on(t.ownerUserId),
  ],
)

export const setItems = pgTable(
  'set_item',
  {
    setId: uuid('set_id')
      .notNull()
      .references(() => sets.id, { onDelete: 'cascade' }),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.setId, t.workId] }), index('set_item_work_idx').on(t.workId)],
)

export const userSets = pgTable(
  'user_set',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    setId: uuid('set_id')
      .notNull()
      .references(() => sets.id, { onDelete: 'cascade' }),
    assignedByAdmin: boolean('assigned_by_admin').notNull().default(false),
    active: boolean('active').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.setId] })],
)

export const userHiddenWorks = pgTable(
  'user_hidden_work',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    hiddenBy: uuid('hidden_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workId] })],
)

export const userHiddenSets = pgTable(
  'user_hidden_set',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    setId: uuid('set_id')
      .notNull()
      .references(() => sets.id, { onDelete: 'cascade' }),
    hiddenBy: uuid('hidden_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.setId] })],
)
