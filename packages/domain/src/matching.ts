import type { EditionFormat, EditionOwnership } from './enums'
import type { MatchCandidate } from './proposals'
import type { ExternalItem } from './sources'
import { normalizeText } from './text'
import { setForVolume, volumeList, volumeSets, type CandidateVolume } from './volumes'

export interface CandidateEdition {
  editionId: string
  format: EditionFormat
  isbn13: string | null
  isbn10: string | null
  asin: string | null
  ownership: EditionOwnership
  inPossession: boolean
  /** this copy was linked to an item of the same source that has since disappeared */
  formerlyFromSource: boolean
  language: string | null
  volume: number | null
  volumeCount: number | null
}

/** A linked source item of this work carries the same `identifiers.others` key and value (plan deviation 6). */
export interface SharedIdMatch {
  key: string
  /** that item's copy, if it has one */
  editionId: string | null
  format: EditionFormat | null
}

export interface CandidatePerson {
  /** every name the person goes by */
  names: string[]
}

export interface CandidateWork {
  workId: string
  authors: CandidatePerson[]
  /** 0–1, computed by the database (pg_trgm) against the work's normalized titles */
  titleSimilarity: number
  editions: CandidateEdition[]
  /** linked source items of this work that share an `identifiers.others` id with the item */
  sharedIds: SharedIdMatch[]
}

const sharedIdLabel: Record<string, string> = {
  audiobookshelfId: 'Same Audiobookshelf book',
  calibreId: 'Same Calibre book',
  readarrBookId: 'Same Readarr book',
  chaptarrBookId: 'Same Chaptarr book',
  goodreads: 'Same Goodreads id',
  google: 'Same Google Books id',
  openlibrary: 'Same Open Library id',
  hardcover: 'Same Hardcover id',
  simania: 'Same Simania book',
  nli: 'Same National Library record',
  libraryPath: 'Same files',
}

export const MIN_FUZZY_SCORE = 0.35
const TITLE_WEIGHT = 0.7
const AUTHOR_WEIGHT = 0.3
const NEUTRAL_AUTHOR_SCORE = 0.5

function identifierMatch(item: ExternalItem, e: CandidateEdition): string | null {
  const { isbn13, isbn10, asin } = item.identifiers
  if (isbn13 !== null && e.isbn13 === isbn13) return 'Same ISBN-13'
  if (isbn10 !== null && e.isbn10 === isbn10) return 'Same ISBN-10'
  if (asin !== null && e.asin === asin) return 'Same ASIN'
  return null
}

function authorScore(item: ExternalItem, work: CandidateWork): number {
  if (item.authors.length === 0) return NEUTRAL_AUTHOR_SCORE
  const people = work.authors.map((p) => new Set(p.names.map(normalizeText)))
  // each item author is one of the work's people (two spellings of one person count once) or someone else
  const named = new Set<number | string>()
  for (const author of item.authors.map(normalizeText)) {
    const i = people.findIndex((names) => names.has(author))
    named.add(i === -1 ? author : i)
  }
  const matched = [...named].filter((k) => typeof k === 'number').length
  return matched / Math.max(named.size, people.length)
}

function authorReasons(item: ExternalItem, score: number): string[] {
  if (item.authors.length === 0) return []
  if (score >= 1) return ['Same author']
  return score > 0 ? ['Some authors match'] : []
}

/** The item is a volume of this work's set (same format and language) that the set doesn't contain yet. */
function newVolume(item: ExternalItem, work: CandidateWork): CandidateVolume | null {
  if (item.volume === null) return null
  const set = setForVolume(volumeSets(work.editions.map((e) => ({ ...e, id: e.editionId }))), item.format, item.language)
  if (set === undefined) return null
  const have = [...new Set(set.members.map((m) => m.volume ?? 0))]
  return have.includes(item.volume.number) ? null : { number: item.volume.number, have, size: Math.max(set.size, item.volume.number) }
}

/** Ranks candidate books for one source item (spec §5 step 2, without the Phase 4 AI tiebreak). */
export function rankCandidates(item: ExternalItem, works: readonly CandidateWork[], limit = 5): MatchCandidate[] {
  const ranked: MatchCandidate[] = []
  for (const work of works) {
    const identified = work.editions.flatMap((e) => {
      const reason = identifierMatch(item, e)
      return reason === null ? [] : [{ e, reason }]
    })
    const volume = newVolume(item, work)
    const restorable =
      volume === null
        ? work.editions.find((e) => e.formerlyFromSource && e.format === item.format && e.ownership === 'owned' && !e.inPossession)
        : undefined
    const newVolumeReasons = volume === null ? [] : [`New volume: you have ${volumeList(volume.have)}`]
    const authors = authorScore(item, work)
    const fuzzy = Math.min(1, TITLE_WEIGHT * work.titleSimilarity + AUTHOR_WEIGHT * authors)
    const fuzzyReasons = [`Title ${Math.round(work.titleSimilarity * 100)}% similar`, ...authorReasons(item, authors)]

    if (restorable) {
      ranked.push({
        workId: work.workId,
        editionId: restorable.editionId,
        volume: null,
        score: identified.length > 0 ? 1 : fuzzy,
        basis: 'restore',
        reasons: ['Formerly owned copy from this source — restore it?', ...fuzzyReasons],
      })
    } else if (identified[0] || work.sharedIds.length > 0) {
      const sameCopy = work.sharedIds.find((s) => s.editionId !== null && s.format === item.format)
      ranked.push({
        workId: work.workId,
        editionId: volume === null ? (identified[0]?.e.editionId ?? sameCopy?.editionId ?? null) : null,
        volume,
        score: 1,
        basis: 'identifier',
        reasons: [...identified.map((m) => m.reason), ...new Set(work.sharedIds.map((s) => sharedIdLabel[s.key] ?? `Same ${s.key}`)), ...newVolumeReasons],
      })
    } else if (fuzzy >= MIN_FUZZY_SCORE) {
      ranked.push({ workId: work.workId, editionId: null, volume, score: fuzzy, basis: 'title_author', reasons: [...fuzzyReasons, ...newVolumeReasons] })
    }
  }
  const order = (c: MatchCandidate) => (c.basis === 'restore' ? 0 : 1)
  return ranked.sort((a, b) => order(a) - order(b) || b.score - a.score).slice(0, limit)
}
