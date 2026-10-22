import { editionFormatsForMode, volumeSets, type EditionFormat, type SessionMode } from '@mylib/domain'

interface EditionLike {
  id: string
  format: EditionFormat
  language?: string | null
  volume?: number | null
  volumeCount?: number | null
  inPossession?: boolean
}

/** The work's editions a session of this mode could be read from (listen -> audiobook; read -> physical or ebook). */
export function editionsForMode<E extends EditionLike>(editions: readonly E[], mode: SessionMode): E[] {
  const formats = editionFormatsForMode(mode)
  return editions.filter((e) => formats.includes(e.format))
}

/** The one volume set that holds every one of these editions, if there is such a set. */
export function singleVolumeSet<E extends EditionLike>(editions: readonly E[]) {
  const sets = volumeSets(editions.map((e) => ({ ...e, language: e.language ?? null, volume: e.volume ?? null, volumeCount: e.volumeCount ?? null })))
  const only = sets.length === 1 ? sets[0] : undefined
  return only !== undefined && only.members.length === editions.length ? only : undefined
}

/**
 * The edition to start with: the only matching one, else the user's pick among several; with no pick, volume 1 (in
 * possession first) when all of them are one volume set (as the server does), else none.
 */
export function resolveStartEdition(editions: readonly EditionLike[], mode: SessionMode, picked: string | null): string | null {
  const matching = editionsForMode(editions, mode)
  if (matching.length === 1) return matching[0]?.id ?? null
  if (matching.some((e) => e.id === picked)) return picked
  const only = singleVolumeSet(matching)
  if (only === undefined) return null
  const first = only.members[0]
  if (first === undefined) return null
  const lowest = only.members.filter((m) => m.volume === first.volume)
  return (lowest.find((m) => m.inPossession === true) ?? first).id
}
