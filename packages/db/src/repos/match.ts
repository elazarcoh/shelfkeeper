import { and, asc, desc, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm'
import { globalIdKeys, normalizeText, rankCandidates, type CandidatePerson, type CandidateWork, type ExternalItem, type MatchCandidate, type SharedIdMatch } from '@mylib/domain'
import type { Db } from '../client'
import { contributorNames, editions, sourceItems, workContributors, workSearch } from '../schema'

const MAX_TITLE_CANDIDATES = 10

/** One person per contributor, in the rows' order, with every name they go by. */
function peopleOf(rows: { contributorId: string; name: string }[]): CandidatePerson[] {
  const byPerson = new Map<string, string[]>()
  for (const r of rows) byPerson.set(r.contributorId, [...(byPerson.get(r.contributorId) ?? []), r.name])
  return [...byPerson.values()].map((names) => ({ names }))
}

/** Candidate books for a source item (spec §5 step 2): same identifier, then pg_trgm title similarity. */
export async function findCandidates(db: Db, sourceId: string, item: ExternalItem, limit = 5, options: { altTitles?: readonly string[] } = {}): Promise<MatchCandidate[]> {
  // the item's own title plus alternatives (e.g. an original-language title); a work scores by its best title
  const titles = [...new Set([item.title, ...(options.altTitles ?? [])].map(normalizeText).filter((t) => t !== ''))]
  // exact equality first: pg_trgm finds no trigrams in some scripts, but an identical normalized title is a match
  const similarityTo = (title: string) => sql<number>`(case when ${workSearch.titleText} = ${title} then 1
    else greatest(similarity(${workSearch.titleText}, ${title}), word_similarity(${title}, ${workSearch.titleText})) end)`
  const [only] = titles
  const similarity =
    only === undefined ? sql<number>`0` : titles.length === 1 ? similarityTo(only) : sql<number>`greatest(${sql.join(titles.map(similarityTo), sql`, `)})`

  const { isbn13, isbn10, asin } = item.identifiers
  const idConditions: SQL[] = []
  if (isbn13 !== null) idConditions.push(eq(editions.isbn13, isbn13))
  if (isbn10 !== null) idConditions.push(eq(editions.isbn10, isbn10))
  if (asin !== null) idConditions.push(eq(editions.asin, asin))

  const byIdentifier: { workId: string }[] =
    idConditions.length === 0 ? [] : await db.selectDistinct({ workId: editions.workId }).from(editions).where(or(...idConditions))
  // The %/<% operators (not the similarity()/word_similarity() functions) are what the GIN
  // gin_trgm_ops index on work_search.title_text can actually use; their thresholds are session
  // GUCs, so they're set for this transaction only (a savepoint if `db` is already a transaction).
  const byTitle: { workId: string }[] =
    titles.length === 0
      ? []
      : await db.transaction(async (tx) => {
          await tx.execute(sql`set local pg_trgm.similarity_threshold = 0.3`)
          await tx.execute(sql`set local pg_trgm.word_similarity_threshold = 0.5`)
          return tx
            .select({ workId: workSearch.workId })
            .from(workSearch)
            .where(or(...titles.map((title) => sql`(${workSearch.titleText} = ${title} or ${workSearch.titleText} % ${title} or ${title} <% ${workSearch.titleText})`)))
            .orderBy(desc(similarity))
            .limit(MAX_TITLE_CANDIDATES)
        })

  const GLOBAL_KEYS: ReadonlySet<string> = new Set(globalIdKeys)
  const pairs = Object.entries(item.identifiers.others)
  // linked items (removed or not — an id doesn't expire) of any book that share one of the item's source ids;
  // source-local keys only count within the same source (plan deviation 6)
  const sharedRows =
    pairs.length === 0
      ? []
      : await db
          .select({ workId: sourceItems.workId, editionId: sourceItems.editionId, format: editions.format, sourceId: sourceItems.sourceId, others: sql<Record<string, string>>`${sourceItems.normalized}->'identifiers'->'others'` })
          .from(sourceItems)
          .leftJoin(editions, eq(editions.id, sourceItems.editionId))
          .where(
            and(
              eq(sourceItems.state, 'linked'),
              isNotNull(sourceItems.workId),
              sql`not (${sourceItems.sourceId} = ${sourceId} and ${sourceItems.externalId} = ${item.externalId})`,
              or(
                ...pairs.map(([key, value]) => {
                  const contains = sql`(${sourceItems.normalized}->'identifiers'->'others') @> ${JSON.stringify({ [key]: value })}::jsonb`
                  return GLOBAL_KEYS.has(key) ? contains : and(contains, eq(sourceItems.sourceId, sourceId))
                }),
              ),
            ),
          )
          .limit(MAX_TITLE_CANDIDATES)
  const sharedByWork = new Map<string, SharedIdMatch[]>()
  for (const row of sharedRows) {
    if (row.workId === null) continue
    const keys = pairs.filter(([key, value]) => row.others[key] === value && (GLOBAL_KEYS.has(key) || row.sourceId === sourceId)).map(([key]) => key)
    const list = sharedByWork.get(row.workId) ?? []
    for (const key of keys) list.push({ key, editionId: row.editionId, format: row.format })
    sharedByWork.set(row.workId, list)
  }

  const ids = [...new Set([...byIdentifier.map((r) => r.workId), ...byTitle.map((r) => r.workId), ...sharedByWork.keys()])]
  if (ids.length === 0) return []

  const sims = await db.select({ workId: workSearch.workId, sim: similarity }).from(workSearch).where(inArray(workSearch.workId, ids))
  const authorRows = await db
    .select({ workId: workContributors.workId, contributorId: workContributors.contributorId, name: contributorNames.name })
    .from(workContributors)
    .innerJoin(contributorNames, eq(contributorNames.contributorId, workContributors.contributorId))
    .where(inArray(workContributors.workId, ids))
    .orderBy(asc(workContributors.position))
  const editionRows = await db
    .select({
      editionId: editions.id,
      workId: editions.workId,
      format: editions.format,
      isbn13: editions.isbn13,
      isbn10: editions.isbn10,
      asin: editions.asin,
      ownership: editions.ownership,
      inPossession: editions.inPossession,
      language: editions.language,
      volume: editions.volume,
      volumeCount: editions.volumeCount,
    })
    .from(editions)
    .where(inArray(editions.workId, ids))
  const formerRows =
    editionRows.length === 0
      ? []
      : await db
          .select({ editionId: sourceItems.editionId })
          .from(sourceItems)
          .where(
            and(
              eq(sourceItems.sourceId, sourceId),
              isNotNull(sourceItems.removedAt),
              inArray(
                sourceItems.editionId,
                editionRows.map((e) => e.editionId),
              ),
            ),
          )
  const former = new Set(formerRows.flatMap((r) => (r.editionId === null ? [] : [r.editionId])))
  const simByWork = new Map(sims.map((s) => [s.workId, s.sim]))

  const works: CandidateWork[] = ids.map((workId) => ({
    workId,
    authors: peopleOf(authorRows.filter((a) => a.workId === workId)),
    titleSimilarity: Math.min(1, simByWork.get(workId) ?? 0),
    editions: editionRows
      .filter((e) => e.workId === workId)
      .map((e) => ({
        editionId: e.editionId,
        format: e.format,
        isbn13: e.isbn13,
        isbn10: e.isbn10,
        asin: e.asin,
        ownership: e.ownership,
        inPossession: e.inPossession,
        formerlyFromSource: former.has(e.editionId),
        language: e.language,
        volume: e.volume,
        volumeCount: e.volumeCount,
      })),
    sharedIds: sharedByWork.get(workId) ?? [],
  }))
  return rankCandidates(item, works, limit)
}
