import { inArray, sql, type SQL } from 'drizzle-orm'
import { normalizeLanguage, type FilterNode } from '@mylib/domain'
import {
  editionContributors,
  editions,
  userWorks,
  workContributors,
  workSeries,
  workTags,
  works,
} from '../schema'

function joinAll(parts: readonly SQL[], op: 'and' | 'or'): SQL {
  if (parts.length === 0) return op === 'and' ? sql`true` : sql`false`
  return sql`(${sql.join([...parts], op === 'and' ? sql` and ` : sql` or `)})`
}

const editionWhere = (condition: SQL) =>
  sql`exists (select 1 from ${editions} where ${editions.workId} = ${works.id} and ${condition})`
const anyEdition = () => editionWhere(sql`true`)
const ownedNow = () => editionWhere(sql`${editions.ownership} = 'owned' and ${editions.inPossession}`)
const borrowedNow = () => editionWhere(sql`${editions.ownership} = 'borrowed' and ${editions.inPossession}`)
const everOwned = () => editionWhere(sql`${editions.ownership} = 'owned'`)
const anyInPossession = () => editionWhere(sql`${editions.inPossession}`)

/**
 * Compiles a smart filter into a boolean SQL expression correlated to "work"."id".
 * Status and rating predicates are evaluated for `userId`.
 */
export function compileFilter(node: FilterNode, userId: string): SQL {
  switch (node.op) {
    case 'and':
      return joinAll(node.nodes.map((n) => compileFilter(n, userId)), 'and')
    case 'or':
      return joinAll(node.nodes.map((n) => compileFilter(n, userId)), 'or')
    case 'not':
      // coalesce: a NULL (unknown) inner result must negate to true, not NULL
      return sql`(not coalesce(${compileFilter(node.node, userId)}, false))`
    case 'format':
      return sql`exists (select 1 from ${editions} where ${editions.workId} = ${works.id} and ${inArray(editions.format, node.formats)})`
    case 'author':
      return sql`exists (select 1 from ${workContributors} where ${workContributors.workId} = ${works.id} and ${inArray(workContributors.contributorId, node.contributorIds)})`
    case 'narrator':
      return sql`exists (select 1 from ${editions} join ${editionContributors} on ${editionContributors.editionId} = ${editions.id} where ${editions.workId} = ${works.id} and ${editionContributors.role} = 'narrator' and ${inArray(editionContributors.contributorId, node.contributorIds)})`
    case 'series':
      return sql`exists (select 1 from ${workSeries} where ${workSeries.workId} = ${works.id} and ${inArray(workSeries.seriesId, node.seriesIds)})`
    case 'tag':
      return sql`exists (select 1 from ${workTags} where ${workTags.workId} = ${works.id} and ${inArray(workTags.tagId, node.tagIds)})`
    case 'language':
      return editionWhere(inArray(editions.language, node.languages.map((l) => normalizeLanguage(l) ?? l)))
    case 'status':
      return sql`coalesce((select ${userWorks.status}::text from ${userWorks} where ${userWorks.userId} = ${userId} and ${userWorks.workId} = ${works.id}), 'none') in (${sql.join(
        node.statuses.map((s) => sql`${s}`),
        sql`, `,
      )})`
    case 'rating':
      return sql`exists (select 1 from ${userWorks} where ${userWorks.userId} = ${userId} and ${userWorks.workId} = ${works.id} and ${userWorks.rating} between ${node.min} and ${node.max})`
    // Same precedence as deriveAvailability in @mylib/domain, so each work has exactly one value.
    case 'availability':
      return joinAll(
        node.values.map((value) => {
          switch (value) {
            case 'owned':
              return ownedNow()
            case 'borrowed':
              return sql`(${borrowedNow()} and not ${ownedNow()})`
            case 'formerly_owned':
              return sql`(${everOwned()} and not ${anyInPossession()})`
            case 'not_owned':
              return sql`(${anyEdition()} and not ${everOwned()} and not ${anyInPossession()})`
            case 'wanted':
              return sql`(not ${anyEdition()})`
          }
        }),
        'or',
      )
    case 'kind':
      return inArray(works.kind, node.kinds)
    case 'addedAt': {
      const parts: SQL[] = []
      if (node.from !== null) parts.push(sql`${works.createdAt} >= ${node.from}::date`)
      if (node.to !== null) parts.push(sql`${works.createdAt} < ${node.to}::date + 1`)
      return joinAll(parts, 'and')
    }
  }
}
