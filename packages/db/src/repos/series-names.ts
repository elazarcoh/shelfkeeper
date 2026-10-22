import { sql, type AnyColumn, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { series, seriesNames } from '../schema'
import { languageArray, outer } from './person-names'

/**
 * The name a series shows (#145): its name in the first of `languages` that has one, else the primary name (the row
 * whose normalized_name is the series'). Ties break on id, so one field's subquery always picks the same row as another's.
 */
export function shownSeriesName(seriesIdCol: AnyColumn | SQL, languages: readonly string[], field: 'name' | 'normalized_name' = 'name'): SQL<string> {
  const seriesId = outer(seriesIdCol)
  const langs = languageArray(languages)
  // aliased: the caller's own `series` (or `series_name`) is the outer table and must not be shadowed
  const sn = alias(seriesNames, 'sn')
  const ps = alias(series, 'ps')
  const col = field === 'name' ? sn.name : sn.normalizedName
  const primaryName = sql`(select ${ps.normalizedName} from ${series} "ps" where ${ps.id} = ${seriesId})`
  return sql<string>`(select ${col} from ${seriesNames} "sn"
    where ${sn.seriesId} = ${seriesId}
      and (${sn.language} = any(${langs}) or ${sn.normalizedName} = ${primaryName})
    order by array_position(${langs}, ${sn.language}) nulls last, (${sn.normalizedName} = ${primaryName}) desc, ${sn.id}
    limit 1)`
}
