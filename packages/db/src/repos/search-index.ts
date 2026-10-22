import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { buildSearchDocument } from '@mylib/domain'
import type { Db } from '../client'
import {
  contributorNames,
  editionContributors,
  editions,
  seriesNames,
  tags,
  workContributors,
  workSearch,
  workSeries,
  workTags,
  workTitles,
  works,
} from '../schema'

/** Rebuilds the work's search row. Call after any change to the work, its editions or relations. */
export async function refreshSearchDocument(db: Db, workId: string): Promise<void> {
  const [work] = await db.select({ title: works.title, subtitle: works.subtitle }).from(works).where(eq(works.id, workId))
  if (!work) return
  const [authorRows, seriesRows, tagRows, editionRows, editionPeople, titleRows] = await Promise.all([
    db
      .select({ name: contributorNames.name })
      .from(workContributors)
      .innerJoin(contributorNames, eq(contributorNames.contributorId, workContributors.contributorId))
      .where(eq(workContributors.workId, workId))
      // each person in credit order, the credited spelling first, then their other names
      .orderBy(asc(workContributors.position), sql`(${contributorNames.id} = ${workContributors.nameId}) desc nulls last`, asc(contributorNames.name)),
    db
      // every name of the series, each carrying the link's position
      .select({ name: seriesNames.name, position: workSeries.position, positionEnd: workSeries.positionEnd })
      .from(workSeries)
      .innerJoin(seriesNames, eq(seriesNames.seriesId, workSeries.seriesId))
      .where(eq(workSeries.workId, workId))
      .orderBy(asc(workSeries.sortIndex), asc(seriesNames.name)),
    db
      .select({ name: tags.name })
      .from(workTags)
      .innerJoin(tags, eq(tags.id, workTags.tagId))
      .where(eq(workTags.workId, workId))
      .orderBy(asc(tags.name)),
    db
      .select({ title: editions.title, isbn13: editions.isbn13, isbn10: editions.isbn10, asin: editions.asin })
      .from(editions)
      .where(eq(editions.workId, workId))
      .orderBy(asc(editions.createdAt)),
    db
      .select({ name: contributorNames.name, role: editionContributors.role })
      .from(editionContributors)
      .innerJoin(editions, eq(editions.id, editionContributors.editionId))
      .innerJoin(contributorNames, eq(contributorNames.contributorId, editionContributors.contributorId))
      .where(eq(editions.workId, workId))
      .orderBy(asc(editionContributors.position), sql`(${contributorNames.id} = ${editionContributors.nameId}) desc nulls last`, asc(contributorNames.name)),
    db
      .select({ title: workTitles.title, subtitle: workTitles.subtitle })
      .from(workTitles)
      .where(and(eq(workTitles.workId, workId), eq(workTitles.primary, false)))
      .orderBy(asc(workTitles.language), asc(workTitles.title)),
  ])
  const doc = buildSearchDocument({
    title: work.title,
    subtitle: work.subtitle,
    series: seriesRows,
    authors: authorRows.map((r) => r.name),
    narrators: editionPeople.filter((p) => p.role === 'narrator').map((p) => p.name),
    translators: editionPeople.filter((p) => p.role === 'translator').map((p) => p.name),
    tags: tagRows.map((r) => r.name),
    otherTitles: [
      ...titleRows.flatMap((r) => (r.subtitle === null ? [r.title] : [r.title, r.subtitle])),
      ...editionRows.flatMap((e) => (e.title === null ? [] : [e.title])),
    ],
    identifiers: editionRows.flatMap((e) => [e.isbn13, e.isbn10, e.asin].filter((v): v is string => v !== null)),
  })
  await db.insert(workSearch).values({ workId, ...doc }).onConflictDoUpdate({ target: workSearch.workId, set: doc })
}

/**
 * #73: fills in the abbreviations of search rows written before they existed (acronyms is null), one work at
 * a time so a large library never holds a long transaction. Returns how many rows it refreshed.
 */
export async function backfillSearchAcronyms(db: Db): Promise<number> {
  const rows = await db.select({ workId: workSearch.workId }).from(workSearch).where(isNull(workSearch.acronyms))
  for (const row of rows) await refreshSearchDocument(db, row.workId)
  return rows.length
}
