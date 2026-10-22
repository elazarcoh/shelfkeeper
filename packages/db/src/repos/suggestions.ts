import { and, count, eq, isNotNull, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { normalizeText } from '@mylib/domain'
import type { Db } from '../client'
import { contributorNames, editionContributors, editions, loans, series, tags, workContributors, workSeries, workTags, works } from '../schema'
import type { UserScope } from './scope'
import { shownSeriesName } from './series-names'

/** Every name a form can suggest, from the books this user can see (borrowers: from this user's own loans). */
export interface Suggestions {
  series: { id: string; name: string }[]
  contributors: string[]
  tags: string[]
  languages: string[]
  publishers: string[]
  shelfLocations: string[]
  borrowers: string[]
}

const byName = (a: string, b: string): number => a.localeCompare(b)

/**
 * Free-text columns have no lookup table, so "Tor" and "TOR" are separate values: collapse the spellings that
 * normalize alike to the most used one (ties: the one that sorts first). Blank values are dropped.
 */
export function collapseSpellings(rows: readonly { value: string; uses: number }[]): string[] {
  const uses = new Map<string, number>()
  for (const row of rows) {
    const value = row.value.trim()
    if (value !== '') uses.set(value, (uses.get(value) ?? 0) + row.uses)
  }
  const best = new Map<string, { value: string; uses: number }>()
  for (const [value, n] of uses) {
    const key = normalizeText(value)
    if (key === '') continue
    const current = best.get(key)
    if (!current || n > current.uses || (n === current.uses && byName(value, current.value) < 0)) best.set(key, { value, uses: n })
  }
  return [...best.values()].map((b) => b.value).sort(byName)
}

const names = (rows: readonly { name: string }[]): string[] => [...new Set(rows.map((r) => r.name))].sort(byName)

export async function listSuggestions(db: Db, scope: UserScope): Promise<Suggestions> {
  const editionValues = (column: AnyPgColumn) =>
    db
      .select({ value: sql<string>`${column}`, uses: count() })
      .from(editions)
      .innerJoin(works, eq(works.id, editions.workId))
      .where(and(scope.visible, isNotNull(column)))
      .groupBy(column)

  const [seriesRows, workPeople, editionPeople, tagRows, editionLanguages, publishers, shelves, borrowers] = await Promise.all([
    db
      .selectDistinct({ id: series.id, name: shownSeriesName(series.id, scope.languages) })
      .from(series)
      .innerJoin(workSeries, eq(workSeries.seriesId, series.id))
      .innerJoin(works, eq(works.id, workSeries.workId))
      .where(scope.visible),
    db
      .selectDistinct({ name: contributorNames.name })
      .from(contributorNames)
      .innerJoin(workContributors, eq(workContributors.contributorId, contributorNames.contributorId))
      .innerJoin(works, eq(works.id, workContributors.workId))
      .where(scope.visible),
    db
      .selectDistinct({ name: contributorNames.name })
      .from(contributorNames)
      .innerJoin(editionContributors, eq(editionContributors.contributorId, contributorNames.contributorId))
      .innerJoin(editions, eq(editions.id, editionContributors.editionId))
      .innerJoin(works, eq(works.id, editions.workId))
      .where(scope.visible),
    db
      .selectDistinct({ name: tags.name })
      .from(tags)
      .innerJoin(workTags, eq(workTags.tagId, tags.id))
      .innerJoin(works, eq(works.id, workTags.workId))
      .where(scope.visible),
    editionValues(editions.language),
    editionValues(editions.publisher),
    editionValues(editions.shelfLocation),
    db
      .select({ value: sql<string>`${loans.borrowerName}`, uses: count() })
      .from(loans)
      .where(and(eq(loans.lentByUserId, scope.userId), isNotNull(loans.borrowerName)))
      .groupBy(loans.borrowerName),
  ])

  return {
    series: [...seriesRows].sort((a, b) => byName(a.name, b.name)),
    contributors: names([...workPeople, ...editionPeople]),
    tags: names(tagRows),
    languages: collapseSpellings(editionLanguages),
    publishers: collapseSpellings(publishers),
    shelfLocations: collapseSpellings(shelves),
    borrowers: collapseSpellings(borrowers),
  }
}
