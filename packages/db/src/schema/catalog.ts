import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  editionContributorRoles,
  editionFormats,
  editionOwnerships,
  holdingEventTypes,
  holdingOrigins,
  workKinds,
  type Provenance,
} from '@mylib/domain'
import { users } from './users'

export const editionFormatEnum = pgEnum('edition_format', editionFormats)
export const editionOwnershipEnum = pgEnum('edition_ownership', editionOwnerships)
export const holdingEventTypeEnum = pgEnum('holding_event_type', holdingEventTypes)
export const holdingOriginEnum = pgEnum('holding_origin', holdingOrigins)
export const editionContributorRoleEnum = pgEnum('edition_contributor_role', editionContributorRoles)
export const workKindEnum = pgEnum('work_kind', workKinds)
export const tagKindEnum = pgEnum('tag_kind', ['genre', 'user'])
export const assetKindEnum = pgEnum('asset_kind', ['cover', 'upload'])

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

export const works = pgTable(
  'work',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    sortTitle: text('sort_title').notNull(),
    subtitle: text('subtitle'),
    description: text('description'),
    originalYear: integer('original_year'),
    kind: workKindEnum('kind').notNull().default('book'),
    provenance: jsonb('provenance').$type<Provenance>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('work_sort_title_idx').on(t.sortTitle), index('work_created_at_idx').on(t.createdAt)],
)

/** A book's title in one language (#145); the primary row is the one every title write mirrors onto work.title. */
export const workTitles = pgTable(
  'work_title',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    /** e.g. 'he', 'en'; null = unknown */
    language: text('language'),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    sortTitle: text('sort_title').notNull(),
    primary: boolean('primary').notNull().default(false),
  },
  (t) => [
    // one title per language, and one language-less title, per book
    unique('work_title_language_uq').on(t.workId, t.language).nullsNotDistinct(),
    uniqueIndex('work_title_primary_uq').on(t.workId).where(sql`${t.primary}`),
    index('work_title_work_idx').on(t.workId),
  ],
)

export const assets = pgTable('asset', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: assetKindEnum('kind').notNull(),
  path: text('path').notNull(),
  mime: text('mime').notNull(),
  width: integer('width'),
  height: integer('height'),
  sha256: text('sha256').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('asset_sha256_uq').on(t.sha256)])

export const editions = pgTable(
  'edition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    format: editionFormatEnum('format').notNull(),
    title: text('title'),
    subtitle: text('subtitle'),
    isbn13: text('isbn13'),
    isbn10: text('isbn10'),
    asin: text('asin'),
    publisher: text('publisher'),
    publishedOn: date('published_on', { mode: 'string' }),
    pageCount: integer('page_count'),
    wordCount: integer('word_count'),
    durationSec: integer('duration_sec'),
    language: text('language'),
    coverAssetId: uuid('cover_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    shelfLocation: text('shelf_location'),
    /** "volume k of N" of a multi-volume edition (#66); a volume set is the work's editions with one format and language */
    volume: integer('volume'),
    volumeCount: integer('volume_count'),
    /** current holding state (spec §4.1a); history lives in edition_holding_event */
    ownership: editionOwnershipEnum('ownership').notNull().default('owned'),
    inPossession: boolean('in_possession').notNull().default(true),
    provenance: jsonb('provenance').$type<Provenance>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('edition_work_idx').on(t.workId),
    index('edition_isbn13_idx').on(t.isbn13),
    index('edition_asin_idx').on(t.asin),
    check('edition_volume_range', sql`${t.volume} is null or ${t.volume} between 1 and 999`),
    check('edition_volume_count_range', sql`${t.volumeCount} is null or ${t.volumeCount} between 1 and 999`),
    check('edition_volume_count_needs_volume', sql`${t.volumeCount} is null or ${t.volume} is not null`),
    check('edition_volume_within_count', sql`${t.volumeCount} is null or ${t.volume} is null or ${t.volume} <= ${t.volumeCount}`),
  ],
)

