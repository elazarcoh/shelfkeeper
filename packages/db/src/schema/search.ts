import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { works } from './catalog'

/** Denormalized, normalized search text per work (see buildSearchDocument in @mylib/domain). */
export const workSearch = pgTable(
  'work_search',
  {
    workId: uuid('work_id')
      .primaryKey()
      .references(() => works.id, { onDelete: 'cascade' }),
    document: text('document').notNull(),
    titleText: text('title_text').notNull(),
    seriesText: text('series_text').notNull(),
    authorText: text('author_text').notNull(),
    otherText: text('other_text').notNull(),
    /** #73: null until the start-up backfill (or any refresh) fills it; '' when the work has none */
    acronyms: text('acronyms'),
  },
  (t) => [
    index('work_search_document_trgm_idx').using('gin', t.document.op('gin_trgm_ops')),
    index('work_search_title_trgm_idx').using('gin', t.titleText.op('gin_trgm_ops')),
  ],
)
