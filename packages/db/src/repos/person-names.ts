import { Column, getTableName, is, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { contributorNames, contributors, editions } from '../schema'

type Language = AnyColumn | SQL | string | null

/**
 * An outer column, always written "table"."column". Drizzle prints a bare "column" for every column in a select
 * without joins, which inside our subqueries would bind to the subquery's own tables.
 */
export function outer(col: AnyColumn | SQL): SQL {
  return is(col, Column) ? sql`${sql.identifier(getTableName(col.table))}.${sql.identifier(col.name)}` : col
}

/**
 * The name a book shows for a person (spec "Display"): the name it credited; else one of the person's names in the
 * book's language, the first language given winning (an edition's, then its work's); else the primary name.
 */
export function shownName(nameIdCol: AnyColumn, contributorIdCol: AnyColumn, ...languages: Language[]): SQL<string> {
  const nameId = outer(nameIdCol)
  const contributorId = outer(contributorIdCol)
  const credited = sql`(select ${contributorNames.name} from ${contributorNames} where ${contributorNames.id} = ${nameId})`
  const inLanguage =
    languages.length === 0
      ? sql`null`
      : sql`(select ${contributorNames.name} from ${contributorNames}
          where ${contributorNames.contributorId} = ${contributorId}
            and ${contributorNames.language} in (${sql.join(languages.map((l) => sql`${l}::text`), sql`, `)})
          order by case ${sql.join(languages.map((l, i) => sql`when ${contributorNames.language} = ${l}::text then ${sql.raw(String(i))}`), sql` `)} end, ${contributorNames.name}
          limit 1)`
  const primary = sql`(select ${contributors.name} from ${contributors} where ${contributors.id} = ${contributorId})`
  return sql<string>`coalesce(${credited}, ${inLanguage}, ${primary})`
}

/** The language of the book's oldest edition that has one (#124: language lives on editions). */
export function firstEditionLanguage(workIdCol: AnyColumn | SQL): SQL<string | null> {
  const workId = outer(workIdCol)
  const fe = alias(editions, 'fe') // aliased so a caller already inside `edition` is not shadowed
  return sql<string | null>`(select ${fe.language} from ${editions} "fe"
    where ${fe.workId} = ${workId} and ${fe.language} is not null
    order by ${fe.createdAt}, ${fe.id} limit 1)`
}

/**
 * The name a book shows for one of its people (#124): the name it credited; else one of the person's names in `own`
 * (an edition's own language); else in one of the book's edition languages, oldest edition first; else the primary name.
 */
export function shownBookName(nameIdCol: AnyColumn, contributorIdCol: AnyColumn, workIdCol: AnyColumn | SQL, own: Language = null): SQL<string> {
  const nameId = outer(nameIdCol)
  const contributorId = outer(contributorIdCol)
  const workId = outer(workIdCol)
  const credited = sql`(select ${contributorNames.name} from ${contributorNames} where ${contributorNames.id} = ${nameId})`
  const inOwn =
    own === null
      ? sql`null`
      : sql`(select ${contributorNames.name} from ${contributorNames}
          where ${contributorNames.contributorId} = ${contributorId} and ${contributorNames.language} = ${own}::text
          order by ${contributorNames.name} limit 1)`
  const be = alias(editions, 'be') // aliased: `workId` may be a column of the outer `edition`
  const inBook = sql`(select ${contributorNames.name} from ${contributorNames}
      join ${editions} "be" on ${be.workId} = ${workId} and ${be.language} = ${contributorNames.language}
      where ${contributorNames.contributorId} = ${contributorId}
      order by ${be.createdAt}, ${be.id}, ${contributorNames.name} limit 1)`
  const primary = sql`(select ${contributors.name} from ${contributors} where ${contributors.id} = ${contributorId})`
  return sql<string>`coalesce(${credited}, ${inOwn}, ${inBook}, ${primary})`
}

/** A bound text[] of the person's languages (each element a parameter, never interpolated text). */
export function languageArray(languages: readonly string[]): SQL {
  return sql`array[${sql.join(languages.map((l) => sql`${l}`), sql`, `)}]::text[]`
}

/**
 * The name a book shows for one of its people at the work level (#145): one of the person's names in `languages`, the
 * first language winning; else the name the book credited; else the primary name.
 */
export function shownWorkName(nameIdCol: AnyColumn, contributorIdCol: AnyColumn, languages: readonly string[]): SQL<string> {
  const nameId = outer(nameIdCol)
  const contributorId = outer(contributorIdCol)
  const langs = languageArray(languages)
  // aliased: a caller passing contributors.id / contributor_name columns must not be shadowed by the subqueries' own tables
  const wn = alias(contributorNames, 'wn')
  const cn = alias(contributorNames, 'cn')
  const pc = alias(contributors, 'pc')
  const inLanguages = sql`(select ${wn.name} from ${contributorNames} "wn"
    where ${wn.contributorId} = ${contributorId} and ${wn.language} = any(${langs})
    order by array_position(${langs}, ${wn.language}),
      coalesce(${wn.id} = ${nameId}, false) desc,
      (${wn.normalizedName} = (select ${pc.normalizedName} from ${contributors} "pc" where ${pc.id} = ${contributorId})) desc,
      ${wn.id}
    limit 1)`
  const credited = sql`(select ${cn.name} from ${contributorNames} "cn" where ${cn.id} = ${nameId})`
  const primary = sql`(select ${pc.name} from ${contributors} "pc" where ${pc.id} = ${contributorId})`
  return sql<string>`coalesce(${inLanguages}, ${credited}, ${primary})`
}