export const editionHoldingEvents = pgTable(
  'edition_holding_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    editionId: uuid('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    type: holdingEventTypeEnum('type').notNull(),
    occurredOn: date('occurred_on', { mode: 'string' }).notNull(),
    note: text('note'),
    origin: holdingOriginEnum('origin').notNull().default('manual'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('edition_holding_event_edition_idx').on(t.editionId, t.occurredOn)],
)

export const contributors = pgTable('contributor', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  sortName: text('sort_name').notNull(),
  normalizedName: text('normalized_name').notNull().unique(),
  /** set by any Admin → People action: a curated person is never pruned as an orphan */
  curated: boolean('curated').notNull().default(false),
})

/** Every name a person goes by (the primary name included); one spelling always means one person. */
export const contributorNames = pgTable(
  'contributor_name',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contributorId: uuid('contributor_id')
      .notNull()
      .references(() => contributors.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull().unique(),
    /** e.g. 'he', 'en'; null = unknown */
    language: text('language'),
  },
  (t) => [
    index('contributor_name_contributor_idx').on(t.contributorId),
    // the target of the links' (name_id, contributor_id) guard (migration 0018): a book credits a name of its own person
    unique('contributor_name_id_contributor_unique').on(t.id, t.contributorId),
  ],
)

export const workContributors = pgTable(
  'work_contributor',
  {
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    contributorId: uuid('contributor_id')
      .notNull()
      .references(() => contributors.id, { onDelete: 'cascade' }),
    /** the name this book credited (null once that name was removed from the person) */
    // migration 0018 adds a deferrable composite FK (name_id, contributor_id) -> contributor_name(id, contributor_id) that
    // drizzle cannot express: never use `drizzle-kit push`
    nameId: uuid('name_id').references(() => contributorNames.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workId, t.contributorId] }),
    index('work_contributor_contributor_idx').on(t.contributorId),
  ],
)

export const editionContributors = pgTable(
  'edition_contributor',
  {
    editionId: uuid('edition_id')
      .notNull()
      .references(() => editions.id, { onDelete: 'cascade' }),
    contributorId: uuid('contributor_id')
      .notNull()
      .references(() => contributors.id, { onDelete: 'cascade' }),
    /** the name this book credited (null once that name was removed from the person) */
    // migration 0018 adds a deferrable composite FK (name_id, contributor_id) -> contributor_name(id, contributor_id) that
    // drizzle cannot express: never use `drizzle-kit push`
    nameId: uuid('name_id').references(() => contributorNames.id, { onDelete: 'set null' }),
    role: editionContributorRoleEnum('role').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.editionId, t.contributorId, t.role] }),
    index('edition_contributor_contributor_idx').on(t.contributorId),
  ],
)

export const series = pgTable('series', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull().unique(),
})

/** Every name a series goes by (the primary included: the row whose normalized_name is series.normalized_name). */
export const seriesNames = pgTable(
  'series_name',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull().unique(),
    /** e.g. 'he', 'en'; null = unknown */
    language: text('language'),
  },
  (t) => [index('series_name_series_idx').on(t.seriesId)],
)

export const workSeries = pgTable(
  'work_series',
  {
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    position: doublePrecision('position'),
    positionEnd: doublePrecision('position_end'),
    sortIndex: integer('sort_index').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workId, t.seriesId] }),
    index('work_series_series_idx').on(t.seriesId),
    // a range (#122): an end only after a start, and above it
    check('work_series_position_end_check', sql`${t.positionEnd} is null or (${t.position} is not null and ${t.positionEnd} > ${t.position})`),
  ],
)

export const tags = pgTable('tag', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull().unique(),
  kind: tagKindEnum('kind').notNull().default('user'),
})

export const workTags = pgTable(
  'work_tag',
  {
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.workId, t.tagId] }), index('work_tag_tag_idx').on(t.tagId)],
)
