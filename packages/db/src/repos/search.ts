import { sql, type SQL } from 'drizzle-orm'
import { tokenize } from '@mylib/domain'
import { workSearch } from '../schema'

export interface SearchPlan {
  /** every token matches somewhere in the document */
  match: SQL
  /** higher is better */
  score: SQL
}

const MAX_TOKENS = 8
const SHORT_TOKEN_LENGTH = 3
/** #73: a query word this long can be a whole abbreviation (twi, dcc); a shorter one never is */
const MIN_ACRONYM_LENGTH = 2
/** an exact abbreviation outranks a title that starts with the word (at most 3 + 2), not an exact title (3 + 5) */
const ACRONYM_EXACT_SCORE = sql.raw('6')
const ACRONYM_PREFIX_SCORE = sql.raw('1.5')

const paddedAcronyms = sql`(' ' || coalesce(${workSearch.acronyms}, '') || ' ')`

function acronymExact(tok: string): SQL | null {
  return tok.length < MIN_ACRONYM_LENGTH ? null : sql`${paddedAcronyms} like ${`% ${tok} %`}`
}

/** While typing: three letters or more also match the start of an abbreviation (asoi → asoiaf). */
function acronymPrefix(tok: string): SQL {
  return tok.length < SHORT_TOKEN_LENGTH ? sql`false` : sql`${paddedAcronyms} like ${`% ${tok}%`}`
}

function acronymMatch(tok: string): SQL | null {
  if (tok.length < MIN_ACRONYM_LENGTH) return null
  return tok.length < SHORT_TOKEN_LENGTH ? acronymExact(tok) : acronymPrefix(tok)
}

export function buildSearch(query: string): SearchPlan | null {
  const tokens = [...new Set(tokenize(query))].slice(0, MAX_TOKENS)
  if (tokens.length === 0) return null

  // Tokens are normalized to letters/digits, so they can never contain LIKE wildcards.
  const matches = tokens.map((tok) => {
    const words =
      tok.length < SHORT_TOKEN_LENGTH ? sql`(' ' || ${workSearch.document}) like ${`% ${tok}%`}` : sql`${tok} <% ${workSearch.document}`
    const acronym = acronymMatch(tok)
    return acronym === null ? words : sql`(${words} or ${acronym})`
  })
  const perToken = tokens.map((tok) => {
    const exact = acronymExact(tok)
    return sql`greatest(
      word_similarity(${tok}, ${workSearch.titleText}) * 3,
      word_similarity(${tok}, ${workSearch.seriesText}) * 3,
      word_similarity(${tok}, ${workSearch.authorText}) * 2,
      word_similarity(${tok}, ${workSearch.otherText})${exact === null ? sql`` : sql`,
      case when ${exact} then ${ACRONYM_EXACT_SCORE} when ${acronymPrefix(tok)} then ${ACRONYM_PREFIX_SCORE} else 0 end`})`
  })
  const phrase = tokens.join(' ')
  const titleBonus = sql`(case when ${workSearch.titleText} = ${phrase} then 5 when ${workSearch.titleText} like ${`${phrase}%`} then 2 else 0 end)`

  return {
    match: sql`(${sql.join(matches, sql` and `)})`,
    score: sql`(${sql.join(perToken, sql` + `)} + ${titleBonus})`,
  }
}
